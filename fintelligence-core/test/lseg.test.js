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
import { DatabaseSync } from 'node:sqlite';
import { guard, SqlRejected } from '../src/guard.js';
import { verify, readLog } from '../src/audit.js';
import {
    seedLseg,
    fundamentalsSnapshot,
    reconcileGrossProfit,
    reconcileStandardizedVsAsReported,
    priceCloseSeries,
    LSEG_ALLOWED_TABLES,
    LSEG_ALLOWED_COLUMNS,
} from '../src/lseg.js';

// Knowledge dates bracketing the seeded IBM.N FY2021 restatement (original known
// 2022-04-01, restated 2023-05-15), for the bitemporal (as-of) tests.
const BEFORE_RESTATEMENT = '2022-06-01';
const AFTER_RESTATEMENT = '2023-06-01';
const BEFORE_ANY_VINTAGE = '2020-01-01';

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
    assert.equal(result.organizations, 3);
    assert.equal(result.instruments, 3);
    assert.equal(result.fields, 9);
    // 32 standardized (COA) datapoints (8 fundamentals × 4 instrument-periods, with
    // TR.PriceClose now in `prices`, not `fundamentals`) + 12 as-reported
    // gross-profit-block rows + 6 bitemporal restatement rows (IBM.N FY2021 × 2).
    assert.equal(result.datapoints, 50);
    // Pricing at its own grain: 3 daily closes × 3 instruments.
    assert.equal(result.prices, 9);
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

test('the reconciliation carries per-component presence counts on complete data', () => {
    const { rows } = reconcileGrossProfit({ dbPath: DB_PATH, logPath: freshLog() });
    const r = rows[0];
    assert.equal(r.revenue_present, 1);
    assert.equal(r.cost_present, 1);
    assert.equal(r.gross_present, 1);
});

test('a missing component yields NULL (not 0) and presence 0, so absence is not a real zero', () => {
    // Seed a private db and drop the Revenue row for one period.
    const dir = mkdtempSync(join(tmpdir(), 'fintel-lsegna-'));
    const db = join(dir, 'lseg.db');
    seedLseg(db);
    const w = new DatabaseSync(db);
    // Fundamentals key on Org PermID now (IBM = 4295904307), not RIC.
    w.exec("DELETE FROM fundamentals WHERE org_permid = '4295904307' AND period = 'FY2023' AND field_code = 'TR.Revenue'");
    w.close();

    const { rows } = reconcileGrossProfit({ ric: 'IBM.N', period: 'FY2023', dbPath: db, logPath: freshLog() });
    const r = rows[0];
    assert.equal(r.revenue_present, 0, 'the Revenue field is absent');
    assert.equal(r.identity_gross_usd, null, 'NULL − cost is NULL, never a spurious 0');
    // The reported side is untouched, so it must NOT read as a zero that ties out.
    assert.equal(r.reported_gross_usd, 33_914_000_000);
});

test('fundamentals key on the stable Org PermID; RIC is a resolvable alias', () => {
    const db = new DatabaseSync(DB_PATH);
    // The fact table carries org_permid (the entity key), not ric (a quote alias).
    const cols = db.prepare('PRAGMA table_info(fundamentals)').all().map((c) => c.name);
    assert.ok(cols.includes('org_permid'), 'fundamentals should key on org_permid');
    assert.ok(!cols.includes('ric'), 'fundamentals should not carry the mutable RIC');
    // IBM's real Org PermID backs IBM.N.
    assert.equal(db.prepare('SELECT org_permid FROM instruments WHERE ric = ?').get('IBM.N').org_permid, '4295904307');
    db.close();
    // The snapshot resolves the RIC alias to the org and reads the entity's data.
    const { rows } = fundamentalsSnapshot({ ric: 'IBM.N', dbPath: DB_PATH, logPath: freshLog() });
    assert.equal(rows[0].revenue_usd, 61_860_000_000);
});

test('re-aliasing a RIC to another org follows the entity, not the ticker', () => {
    // The point of the model: fundamentals are keyed by the stable org, so if a
    // RIC is reassigned (ticker/venue change, M&A) it now resolves to whatever
    // org it points at — the RIC is just an alias.
    const dir = mkdtempSync(join(tmpdir(), 'fintel-lsegalias-'));
    const db = join(dir, 'lseg.db');
    seedLseg(db);
    const w = new DatabaseSync(db);
    w.exec("UPDATE instruments SET org_permid = '4295905573' WHERE ric = 'IBM.N'"); // point IBM.N at Apple's org
    w.close();
    const { rows } = fundamentalsSnapshot({ ric: 'IBM.N', dbPath: db, logPath: freshLog() });
    assert.equal(rows[0].revenue_usd, 383_285_000_000, 'IBM.N now resolves to Apple\'s entity-level fundamentals');
});

test('the fundamentals snapshot reads the standardized basis only (no as-reported double-count)', () => {
    // With as-reported rows at the same grain, an un-scoped sum would double the
    // gross-profit block. The snapshot must still return the standardized value.
    const { rows } = fundamentalsSnapshot({ dbPath: DB_PATH, logPath: freshLog() });
    assert.equal(rows[0].revenue_usd, 61_860_000_000);
    assert.equal(rows[0].gross_profit_usd, 33_914_000_000);
});

