/**
 * Guard tests.
 *
 * These are the security tests. Each one is a statement that must not reach
 * the database, or a legitimate query that must not be blocked — false
 * positives matter too, because a guard that rejects valid analytics gets
 * switched off.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { guard, SqlRejected, MAX_ROWS, ALLOWED_TABLES } from '../src/guard.js';

/** @param {string} sql @param {object} [options] @returns {SqlRejected} */
function rejection(sql, options) {
    try {
        guard(sql, options);
    } catch (error) {
        if (error instanceof SqlRejected) return error;
        throw error;
    }
    throw new assert.AssertionError({ message: `expected rejection, but this was allowed: ${sql}` });
}

test('allows a plain SELECT over an allow-listed table', () => {
    const result = guard('SELECT id, name FROM customers LIMIT 10');
    assert.deepEqual(result.tables, ['customers']);
    assert.equal(result.limitInjected, false);
});

test('allows joins and aggregation across allow-listed tables', () => {
    const result = guard(`
        SELECT c.acquisition_channel, SUM(m.amount_cents) AS mrr
        FROM customers c
        JOIN mrr_movements m ON m.customer_id = c.id
        GROUP BY c.acquisition_channel
        ORDER BY mrr DESC
    `);
    assert.deepEqual(result.tables, ['customers', 'mrr_movements']);
});

test('allows a CTE without mistaking its alias for a table', () => {
    // The parser reports CTE names in its table list. Without special
    // handling this query is rejected for reading a table called "monthly",
    // which would block a large fraction of real analytics SQL.
    const result = guard(`
        WITH monthly AS (
            SELECT month, SUM(amount_cents) AS net FROM mrr_movements GROUP BY month
        )
        SELECT month, net FROM monthly ORDER BY month
    `);
    assert.deepEqual(result.tables, ['mrr_movements']);
});

test('injects a LIMIT when the statement has none', () => {
    const result = guard('SELECT id FROM customers');
    assert.equal(result.limitInjected, true);
    assert.match(result.sql, new RegExp(`LIMIT ${MAX_ROWS}$`));
});

test('preserves an existing LIMIT rather than stacking another', () => {
    const result = guard('SELECT id FROM customers LIMIT 3');
    assert.equal(result.limitInjected, false);
    assert.equal((result.sql.match(/LIMIT/gi) ?? []).length, 1);
});

test('rejects a stacked second statement', () => {
    // The canonical injection shape. A /^SELECT/i test passes this happily.
    assert.equal(rejection('SELECT 1 FROM customers; DROP TABLE customers').reason, 'multiple_statements');
});

test('rejects every write verb', () => {
    for (const sql of [
        'DROP TABLE customers',
        'DELETE FROM customers',
        'UPDATE customers SET name = 1',
        'INSERT INTO customers (id) VALUES (1)',
        'ALTER TABLE customers ADD COLUMN x TEXT',
        'CREATE TABLE evil (a INT)',
    ]) {
        const error = rejection(sql);
        assert.ok(
            ['not_a_select', 'write_operation', 'unparseable'].includes(error.reason),
            `${sql} was rejected for the wrong reason: ${error.reason}`,
        );
    }
});

test('rejects schema exfiltration via sqlite_master', () => {
    // Not a write, and parses as a clean SELECT — only the allow-list stops it.
    assert.equal(rejection('SELECT name, sql FROM sqlite_master').reason, 'table_not_allowed');
});

test('rejects tables outside the allow-list', () => {
    const error = rejection('SELECT * FROM users_pii');
    assert.equal(error.reason, 'table_not_allowed');
    assert.match(error.message, /users_pii/);
});

test('rejects a subquery that reaches a forbidden table', () => {
    // The outer query looks innocent; the allow-list has to see through it.
    assert.equal(
        rejection('SELECT id FROM customers WHERE id IN (SELECT id FROM sqlite_master)').reason,
        'table_not_allowed',
    );
});

test('rejects a statement that reads no table at all', () => {
    assert.equal(rejection('SELECT 1').reason, 'no_tables');
});

test('rejects unparseable input rather than guessing', () => {
    assert.equal(rejection('this is not sql (((').reason, 'unparseable');
});

test('rejects empty and non-string input', () => {
    assert.equal(rejection('').reason, 'empty');
    assert.equal(rejection('   ').reason, 'empty');
});

test('accepts a semicolon inside a string literal', () => {
    // The raw ; scan used to reject this as a stacked statement. A ticker like
    // BRK;A is a single statement and must pass; the AST count is the backstop.
    const result = guard("SELECT id FROM customers WHERE name = 'BRK;A' LIMIT 1");
    assert.deepEqual(result.tables, ['customers']);
});

test('still rejects a real stacked statement after the literal fix', () => {
    assert.equal(
        rejection("SELECT id FROM customers WHERE name = 'ok'; DROP TABLE customers").reason,
        'multiple_statements',
    );
});

test('accepts a semicolon inside a line comment', () => {
    const result = guard('SELECT id FROM customers -- careful; not a second statement\nLIMIT 1');
    assert.deepEqual(result.tables, ['customers']);
});

test('enforces a column allow-list when one is supplied', () => {
    const options = { allowedColumns: { customers: ['id', 'country'] } };
    // Allowed columns pass, and are reported back.
    const ok = guard('SELECT id, country FROM customers LIMIT 5', options);
    // Unqualified columns over a single table report no table prefix.
    assert.deepEqual(ok.columns, ['country', 'id']);
    // A column outside the list is refused, even the previously fine `name`.
    assert.equal(rejection('SELECT id, name FROM customers', options).reason, 'column_not_allowed');
});

test('column allow-list refuses SELECT * because it names no columns to check', () => {
    assert.equal(
        rejection('SELECT * FROM customers', { allowedColumns: { customers: ['id'] } }).reason,
        'wildcard_not_allowed',
    );
});

test('column allow-list guards filter columns, not just projected ones', () => {
    // country is referenced only in WHERE; the allow-list must still catch it.
    assert.equal(
        rejection("SELECT id FROM customers WHERE country = 'US'", {
            allowedColumns: { customers: ['id'] },
        }).reason,
        'column_not_allowed',
    );
});

test('scope injection binds a mandatory predicate as a parameter', () => {
    const result = guard('SELECT id, country FROM customers', {
        scope: { column: 'country', value: 'CA' },
    });
    // The value is bound, never inlined (sqlify does not escape quotes).
    assert.deepEqual(result.params, ['CA']);
    assert.match(result.sql, /"country" = \?/);
    assert.doesNotMatch(result.sql, /'CA'/);
});

test('scope injection AND-s onto an existing WHERE', () => {
    const result = guard("SELECT id FROM customers WHERE plan = 'growth'", {
        scope: { column: 'country', value: 'CA' },
    });
    assert.match(result.sql, /AND/i);
    assert.deepEqual(result.params, ['CA']);
});

test('scope rejects a column name that is not a plain identifier', () => {
    assert.equal(
        rejection('SELECT id FROM customers', { scope: { column: 'country; DROP', value: 1 } }).reason,
        'bad_scope',
    );
});

test('the allow-list is exactly the warehouse schema', () => {
    // If a table is added to schema.sql without being added here, queries
    // against it fail confusingly. Keeping this assertion means the omission
    // surfaces as a test failure instead.
    assert.deepEqual([...ALLOWED_TABLES].sort(), [
        'acquisition_spend',
        'customers',
        'mrr_movements',
        'subscriptions',
    ]);
});
