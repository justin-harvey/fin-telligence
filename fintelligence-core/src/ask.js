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
import { QueryTimeout } from './db.js';
import { SqliteWarehouse } from './warehouse.js';
import { guard, SqlRejected } from './guard.js';
import { plan } from './planner.js';
import { narrate } from './narrator.js';
import { buildLineage } from './lineage.js';
import { append } from './audit.js';
import { loadSigner } from './signing.js';
import { scopeForPrincipal } from './auth.js';

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
 * @param {{ column: string, value: string|number }} [options.asOf] reproduce the
 *   answer as it stood at a point in time (injected as `column <= value`)
 * @param {object|null} [options.signer] key to sign the attestation; defaults to
 *   one loaded from the environment, or null when none is configured
 * @param {import('./auth.js').Principal|null} [options.principal] when supplied,
 *   the query is confined to this principal's scope (row-level security)
 * @param {{ query: Function }} [options.warehouse] connector to run the query
 *   against; defaults to the local read-only SQLite adapter
 * @returns {Promise<object>}
 */
export async function ask(question, {
    dbPath,
    logPath,
    client = new Anthropic(),
    actor = 'local',
    skipNarration = false,
    asOf = null,
    signer = loadSigner(),
    principal = null,
    warehouse = new SqliteWarehouse(dbPath),
} = {}) {
    const planned = await plan(question, { client });

    const scope = principal ? scopeForPrincipal(principal) : null;

    let guarded;
    try {
        guarded = guard(planned.sql, { asOf, scope });
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

    let rows;
    try {
        rows = warehouse.query(guarded.sql, { params: guarded.params });
    } catch (error) {
        // A query that ran past its wall-clock budget is an availability
        // outcome, distinct from a statement the warehouse refused to run.
        if (error instanceof QueryTimeout) {
            return {
                ok: false,
                stage: 'execute',
                reason: 'timeout',
                message: error.message,
                question,
                proposedSql: guarded.sql,
                interpretation: planned.interpretation,
            };
        }
        // Reaching here means the guard approved a statement the warehouse
        // would not run — a syntax quirk, an unknown column, or (importantly) a
        // write the read-only connection refused. Worth surfacing distinctly.
        return {
            ok: false,
            stage: 'execute',
            reason: 'database_rejected',
            message: error.message,
            question,
            proposedSql: guarded.sql,
            interpretation: planned.interpretation,
        };
    }

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
        asOf,
    });

    const entry = append(
        {
            ...lineage,
            narrationGrounded: narration.grounded,
            narrationAttempts: narration.attempts,
            narrationFellBack: narration.fellBack,
            ungroundedFigures: narration.verification?.ungrounded?.map((n) => n.raw) ?? [],
        },
        { path: logPath, complianceTags: ['SOX', 'GDPR: no PII'], signer },
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
        signed: Boolean(entry.signature),
        signingKeyId: entry.signingKeyId ?? null,
    };
}
