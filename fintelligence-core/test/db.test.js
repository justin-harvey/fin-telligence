/**
 * Database execution tests: the wall-clock query budget and the row-level
 * scope hook running end to end against real data.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { seed, openReadOnly, runQuery, QueryTimeout } from '../src/db.js';
import { guard } from '../src/guard.js';

const DB_PATH = join(mkdtempSync(join(tmpdir(), 'fintel-dbtest-')), 'warehouse.db');
seed(DB_PATH);

test('runQuery returns plain-object rows', () => {
    const db = openReadOnly(DB_PATH);
    try {
        const rows = runQuery(db, 'SELECT id FROM customers ORDER BY id LIMIT 3');
        assert.equal(rows.length, 3);
        // Null-prototype rows from node:sqlite are normalised to plain objects.
        assert.equal(Object.getPrototypeOf(rows[0]), Object.prototype);
    } finally {
        db.close();
    }
});

test('runQuery aborts a query that streams past its budget', () => {
    // node:sqlite has no interrupt, so the budget is enforced as rows arrive.
    // A per-row busy-wait makes a small result set outlast a tiny deadline
    // deterministically, without depending on machine speed for correctness.
    const db = new DatabaseSync(':memory:');
    db.function('spin', () => {
        const started = Date.now();
        while (Date.now() - started < 3) {
            /* busy-wait ~3ms */
        }
        return 1;
    });
    const sql = `
        WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r WHERE n < 50)
        SELECT n, spin() AS s FROM r
    `;
    assert.throws(() => runQuery(db, sql, { timeoutMs: 20 }), QueryTimeout);
    db.close();
});

test('runQuery lets a cheap query finish inside the budget', () => {
    const db = openReadOnly(DB_PATH);
    try {
        const rows = runQuery(db, 'SELECT DISTINCT country FROM customers', { timeoutMs: 5000 });
        assert.ok(rows.length > 0);
    } finally {
        db.close();
    }
});

test('a scoped query returns only the principal\'s rows', () => {
    // The M1 scope hook is the foundation the auth/RLS layer stands on: the
    // predicate is injected by the guard and bound as a parameter, and the
    // result must contain nothing outside the scope.
    const guarded = guard('SELECT id, country FROM customers', {
        scope: { column: 'country', value: 'CA' },
    });
    const db = openReadOnly(DB_PATH);
    try {
        const rows = runQuery(db, guarded.sql, { params: guarded.params });
        assert.ok(rows.length > 0, 'expected some CA customers in the seed');
        assert.ok(
            rows.every((row) => row.country === 'CA'),
            'a row outside the scope leaked past the injected predicate',
        );
    } finally {
        db.close();
    }
});
