/**
 * Provenance hardening tests: as-of reproducibility, result signing with
 * verify-on-read, and the external anchoring hook.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seed, openReadOnly, runQuery } from '../src/db.js';
import { guard } from '../src/guard.js';
import { fingerprint } from '../src/lineage.js';
import { append, verify, readLog, exportPackage } from '../src/audit.js';
import { generateSigner } from '../src/signing.js';
import { localStubAnchor, anchorHead } from '../src/anchor.js';

const DB_PATH = join(mkdtempSync(join(tmpdir(), 'fintel-prov-')), 'warehouse.db');
seed(DB_PATH);

function freshLog() {
    return join(mkdtempSync(join(tmpdir(), 'fintel-provlog-')), 'audit.jsonl');
}

function writeEntries(path, entries) {
    writeFileSync(path, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
}

const MRR_SQL =
    'SELECT month, SUM(amount_cents) AS mrr_cents FROM mrr_movements GROUP BY month ORDER BY month';

function runAsOf(month) {
    const guarded = guard(MRR_SQL, { asOf: { column: 'month', value: month } });
    const db = openReadOnly(DB_PATH);
    try {
        const rows = runQuery(db, guarded.sql, { params: guarded.params });
        return { rows, hash: fingerprint(rows) };
    } finally {
        db.close();
    }
}

test('an as-of cutoff is a bound parameter, not inlined', () => {
    const guarded = guard(MRR_SQL, { asOf: { column: 'month', value: '2025-08' } });
    assert.deepEqual(guarded.params, ['2025-08']);
    assert.match(guarded.sql, /"month" <= \?/);
    assert.doesNotMatch(guarded.sql, /'2025-08'/);
});

test('the same question at two as-of dates yields distinct, stable hashes', () => {
    const early = runAsOf('2025-07'); // June + July only
    const late = runAsOf('2025-11'); // the full window

    // Distinct: a later cutoff admits more months.
    assert.ok(early.rows.length < late.rows.length);
    assert.notEqual(early.hash, late.hash);

    // Stable: re-running the same cutoff reproduces the same hash exactly.
    assert.equal(runAsOf('2025-07').hash, early.hash);
    assert.equal(runAsOf('2025-11').hash, late.hash);
});

test('a signed entry verifies against its key and records the key id', () => {
    const path = freshLog();
    const signer = generateSigner();
    const entry = append({ question: 'q', rowCount: 1, tables: ['customers'] }, { path, signer });

    assert.ok(entry.signature, 'entry should carry a signature');
    assert.equal(entry.signingKeyId, signer.keyId);
    assert.ok(verify(path, { verifier: { publicKey: signer.publicKey } }).ok);
});

test('signing does not disturb the hash chain', () => {
    // The signature is excluded from the hash, so a signed log verifies on the
    // chain alone, with or without a verifier.
    const path = freshLog();
    const signer = generateSigner();
    append({ question: 'a', rowCount: 1, tables: ['customers'] }, { path, signer });
    append({ question: 'b', rowCount: 2, tables: ['customers'] }, { path, signer });
    assert.ok(verify(path).ok);
});

test('a tampered signature is caught when a verifier is supplied', () => {
    const path = freshLog();
    const signer = generateSigner();
    append({ question: 'q', rowCount: 1, tables: ['customers'] }, { path, signer });

    const entries = readLog(path);
    // Replace the signature with a well-formed but wrong one; the content and
    // its hash are untouched, so only signature verification can catch this.
    entries[0].signature = Buffer.from('not the real signature').toString('base64');
    writeEntries(path, entries);

    const result = verify(path, { verifier: { publicKey: signer.publicKey } });
    assert.equal(result.ok, false);
    assert.equal(result.brokenAt, 0);
    assert.match(result.reason, /signature/);
});

test('a signature does not verify against the wrong key', () => {
    const path = freshLog();
    append({ question: 'q', rowCount: 1, tables: ['customers'] }, { path, signer: generateSigner() });
    const stranger = generateSigner();
    assert.equal(verify(path, { verifier: { publicKey: stranger.publicKey } }).ok, false);
});

test('an unsigned log still verifies clean even when a verifier is passed', () => {
    const path = freshLog();
    append({ question: 'q', rowCount: 1, tables: ['customers'] }, { path });
    assert.ok(verify(path, { verifier: { publicKey: generateSigner().publicKey } }).ok);
});

test('the anchor stub returns a deterministic receipt for a head', async () => {
    const first = await anchorHead('deadbeef', localStubAnchor());
    const second = await anchorHead('deadbeef', localStubAnchor());
    assert.equal(first.anchor, 'local-stub');
    assert.equal(first.headHash, 'deadbeef');
    assert.equal(first.ref, second.ref); // deterministic given the head
    assert.equal(await anchorHead(null, localStubAnchor()), null);
});

test('the export package embeds signing status and an anchor receipt', async () => {
    const path = freshLog();
    const signer = generateSigner();
    append({ question: 'one', rowCount: 1, tables: ['customers'] }, { path, signer });
    append({ question: 'two', rowCount: 2, tables: ['customers'] }, { path, signer });

    const receipt = await anchorHead(readLog(path).at(-1).hash, localStubAnchor());
    const pkg = exportPackage(path, { verifier: { publicKey: signer.publicKey }, anchorReceipt: receipt });

    assert.equal(pkg.signing.signedEntries, 2);
    assert.equal(pkg.signing.allSigned, true);
    assert.equal(pkg.signing.verifiedAtExport, true);
    assert.equal(pkg.anchor.ref, receipt.ref);
    assert.equal(pkg.head, readLog(path).at(-1).hash);
});