test('standardized vs as-reported ties when LSEG agrees with the filing', () => {
    for (const [ric, period] of [['IBM.N', 'FY2023'], ['AAPL.O', 'FY2023'], ['VOD.L', 'FY2023']]) {
        const { rows } = reconcileStandardizedVsAsReported({ ric, period, dbPath: DB_PATH, logPath: freshLog() });
        assert.equal(
            rows[0].standardized_gross_usd,
            rows[0].as_reported_gross_usd,
            `${ric} ${period}: standardized gross should tie to as-reported`,
        );
    }
});

test('standardized vs as-reported surfaces a real classification difference (IBM.N FY2022)', () => {
    const { rows } = reconcileStandardizedVsAsReported({ ric: 'IBM.N', period: 'FY2022', dbPath: DB_PATH, logPath: freshLog() });
    const r = rows[0];
    assert.equal(r.standardized_gross_usd, 33_295_000_000);
    assert.equal(r.as_reported_gross_usd, 33_795_000_000);
    assert.notEqual(r.standardized_gross_usd, r.as_reported_gross_usd, 'this is the divergence the control exists to catch');
    assert.equal(r.standardized_present, 1);
    assert.equal(r.as_reported_present, 1);
});

test('the reconciliation carries single-currency/scale/periodicity consistency counts', () => {
    const { rows } = reconcileGrossProfit({ dbPath: DB_PATH, logPath: freshLog() });
    const r = rows[0];
    assert.equal(r.currency_variants, 1);
    assert.equal(r.scale_variants, 1);
    assert.equal(r.periodicity_variants, 1);
    assert.equal(r.currency, 'USD');
});

test('a mixed-currency component makes the components incomparable (currency_variants > 1)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fintel-lsegfx-'));
    const db = join(dir, 'lseg.db');
    seedLseg(db);
    const w = new DatabaseSync(db);
    // IBM (4295904307): pretend Cost of Revenue came back in GBP, Revenue in USD.
    w.exec("UPDATE fundamentals SET currency = 'GBP' WHERE org_permid = '4295904307' AND period = 'FY2023' AND field_code = 'TR.CostOfRevenueTotal'");
    w.close();
    const { rows } = reconcileGrossProfit({ ric: 'IBM.N', period: 'FY2023', dbPath: db, logPath: freshLog() });
    assert.equal(rows[0].currency_variants, 2, 'Revenue USD + Cost GBP → two currencies');
});

test('both scenarios reproduce the same result hash', () => {
    const a = fundamentalsSnapshot({ dbPath: DB_PATH, logPath: freshLog() });
    const b = fundamentalsSnapshot({ dbPath: DB_PATH, logPath: freshLog() });
    assert.equal(a.lineage.resultHash, b.lineage.resultHash);
    const c = reconcileGrossProfit({ dbPath: DB_PATH, logPath: freshLog() });
    const d = reconcileGrossProfit({ dbPath: DB_PATH, logPath: freshLog() });
    assert.equal(c.lineage.resultHash, d.lineage.resultHash);
});

test('an as-of read returns the vintage known at that knowledge date (bitemporal, P6)', () => {
    // IBM.N FY2021 was restated: original (Rev 57.35bn / Gross 27.35bn) known
    // 2022-04-01, restated (Rev 57.90bn / Gross 27.70bn) known 2023-05-15.
    const before = fundamentalsSnapshot({ ric: 'IBM.N', period: 'FY2021', asOf: BEFORE_RESTATEMENT, dbPath: DB_PATH, logPath: freshLog() }).rows[0];
    assert.equal(before.revenue_usd, 57_350_000_000, 'before the restatement date, the original vintage');
    assert.equal(before.gross_profit_usd, 27_350_000_000);

    const after = fundamentalsSnapshot({ ric: 'IBM.N', period: 'FY2021', asOf: AFTER_RESTATEMENT, dbPath: DB_PATH, logPath: freshLog() }).rows[0];
    assert.equal(after.revenue_usd, 57_900_000_000, 'after it, the restated vintage');
    assert.equal(after.gross_profit_usd, 27_700_000_000);

    // The default read (no as-of) is the latest vintage known.
    const latest = fundamentalsSnapshot({ ric: 'IBM.N', period: 'FY2021', dbPath: DB_PATH, logPath: freshLog() }).rows[0];
    assert.equal(latest.revenue_usd, 57_900_000_000, 'default read is latest-known');
});

test('field-keyed sums pick exactly one vintage — a restatement is not double-counted (P6)', () => {
    // Both an original and a restated Revenue row exist for FY2021; a naive sum
    // over the field would add them (57.35bn + 57.90bn). The latest-vintage
    // filter must return exactly one — the restated 57.90bn — at the default read.
    const r = fundamentalsSnapshot({ ric: 'IBM.N', period: 'FY2021', dbPath: DB_PATH, logPath: freshLog() }).rows[0];
    assert.equal(r.revenue_usd, 57_900_000_000);
    assert.notEqual(r.revenue_usd, 57_350_000_000 + 57_900_000_000, 'the two vintages must not be summed');
});

