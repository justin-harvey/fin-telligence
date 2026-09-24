/**
 * LSEG warehouse tests: the fundamentals snapshot, the gross-profit reporting
 * identity reconciliation across instruments and periods, reproducibility, the
 * guard boundary on this warehouse, and the tamper test on a recorded attestation.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { guard, SqlRejected } from '../src/guard.js';
import { verify, readLog } from '../src/audit.js';
import {
    seedLseg,
    fundamentalsSnapshot,
    reconcileGrossProfit,
    LSEG_ALLOWED_TABLES,
    LSEG_ALLOWED_COLUMNS,
} from '../src/lseg.js';

const DIR = mkdtempSync(join(tmpdir(), 'fintel-lseg-'));
const DB_PATH = join(DIR, 'lseg.db');
seedLseg(DB_PATH);

function freshLog() {
    return join(mkdtempSync(join(tmpdir(), 'fintel-lseglog-')), 'audit.jsonl');
}

function writeEntries(path, entries) {
    writeFileSync(path, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
}

test('the lseg seed is deterministic in shape', () => {
    const result = seedLseg(join(mkdtempSync(join(tmpdir(), 'fintel-lseg2-')), 'w.db'));
    assert.equal(result.instruments, 3);
    assert.equal(result.fields, 9);
    assert.equal(result.datapoints, 36);
});

test('the IBM.N FY2023 snapshot resolves each concept to its blessed LSEG field', () => {
    const { rows } = fundamentalsSnapshot({ dbPath: DB_PATH, logPath: freshLog() });
    const r = rows[0];
    assert.equal(r.revenue_usd, 61_860_000_000);
    assert.equal(r.cost_of_revenue_usd, 27_946_000_000);
    assert.equal(r.gross_profit_usd, 33_914_000_000);
    assert.equal(r.total_debt_usd, 50_121_000_000);
});

test('gross profit reconciles to Revenue − Cost of Revenue for every instrument/period', () => {
    for (const [ric, period] of [
        ['IBM.N', 'FY2023'],
        ['IBM.N', 'FY2022'],
        ['AAPL.O', 'FY2023'],
        ['VOD.L', 'FY2023'],
    ]) {
        const { rows } = reconcileGrossProfit({ ric, period, dbPath: DB_PATH, logPath: freshLog() });
        assert.equal(
            rows[0].identity_gross_usd,
            rows[0].reported_gross_usd,
            `${ric} ${period}: Revenue − Cost of Revenue must equal reported gross profit`,
        );
    }
});

test('both scenarios reproduce the same result hash', () => {
    const a = fundamentalsSnapshot({ dbPath: DB_PATH, logPath: freshLog() });
    const b = fundamentalsSnapshot({ dbPath: DB_PATH, logPath: freshLog() });
    assert.equal(a.lineage.resultHash, b.lineage.resultHash);
    const c = reconcileGrossProfit({ dbPath: DB_PATH, logPath: freshLog() });
    const d = reconcileGrossProfit({ dbPath: DB_PATH, logPath: freshLog() });
    assert.equal(c.lineage.resultHash, d.lineage.resultHash);
});

test('an attestation is recorded with provenance and compliance tags', () => {
    const logPath = freshLog();
    const { entry } = reconcileGrossProfit({ dbPath: DB_PATH, logPath });
    assert.equal(entry.scenario, 'lseg_gross_profit_reconciliation');
    assert.ok(entry.complianceTags.includes('reconciliation'));
    assert.match(entry.resultHash, /^[0-9a-f]{64}$/);
    assert.ok(verify(logPath).ok);
});

test('the lseg allow-list refuses a query that reaches outside it', () => {
    const options = { allowedTables: LSEG_ALLOWED_TABLES, allowedColumns: LSEG_ALLOWED_COLUMNS };
    assert.throws(
        () => guard('SELECT insider_note FROM fundamentals', options),
        (error) => error instanceof SqlRejected && error.reason === 'column_not_allowed',
    );
    assert.throws(
        () => guard('SELECT * FROM sqlite_master', options),
        (error) => error instanceof SqlRejected,
    );
});

test('tampering with a historical LSEG attestation is detected', () => {
    const logPath = freshLog();
    reconcileGrossProfit({ dbPath: DB_PATH, logPath });

    const entries = readLog(logPath);
    entries[0].scenario = 'lseg_gross_profit_reconciliation_TAMPERED';
    writeEntries(logPath, entries);

    const result = verify(logPath);
    assert.equal(result.ok, false);
    assert.equal(result.brokenAt, 0);
    assert.match(result.reason, /modified since it was written/);
});
