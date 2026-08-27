/**
 * Pipeline tests.
 *
 * These run without an Anthropic credential: the planner is replaced with a
 * stub that returns whatever SQL the test wants. That is deliberate — it lets
 * the tests assert what happens when a model returns something hostile or
 * malformed, which is exactly the case you cannot reliably provoke by asking a
 * real model nicely.
 *
 * The most important assertion here is the last one: even if the guard is
 * bypassed entirely, the database still refuses to be written to.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seed, openReadOnly } from '../src/db.js';
import { ask } from '../src/ask.js';
import { verify } from '../src/audit.js';

const DB_PATH = join(mkdtempSync(join(tmpdir(), 'fintel-db-')), 'warehouse.db');
seed(DB_PATH);

/** A stand-in for the model: returns fixed SQL, records nothing. */
function stubClient(sql, interpretation = 'stubbed') {
    return {
        messages: {
            parse: async () => ({
                stop_reason: 'end_turn',
                parsed_output: { sql, interpretation },
            }),
            create: async () => ({
                stop_reason: 'end_turn',
                // Narration with no numbers is trivially grounded, keeping
                // these tests focused on the guard/execute/audit path.
                content: [{ type: 'text', text: 'Here is the shape of the result.' }],
            }),
        },
    };
}

function freshLog() {
    return join(mkdtempSync(join(tmpdir(), 'fintel-log-')), 'audit.jsonl');
}

test('a valid question runs and records lineage', async () => {
    const logPath = freshLog();
    const result = await ask('How has MRR trended?', {
        dbPath: DB_PATH,
        logPath,
        client: stubClient(
            'SELECT month, SUM(amount_cents) AS mrr_cents FROM mrr_movements GROUP BY month ORDER BY month',
        ),
    });

    assert.equal(result.ok, true);
    assert.equal(result.rows.length, 6); // 2025-06 .. 2025-11
    assert.deepEqual(result.lineage.tables, ['mrr_movements']);
    assert.deepEqual(result.lineage.columns, ['month', 'mrr_cents']);
    assert.equal(result.lineage.rowCount, 6);
    assert.equal(result.lineage.dataModified, false);
    assert.equal(result.lineage.llmScope, 'sql_generation_only');
    assert.match(result.lineage.resultHash, /^[0-9a-f]{64}$/);
    assert.ok(verify(logPath).ok);
});

test('the same question twice produces the same result hash', async () => {
    // Reproducibility is the whole point of publishing a hash: an auditor
    // re-runs the query and compares. If this drifts, the lineage record is
    // decorative.
    const sql = 'SELECT month, SUM(amount_cents) AS mrr_cents FROM mrr_movements GROUP BY month ORDER BY month';
    const first = await ask('q', { dbPath: DB_PATH, logPath: freshLog(), client: stubClient(sql) });
    const second = await ask('q', { dbPath: DB_PATH, logPath: freshLog(), client: stubClient(sql) });
    assert.equal(first.lineage.resultHash, second.lineage.resultHash);
});

test('a model that emits a write is refused at the guard', async () => {
    const logPath = freshLog();
    const result = await ask('delete everything', {
        dbPath: DB_PATH,
        logPath,
        client: stubClient('DELETE FROM customers'),
    });

    assert.equal(result.ok, false);
    assert.equal(result.stage, 'guard');
    assert.equal(result.reason, 'not_a_select');
    // A refused query must not appear in the audit log as an executed answer.
    assert.equal(verify(logPath).entries, 0);
});

test('a model that reaches for a forbidden table is refused', async () => {
    const result = await ask('what tables exist?', {
        dbPath: DB_PATH,
        logPath: freshLog(),
        client: stubClient('SELECT name FROM sqlite_master'),
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'table_not_allowed');
});

test('a model that emits garbage is refused rather than executed', async () => {
    const result = await ask('???', {
        dbPath: DB_PATH,
        logPath: freshLog(),
        client: stubClient('not sql at all ((('),
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'unparseable');
});

test('audit entries accumulate into one verifiable chain', async () => {
    const logPath = freshLog();
    const sql = 'SELECT id FROM customers LIMIT 2';
    for (const question of ['one', 'two', 'three']) {
        await ask(question, { dbPath: DB_PATH, logPath, client: stubClient(sql) });
    }
    const integrity = verify(logPath);
    assert.equal(integrity.entries, 3);
    assert.ok(integrity.ok);
});

test('the database refuses writes even with the guard bypassed', async () => {
    // The guarantee that does not depend on this codebase being correct.
    // openReadOnly() is what the query path uses; SQLite enforces it below
    // anything the guard does, so a bug in guard.js cannot cost you data.
    const db = openReadOnly(DB_PATH);
    assert.throws(
        () => db.prepare('DELETE FROM customers').run(),
        /readonly|read-only/i,
        'a write succeeded on a read-only connection',
    );
    assert.throws(() => db.exec('DROP TABLE customers'), /readonly|read-only/i);
    db.close();
});
