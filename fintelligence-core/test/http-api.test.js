/**
 * HTTP API tests — the engine's web surface (what the M7 proxy calls). Spins the
 * server up on an ephemeral port and exercises it over real HTTP with the
 * built-in fetch. Offline: no credential, no model, no SDK.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedEnron } from '../src/enron.js';
import { createApiServer } from '../src/http-server.js';

const TOKEN = 'test-service-token';

function listen(server) {
    return new Promise((resolve) => server.listen(0, () => resolve(`http://localhost:${server.address().port}`)));
}
function freshDb() {
    return join(mkdtempSync(join(tmpdir(), 'fintel-http-')), 'enron.db');
}
function freshLog() {
    return join(mkdtempSync(join(tmpdir(), 'fintel-httplog-')), 'audit.jsonl');
}
const bearer = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

test('GET /health is open and reports the server info', async () => {
    const server = createApiServer({ token: TOKEN });
    const base = await listen(server);
    try {
        const res = await fetch(`${base}/health`);
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.ok, true);
        assert.equal(body.name, 'fintelligence');
    } finally {
        server.close();
    }
});

test('protected routes require the bearer token', async () => {
    const server = createApiServer({ token: TOKEN });
    const base = await listen(server);
    try {
        assert.equal((await fetch(`${base}/tools`)).status, 401);
        const ok = await fetch(`${base}/tools`, { headers: bearer });
        assert.equal(ok.status, 200);
        const body = await ok.json();
        assert.ok(body.tools.some((t) => t.name === 'run_control'));
    } finally {
        server.close();
    }
});

test('POST /tools/run_control runs a control and returns the result', async () => {
    const db = freshDb();
    seedEnron(db);
    const server = createApiServer({ token: TOKEN });
    const base = await listen(server);
    try {
        const res = await fetch(`${base}/tools/run_control`, {
            method: 'POST',
            headers: bearer,
            body: JSON.stringify({ id: 'PI1.2-enron-debt-reconciliation', dbPath: db, logPath: freshLog() }),
        });
        assert.equal(res.status, 200);
        const { result } = await res.json();
        assert.equal(result.control.status, 'PASS');
        assert.match(result.provenance.resultHash, /^[0-9a-f]{64}$/);
    } finally {
        server.close();
    }
});

test('GET /resources lists resources and reads a schema resource', async () => {
    const db = freshDb();
    seedEnron(db);
    const server = createApiServer({ token: TOKEN });
    const base = await listen(server);
    try {
        const list = await (await fetch(`${base}/resources`, { headers: bearer })).json();
        assert.ok(list.resources.some((r) => r.uri === 'fintelligence://controls'));

        const controls = await (await fetch(`${base}/resources?uri=fintelligence://controls`, { headers: bearer })).json();
        assert.ok(controls.length >= 6);
    } finally {
        server.close();
    }
});

test('an unknown tool is a 400, not a crash', async () => {
    const server = createApiServer({ token: TOKEN });
    const base = await listen(server);
    try {
        const res = await fetch(`${base}/tools/nope`, { method: 'POST', headers: bearer, body: '{}' });
        assert.equal(res.status, 400);
    } finally {
        server.close();
    }
});