test('the reconciliation ties at each vintage on the standardized identity (P6)', () => {
    const before = reconcileGrossProfit({ ric: 'IBM.N', period: 'FY2021', asOf: BEFORE_RESTATEMENT, dbPath: DB_PATH, logPath: freshLog() }).rows[0];
    assert.equal(before.identity_gross_usd, 27_350_000_000);
    assert.equal(before.identity_gross_usd, before.reported_gross_usd, 'original vintage: Revenue − Cost ties to reported gross');

    const after = reconcileGrossProfit({ ric: 'IBM.N', period: 'FY2021', dbPath: DB_PATH, logPath: freshLog() }).rows[0];
    assert.equal(after.identity_gross_usd, 27_700_000_000);
    assert.equal(after.identity_gross_usd, after.reported_gross_usd, 'restated vintage: still ties');
});

test('an as-of before any known vintage reads as N/A, not a spurious zero (P6)', () => {
    // We did not know FY2021 figures in 2020, so the honest answer is "no data",
    // surfaced as presence 0 / NULL — the same coverage discipline as a missing row.
    const r = reconcileGrossProfit({ ric: 'IBM.N', period: 'FY2021', asOf: BEFORE_ANY_VINTAGE, dbPath: DB_PATH, logPath: freshLog() }).rows[0];
    assert.equal(r.revenue_present, 0, 'nothing was known yet at this as-of');
    assert.equal(r.identity_gross_usd, null, 'absent, not a false 0');
    assert.equal(r.reported_gross_usd, null);
});

test('an as-of read reproduces its hash and a restatement is not read as tampering (P6)', () => {
    // The reproducibility guarantee (CC7.3) must survive a restatement: re-running
    // the same as-of query reproduces its hash, the restated vintage produces a
    // different hash, and both attestations land in one audit chain that verifies
    // intact — a restatement is a new knowledge-time fact, not a mutation.
    const logPath = freshLog();
    const first = reconcileGrossProfit({ ric: 'IBM.N', period: 'FY2021', asOf: BEFORE_RESTATEMENT, dbPath: DB_PATH, logPath });
    const second = reconcileGrossProfit({ ric: 'IBM.N', period: 'FY2021', asOf: BEFORE_RESTATEMENT, dbPath: DB_PATH, logPath });
    assert.equal(first.lineage.resultHash, second.lineage.resultHash, 'same as-of reproduces the same hash');

    const restated = reconcileGrossProfit({ ric: 'IBM.N', period: 'FY2021', dbPath: DB_PATH, logPath });
    assert.notEqual(first.lineage.resultHash, restated.lineage.resultHash, 'the restated vintage is a distinct figure');

    // The as-of that was pinned is recorded on the lineage; the default is not.
    assert.equal(first.lineage.asOf, BEFORE_RESTATEMENT);
    assert.equal(restated.lineage.asOf, null);

    assert.ok(verify(logPath).ok, 'the audit chain verifies intact across the restatement');
});

test('pricing lives at its own grain, keyed by the quote PermID, not in fundamentals (P7)', () => {
    // TR.PriceClose is a time series in `prices`, not a per-period fundamental.
    const db = new DatabaseSync(DB_PATH);
    const fundCols = db.prepare('PRAGMA table_info(fundamentals)').all().map((c) => c.name);
    assert.ok(!fundCols.includes('close'), 'fundamentals must not carry pricing');
    // No TR.PriceClose row ever landed in fundamentals.
    const priceInFund = db.prepare("SELECT COUNT(*) n FROM fundamentals WHERE field_code = 'TR.PriceClose'").get().n;
    assert.equal(priceInFund, 0, 'TR.PriceClose must not be a fundamental');
    // instruments now carries the stable quote PermID (the deferred P4 key).
    const instrCols = db.prepare('PRAGMA table_info(instruments)').all().map((c) => c.name);
    assert.ok(instrCols.includes('quote_permid'), 'instruments should carry the quote PermID');
    db.close();

    // The series reads through the guarded pipeline, ordered by date, ending at the
    // close previously (mis)stored as the fundamental — so nothing regressed.
    const { rows } = priceCloseSeries({ ric: 'IBM.N', dbPath: DB_PATH, logPath: freshLog() });
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map((r) => r.price_date), ['2024-03-26', '2024-03-27', '2024-03-28']);
    assert.equal(rows[rows.length - 1].close, 16_355);
    assert.equal(rows[0].currency, 'USD');
});

test('the price series honours an inclusive date range and reproduces its hash (P7)', () => {
    const a = priceCloseSeries({ ric: 'IBM.N', from: '2024-03-27', to: '2024-03-28', dbPath: DB_PATH, logPath: freshLog() });
    assert.equal(a.rows.length, 2);
    assert.equal(a.rows[0].price_date, '2024-03-27');
    const b = priceCloseSeries({ ric: 'IBM.N', from: '2024-03-27', to: '2024-03-28', dbPath: DB_PATH, logPath: freshLog() });
    assert.equal(a.lineage.resultHash, b.lineage.resultHash);
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
