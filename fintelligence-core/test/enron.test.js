/**
 * Enron POC tests: the two reporting-gap scenarios, their reconciliation to the
 * real reported figures, reproducibility, the guard boundary on this warehouse,
 * and the tamper test on a recorded attestation.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { guard, SqlRejected } from '../src/guard.js';
import { verify, readLog } from '../src/audit.js';
import {
    seedEnron,
    revenueByBasis,
    debtWithHiddenLeverage,
    ENRON_ALLOWED_TABLES,
    ENRON_ALLOWED_COLUMNS,
} from '../src/enron.js';

const DIR = mkdtempSync(join(tmpdir(), 'fintel-enron-'));
const DB_PATH = join(DIR, 'enron.db');
seedEnron(DB_PATH);

function freshLog() {
    return join(mkdtempSync(join(tmpdir(), 'fintel-enronlog-')), 'audit.jsonl');
}

function writeEntries(path, entries) {
    writeFileSync(path, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
}

test('the enron seed is deterministic in shape', () => {
    const result = seedEnron(join(mkdtempSync(join(tmpdir(), 'fintel-enron2-')), 'w.db'));
    assert.equal(result.entities, 7);
    assert.equal(result.revenueTransactions, 10);
    assert.equal(result.debtInstruments, 10);
    assert.equal(result.reportedLineItems, 10);
});

test('FY2000 gross revenue reconciles to the reported $100,789m; net margin is far smaller', () => {
    const { rows } = revenueByBasis({ dbPath: DB_PATH, logPath: freshLog() });
    assert.equal(rows[0].revenue_gross_usd_millions, 100_789, 'gross must tie to reported total revenues');
    assert.equal(rows[0].revenue_net_usd_millions, 1_953);
    assert.ok(
        rows[0].revenue_gross_usd_millions > rows[0].revenue_net_usd_millions * 40,
        'the gross-vs-net gap is the whole point',
    );
});

test('FY1999 gross revenue reconciles to the reported $40,112m', () => {
    const { rows } = revenueByBasis({ fiscalYear: 1999, dbPath: DB_PATH, logPath: freshLog() });
    assert.equal(rows[0].revenue_gross_usd_millions, 40_112);
    assert.equal(rows[0].revenue_net_usd_millions, 802);
});

test('reported debt reconciles to $10,229m; true debt including SPEs is larger', () => {
    const { rows } = debtWithHiddenLeverage({ dbPath: DB_PATH, logPath: freshLog() });
    assert.equal(rows[0].reported_debt_usd_millions, 10_229, 'must tie to short + long-term debt on the 10-K');
    assert.equal(rows[0].total_debt_incl_spe_usd_millions, 21_729);
    assert.ok(
        rows[0].total_debt_incl_spe_usd_millions > rows[0].reported_debt_usd_millions,
        'the SPEs must add hidden leverage',
    );
});

test('both scenarios reproduce the same result hash', () => {
    const rev1 = revenueByBasis({ dbPath: DB_PATH, logPath: freshLog() });
    const rev2 = revenueByBasis({ dbPath: DB_PATH, logPath: freshLog() });
    assert.equal(rev1.lineage.resultHash, rev2.lineage.resultHash);
    const debt1 = debtWithHiddenLeverage({ dbPath: DB_PATH, logPath: freshLog() });
    const debt2 = debtWithHiddenLeverage({ dbPath: DB_PATH, logPath: freshLog() });
    assert.equal(debt1.lineage.resultHash, debt2.lineage.resultHash);
});

test('an attestation is recorded with provenance and compliance tags', () => {
    const logPath = freshLog();
    const { entry } = debtWithHiddenLeverage({ dbPath: DB_PATH, logPath });
    assert.equal(entry.scenario, 'debt_reported_vs_true');
    assert.ok(entry.complianceTags.includes('off-balance-sheet'));
    assert.match(entry.resultHash, /^[0-9a-f]{64}$/);
    assert.ok(verify(logPath).ok);
});

test('the enron allow-list refuses a query that reaches outside it', () => {
    const options = { allowedTables: ENRON_ALLOWED_TABLES, allowedColumns: ENRON_ALLOWED_COLUMNS };
    // A column that does not exist in the allow-list must be refused, even when
    // the table is allowed — the boundary is the same one the other warehouses keep.
    assert.throws(
        () => guard('SELECT secret_ceo_note FROM debt_instruments', options),
        (error) => error instanceof SqlRejected && error.reason === 'column_not_allowed',
    );
    // A table outside the warehouse is refused too.
    assert.throws(
        () => guard('SELECT * FROM sqlite_master', options),
        (error) => error instanceof SqlRejected,
    );
});

test('tampering with a historical Enron attestation is detected', () => {
    const logPath = freshLog();
    debtWithHiddenLeverage({ dbPath: DB_PATH, logPath });

    // Someone edits the recorded true-debt figure after the fact to shrink the
    // gap. It was hashed into the chain, so the edit cannot hide.
    const entries = readLog(logPath);
    entries[0].scenario = 'debt_reported_vs_true_TAMPERED';
    writeEntries(logPath, entries);

    const result = verify(logPath);
    assert.equal(result.ok, false);
    assert.equal(result.brokenAt, 0);
    assert.match(result.reason, /modified since it was written/);
});
