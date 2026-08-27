/**
 * The pipeline.
 *
 *   question
 *      -> plan      model writes SQL, having seen no data
 *      -> guard     parse, SELECT-only, allow-list, LIMIT      [rejects here]
 *      -> execute   read-only connection                        [rejects here]
 *      -> narrate   prose, every figure verified against rows
 *      -> lineage   SQL, tables, columns, row count, result hash
 *      -> audit     appended to the hash-chained log
 *
 * Each stage can refuse, and a refusal is a normal outcome rather than an
 * error: a rejected query is the system working. What must never happen is a
 * returned answer whose figures were not checked.
 */

import Anthropic from '@anthropic-ai/sdk';
import { openReadOnly } from './db.js';
import { guard, SqlRejected } from './guard.js';
import { plan } from './planner.js';
import { narrate } from './narrator.js';
import { buildLineage } from './lineage.js';
import { append } from './audit.js';

/**
 * Answer one question end to end.
 *
 * @param {string} question
 * @param {object} [options]
 * @param {string} [options.dbPath]
 * @param {string} [options.logPath]
 * @param {Anthropic} [options.client]
 * @param {string} [options.actor]
 * @param {boolean} [options.skipNarration] execute and record, but do not narrate
 * @returns {Promise<object>}
 */
export async function ask(question, {
    dbPath,
    logPath,
    client = new Anthropic(),
    actor = 'local',
    skipNarration = false,
} = {}) {
    const planned = await plan(question, { client });

    let guarded;
    try {
        guarded = guard(planned.sql);
    } catch (error) {
        if (error instanceof SqlRejected) {
            return {
                ok: false,
                stage: 'guard',
                reason: error.reason,
                message: error.message,
                question,
                proposedSql: planned.sql,
                interpretation: planned.interpretation,
            };
        }
        throw error;
    }

    const db = openReadOnly(dbPath);
    let rows;
    try {
        rows = db.prepare(guarded.sql).all();
    } catch (error) {
        // Reaching here means the guard approved a statement SQLite would not
        // run — a syntax quirk, an unknown column, or (importantly) a write
        // the read-only connection refused. Worth surfacing distinctly.
        return {
            ok: false,
            stage: 'execute',
            reason: 'database_rejected',
            message: error.message,
            question,
            proposedSql: guarded.sql,
            interpretation: planned.interpretation,
        };
    } finally {
        db.close();
    }

    // node:sqlite returns null-prototype objects; normalise so downstream
    // JSON serialisation and key enumeration behave predictably.
    rows = rows.map((row) => ({ ...row }));

    const narration = skipNarration
        ? { text: '', grounded: true, attempts: 0, verification: null, fellBack: false }
        : await narrate({ question, rows, sql: guarded.sql, client });

    const lineage = buildLineage({
        question,
        sql: guarded.sql,
        tables: guarded.tables,
        rows,
        limitInjected: guarded.limitInjected,
        model: planned.model,
        actor,
    });

    const entry = append(
        {
            ...lineage,
            narrationGrounded: narration.grounded,
            narrationAttempts: narration.attempts,
            narrationFellBack: narration.fellBack,
            ungroundedFigures: narration.verification?.ungrounded?.map((n) => n.raw) ?? [],
        },
        { path: logPath, complianceTags: ['SOX', 'GDPR: no PII'] },
    );

    return {
        ok: true,
        question,
        interpretation: planned.interpretation,
        sql: guarded.sql,
        limitInjected: guarded.limitInjected,
        rows,
        answer: narration.text,
        grounded: narration.grounded,
        verifiedFigures: narration.verification?.grounded?.length ?? 0,
        fellBack: narration.fellBack,
        lineage,
        auditSeq: entry.seq,
        auditHash: entry.hash,
    };
}
