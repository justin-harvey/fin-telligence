/**
 * Evidence-packet tests (M8): the control-result shape, deterministic CSV, and a
 * packet that verifies offline — with tamper and signature paths proving the
 * verification actually bites.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedEnron, debtWithHiddenLeverage } from '../src/enron.js';
import { generateSigner } from '../src/signing.js';
import {
    controlResult,
    CONTROL_STATUS,
    rowsToCsv,
    generateCompliancePacket,
    verifyPacket,
    renderPacketMarkdown,
} from '../src/evidence.js';

const DIR = mkdtempSync(join(tmpdir(), 'fintel-evi-'));
const DB = join(DIR, 'enron.db');
seedEnron(DB);

function freshLog() {
    return join(mkdtempSync(join(tmpdir(), 'fintel-evilog-')), 'audit.jsonl');
}

function buildControl(rows) {
    const r = rows[0];
    return controlResult({
        controlId: 'PI1.2',
        criterion: 'Processing Integrity',
        description: 'FY2000 reported debt vs true debt including off-balance-sheet SPEs.',
        status: CONTROL_STATUS.PASS,
        figures: [
            { label: 'Reported debt', value: r.reported_debt_usd_millions, unit: 'usd_millions' },
            { label: 'True debt incl. SPEs', value: r.total_debt_incl_spe_usd_millions, unit: 'usd_millions' },
        ],
    });
}

test('controlResult rejects a bad status and requires a reason for exceptions', () => {
    assert.throws(() => controlResult({ status: 'MAYBE' }));
    assert.throws(() => controlResult({ status: CONTROL_STATUS.EXCEPTION }));
    const ex = controlResult({ status: CONTROL_STATUS.EXCEPTION, exception: 'variance of $12m vs anchor' });
    assert.equal(ex.status, 'EXCEPTION');
    assert.equal(ex.exception, 'variance of $12m vs anchor');
});

test('rowsToCsv is deterministic (sorted columns) and RFC-4180 quoted', () => {
    const csv = rowsToCsv([{ b: 'x,y', a: 2 }, { a: 3, b: 'he said "hi"' }]);
    assert.equal(csv, 'a,b\n2,"x,y"\n3,"he said ""hi"""');
    assert.equal(rowsToCsv([]), '');
});

test('a packet built from a real attestation verifies offline', () => {
    const { rows, entry } = debtWithHiddenLeverage({ dbPath: DB, logPath: freshLog() });
    const packet = generateCompliancePacket({
        control: buildControl(rows),
        entry,
        rows,
        generatedAt: '2026-09-14T00:00:00.000Z',
    });
    const v = verifyPacket(packet);
    assert.equal(v.ok, true);
    assert.equal(v.checks.entryHashValid, true);
    assert.equal(v.checks.resultHashMatchesRows, true);
    assert.equal(v.checks.csvMatchesRows, true);
    assert.equal(v.checks.intentMatchesRecord, true);
    assert.equal(v.checks.signatureValid, null); // unsigned is not a failure
});

test('editing a figure in the packet breaks verification', () => {
    const { rows, entry } = debtWithHiddenLeverage({ dbPath: DB, logPath: freshLog() });
    const packet = generateCompliancePacket({ control: buildControl(rows), entry, rows });
    packet.evidence.rows[0].reported_debt_usd_millions = 9_999; // quietly shrink the reported figure
    const v = verifyPacket(packet);
    assert.equal(v.ok, false);
    assert.equal(v.checks.resultHashMatchesRows, false);
});

test('editing the embedded audit entry is detected', () => {
    const { rows, entry } = debtWithHiddenLeverage({ dbPath: DB, logPath: freshLog() });
    const packet = generateCompliancePacket({ control: buildControl(rows), entry, rows });
    packet.provenance.audit.question = 'a different question';
    const v = verifyPacket(packet);
    assert.equal(v.ok, false);
    assert.equal(v.checks.entryHashValid, false);
});

test('a signed packet verifies with the right key and fails with the wrong one', () => {
    const signer = generateSigner();
    const { rows, entry } = debtWithHiddenLeverage({ dbPath: DB, logPath: freshLog(), signer });
    assert.ok(entry.signature, 'the entry should be signed when a signer is supplied');

    const packet = generateCompliancePacket({ control: buildControl(rows), entry, rows, publicKey: signer.publicKey });
    // No key passed → uses the embedded public key.
    assert.equal(verifyPacket(packet).ok, true);
    assert.equal(verifyPacket(packet).checks.signatureValid, true);

    const other = generateSigner();
    const bad = verifyPacket(packet, { publicKey: other.publicKey });
    assert.equal(bad.checks.signatureValid, false);
    assert.equal(bad.ok, false);
});

test('renderPacketMarkdown carries the side-by-side chain and a self-check', () => {
    const { rows, entry } = debtWithHiddenLeverage({ dbPath: DB, logPath: freshLog() });
    const md = renderPacketMarkdown(
        generateCompliancePacket({ control: buildControl(rows), entry, rows, generatedAt: '2026-09-14T00:00:00.000Z' }),
    );
    assert.match(md, /Validated SQL/);
    assert.match(md, /Result hash/);
    assert.match(md, /Reported debt/);
    assert.match(md, /VERIFIED/);
});
