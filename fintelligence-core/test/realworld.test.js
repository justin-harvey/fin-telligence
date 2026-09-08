/**
 * Real-world surface tests: the metric registry, the warehouse connector
 * abstraction, authentication, and row-level security enforced end to end.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seed } from '../src/db.js';
import { ask } from '../src/ask.js';
import { SqliteWarehouse, SnowflakeWarehouse } from '../src/warehouse.js';
import { MetricRegistry, UnknownMetric, marketsRegistry } from '../src/registry.js';
import { authenticate, scopeForPrincipal, demoPrincipals, AuthError } from '../src/auth.js';
import { seedMarkets, netPositionAtClose } from '../src/markets.js';

const SAAS_DB = join(mkdtempSync(join(tmpdir(), 'fintel-rw-saas-')), 'warehouse.db');
seed(SAAS_DB);
const MARKETS_DB = join(mkdtempSync(join(tmpdir(), 'fintel-rw-mkt-')), 'markets.db');
seedMarkets(MARKETS_DB);

function freshLog() {
    return join(mkdtempSync(join(tmpdir(), 'fintel-rw-log-')), 'audit.jsonl');
}

function stubClient(sql) {
    return {
        messages: {
            parse: async () => ({ stop_reason: 'end_turn', parsed_output: { sql, interpretation: 'stub' } }),
            create: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'No figures here.' }] }),
        },
    };
}

// ── Metric registry ─────────────────────────────────────────────────────────

test('the registry resolves a known metric and lists definitions', () => {
    const registry = marketsRegistry();
    assert.ok(registry.has('net_position'));
    assert.match(registry.resolve('net_position').sql, /SUM\(CASE WHEN side/);
    assert.equal(registry.list().length, 3);
    assert.match(registry.promptFragment(), /net_position —/);
});

test('an unknown metric is a surfaced error, not an invented fragment', () => {
    assert.throws(() => marketsRegistry().resolve('sharpe_ratio'), UnknownMetric);
});

test('the registry rejects a definition with no sql', () => {
    assert.throws(() => new MetricRegistry().define('bad', { description: 'x' }), /needs an sql/);
});

// ── Warehouse connector ─────────────────────────────────────────────────────

test('the SQLite adapter satisfies the connector contract', () => {
    const warehouse = new SqliteWarehouse(SAAS_DB);
    const rows = warehouse.query('SELECT id FROM customers ORDER BY id LIMIT 2');
    assert.equal(rows.length, 2);
    assert.equal(warehouse.dialect, 'sqlite');
});

test('the Snowflake adapter defines the shape and fails usefully', () => {
    const warehouse = new SnowflakeWarehouse({ account: 'x' });
    assert.equal(warehouse.dialect, 'snowflake');
    assert.throws(() => warehouse.query('SELECT 1'), /read-only.*bounded contract|interface shape/s);
});

// ── Authentication ──────────────────────────────────────────────────────────

test('authentication resolves a known token and refuses others', () => {
    const registry = demoPrincipals();
    assert.equal(authenticate('trader-acct-1', registry).id, 'alice');
    assert.throws(() => authenticate('forged', registry), AuthError);
    assert.throws(() => authenticate('', registry), AuthError);
});

test('scope derivation confines a trader and frees a supervisor', () => {
    const registry = demoPrincipals();
    assert.deepEqual(scopeForPrincipal(authenticate('trader-acct-1', registry)), { column: 'account_id', value: 1 });
    assert.equal(scopeForPrincipal(authenticate('surveillance-lead', registry)), null);
});

test('a principal with neither privilege nor scope is refused, not defaulted open', () => {
    assert.throws(() => scopeForPrincipal({ id: 'nobody', roles: ['trader'], scope: null }), AuthError);
});

// ── Row-level security, enforced end to end ─────────────────────────────────

test('a trader sees only their own book', () => {
    const trader = authenticate('trader-acct-1', demoPrincipals());
    const { rows } = netPositionAtClose({ ticker: 'ACME', dbPath: MARKETS_DB, logPath: freshLog(), principal: trader });
    assert.ok(rows.length > 0);
    assert.ok(rows.every((row) => row.account_id === 1), 'RLS leaked another account into the result');
});

test('a supervisor sees the whole book', () => {
    const supervisor = authenticate('surveillance-lead', demoPrincipals());
    const scoped = netPositionAtClose({ ticker: 'ACME', dbPath: MARKETS_DB, logPath: freshLog(), principal: supervisor });
    const unscoped = netPositionAtClose({ ticker: 'ACME', dbPath: MARKETS_DB, logPath: freshLog() });
    assert.equal(scoped.rows.length, unscoped.rows.length);
    assert.ok(scoped.rows.length > 1);
});

test('the ask pipeline enforces a principal scope through an injected warehouse', async () => {
    // Exercises the ask() path: principal -> scope -> guard -> warehouse.
    const result = await ask('where are my customers?', {
        dbPath: SAAS_DB,
        logPath: freshLog(),
        client: stubClient('SELECT id, country FROM customers'),
        principal: { id: 'ca-desk', roles: ['trader'], scope: { column: 'country', value: 'CA' } },
    });
    assert.equal(result.ok, true);
    assert.ok(result.rows.length > 0);
    assert.ok(result.rows.every((row) => row.country === 'CA'), 'scope did not confine the ask() result');
});
