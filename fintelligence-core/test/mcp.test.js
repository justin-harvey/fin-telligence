/**
 * MCP handler tests — the tool and resource surface, exercised offline with no
 * SDK and no running server (the transport in mcp-server.js is the only thing
 * that needs the dependency). Covers a schema-resource read, the control tools,
 * a canonical query, audit verification, and the free-text tool's warehouse gate.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedEnron } from '../src/enron.js';
import { listTools, callTool, listResources, readResource } from '../src/mcp.js';
import { warehouseSchema } from '../src/warehouses.js';

function freshDb(tag) {
    return join(mkdtempSync(join(tmpdir(), `fintel-mcp-${tag}-`)), 'enron.db');
}
function freshLog() {
    return join(mkdtempSync(join(tmpdir(), 'fintel-mcplog-')), 'audit.jsonl');
}

test('listTools advertises the engine surface', () => {
    const names = listTools().map((t) => t.name);
    for (const expected of ['list_controls', 'run_control', 'run_canonical', 'verify_audit', 'execute_financial_query']) {
        assert.ok(names.includes(expected), `missing tool ${expected}`);
    }
    // Every tool must carry an input schema an MCP client can validate against.
    for (const tool of listTools()) assert.equal(tool.inputSchema.type, 'object');
});

test('listResources exposes warehouses, controls, and a schema resource per warehouse', () => {
    const uris = listResources().map((r) => r.uri);
    assert.ok(uris.includes('fintelligence://warehouses'));
    assert.ok(uris.includes('fintelligence://controls'));
    for (const w of ['saas', 'markets', 'enron']) {
        assert.ok(uris.includes(`fintelligence://schema/${w}`), `missing schema resource for ${w}`);
    }
});

test('the warehouses resource marks which support free text', () => {
    const warehouses = readResource('fintelligence://warehouses');
    const saas = warehouses.find((w) => w.name === 'saas');
    const enron = warehouses.find((w) => w.name === 'enron');
    assert.equal(saas.freeText, true);
    assert.equal(enron.freeText, false);
});

test('a schema resource reflects the live, allow-listed table shape', () => {
    const db = freshDb('schema');
    seedEnron(db);
    const schema = warehouseSchema('enron', { dbPath: db });
    const tableNames = schema.tables.map((t) => t.table);
    assert.ok(tableNames.includes('debt_instruments'));
    assert.ok(tableNames.includes('reported_financials'));
    const debtCols = schema.tables.find((t) => t.table === 'debt_instruments').columns.map((c) => c.name);
    assert.ok(debtCols.includes('principal_usd_millions'));
    assert.ok(debtCols.includes('on_balance_sheet'));
});

test('list_controls returns the catalog and run_control asserts a status', async () => {
    const controls = await callTool('list_controls');
    assert.ok(controls.length >= 3);

    const db = freshDb('run');
    seedEnron(db);
    const result = await callTool('run_control', {
        id: 'PI1.2-enron-debt-reconciliation',
        dbPath: db,
        logPath: freshLog(),
    });
    assert.equal(result.control.status, 'PASS');
    assert.match(result.provenance.resultHash, /^[0-9a-f]{64}$/);
    assert.equal(result.exportable, true);
});

test('run_canonical runs a credential-free query, and verify_audit checks its log', async () => {
    const db = freshDb('canon');
    const logPath = freshLog();
    seedEnron(db);
    const result = await callTool('run_canonical', { name: 'enron/debt', args: { dbPath: db, logPath } });
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].reported_debt_usd_millions, 10_229);

    const integrity = await callTool('verify_audit', { logPath });
    assert.equal(integrity.ok, true);
    assert.equal(integrity.entries, 1);
});

test('run_canonical rejects an unknown query name', async () => {
    await assert.rejects(() => callTool('run_canonical', { name: 'enron/nonsense' }));
});

test('execute_financial_query refuses a non-SaaS warehouse without calling a model', async () => {
    const out = await callTool('execute_financial_query', { question: 'net position?', warehouse: 'markets' });
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'warehouse_not_supported');
});
