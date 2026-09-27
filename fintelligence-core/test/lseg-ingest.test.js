/**
 * LSEG ingest-seam tests: the whole ingest path runs against a fake session
 * (no entitlement), ingested data flows through the guarded/grounded pipeline
 * and reconciles, unknown field codes are refused with a pointer to lseg-mcp,
 * and the real-session stub fails loudly so the seam is honest.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { seedLseg, reconcileGrossProfit, priceCloseSeries } from '../src/lseg.js';
import {
    FakeLsegSession,
    RealLsegSession,
    ingestFundamentals,
    ingestPrices,
    DEFAULT_FIXTURE,
} from '../src/lseg-ingest.js';

// Fundamentals only — TR.PriceClose is a Pricing time series (finding #6) and is
// ingested via the history path, not ingestFundamentals.
const FIELDS = [
    'TR.Revenue',
    'TR.CostOfRevenueTotal',
    'TR.GrossProfit',
    'TR.OperatingIncome',
    'TR.NetIncomeAfterTaxes',
    'TR.TotalDebtOutstanding',
    'TR.TotalAssetsReported',
    'TR.CompanyMarketCap',
];

function freshDb() {
    const dir = mkdtempSync(join(tmpdir(), 'fintel-lsegingest-'));
    const db = join(dir, 'lseg.db');
    seedLseg(db);
    return db;
}

test('a fake session lands a new period, and the ingested data reconciles', () => {
    const db = freshDb();
    const result = ingestFundamentals({
        session: new FakeLsegSession(),
        universe: ['IBM.N'],
        fields: FIELDS,
        period: 'FY2024',
        dbPath: db,
        source: 'FakeLsegSession (test)',
        retrievedAt: '2025-01-15',
    });
    assert.equal(result.instruments, 1);
    assert.equal(result.datapoints, FIELDS.length);

    // The freshly ingested period flows through the guarded, grounded pipeline
    // and satisfies the same gross-profit identity — a credential swap away from
    // real LSEG data doing the same.
    const { rows } = reconcileGrossProfit({ ric: 'IBM.N', period: 'FY2024', dbPath: db, logPath: join(mkdtempSync(join(tmpdir(), 'l-')), 'a.jsonl') });
    assert.equal(rows[0].identity_gross_usd, rows[0].reported_gross_usd);
    assert.equal(rows[0].reported_gross_usd, DEFAULT_FIXTURE['IBM.N'].FY2024['TR.GrossProfit']);
});

test('ingest refuses an unknown field code and points at lseg-mcp', () => {
    const db = freshDb();
    assert.throws(
        () =>
            ingestFundamentals({
                session: new FakeLsegSession({ 'IBM.N': { FY2024: { 'TR.MadeUpField': 1 } } }),
                universe: ['IBM.N'],
                fields: ['TR.MadeUpField'],
                period: 'FY2024',
                dbPath: db,
            }),
        (error) => /Unknown LSEG field code/.test(error.message) && /lseg-mcp/.test(error.message),
    );
});

test('ingest upserts an unseen instrument (a new RIC can be introduced)', () => {
    const db = freshDb();
    const fixture = {
        'MSFT.O': {
            FY2024: {
                'TR.Revenue': 245_122_000_000,
                'TR.CostOfRevenueTotal': 74_114_000_000,
                'TR.GrossProfit': 171_008_000_000, // 245,122,000,000 − 74,114,000,000
            },
        },
    };
    const result = ingestFundamentals({
        session: new FakeLsegSession(fixture),
        universe: ['MSFT.O'],
        fields: ['TR.Revenue', 'TR.CostOfRevenueTotal', 'TR.GrossProfit'],
        period: 'FY2024',
        dbPath: db,
    });
    assert.equal(result.instruments, 1);
    assert.equal(result.datapoints, 3);
    const { rows } = reconcileGrossProfit({ ric: 'MSFT.O', period: 'FY2024', dbPath: db, logPath: join(mkdtempSync(join(tmpdir(), 'l-')), 'a.jsonl') });
    assert.equal(rows[0].identity_gross_usd, rows[0].reported_gross_usd);
});

test('re-running an ingest is a no-op, not a double count (P9)', () => {
    const db = freshDb();
    const batch = {
        session: new FakeLsegSession(),
        universe: ['IBM.N'],
        fields: FIELDS,
        period: 'FY2024',
        dbPath: db,
        source: 'FakeLsegSession (test)',
        retrievedAt: '2025-01-15',
    };
    const first = ingestFundamentals(batch);
    const second = ingestFundamentals(batch);
    assert.equal(first.datapoints, FIELDS.length);
    assert.equal(second.datapoints, 0, 'nothing new lands on a re-run');
    assert.equal(second.skipped, FIELDS.length, 'every datapoint is recognised as already held');

    // Before P9 the second run landed a duplicate of every row: each field-keyed
    // sum doubled, and the identity still tied, so the integrity control PASSED
    // on doubled figures. Now each component is one row at its true value.
    const { rows } = reconcileGrossProfit({ ric: 'IBM.N', period: 'FY2024', dbPath: db, logPath: join(mkdtempSync(join(tmpdir(), 'l-')), 'a.jsonl') });
    assert.equal(rows[0].revenue_present, 1);
    assert.equal(rows[0].reported_gross_usd, DEFAULT_FIXTURE['IBM.N'].FY2024['TR.GrossProfit']);
});

test('a changed figure at the same vintage is refused, and the whole batch rolls back (P9)', () => {
    const db = freshDb();
    const at = { universe: ['IBM.N'], period: 'FY2024', dbPath: db, retrievedAt: '2025-01-15' };
    ingestFundamentals({ ...at, session: new FakeLsegSession(), fields: ['TR.Revenue'] });

    // Same knowledge date, different Revenue. OperatingIncome is new to the
    // warehouse and is written first, so the refusal must also undo it.
    const changed = { 'IBM.N': { FY2024: { ...DEFAULT_FIXTURE['IBM.N'].FY2024, 'TR.Revenue': 62_000_000_000 } } };
    assert.throws(
        () => ingestFundamentals({ ...at, session: new FakeLsegSession(changed), fields: ['TR.OperatingIncome', 'TR.Revenue'] }),
        (error) => /Conflicting LSEG value/.test(error.message) && /later knowledge_date/.test(error.message),
    );

    const w = new DatabaseSync(db);
    const held = (code) =>
        w.prepare("SELECT value FROM fundamentals WHERE org_permid = '4295904307' AND period = 'FY2024' AND field_code = ?").all(code);
    assert.deepEqual(held('TR.Revenue').map((r) => r.value), [DEFAULT_FIXTURE['IBM.N'].FY2024['TR.Revenue']], 'the held vintage is untouched');
    assert.equal(held('TR.OperatingIncome').length, 0, 'nothing from the refused batch was written');
    w.close();
});

test('the warehouse itself refuses a second row for the same vintage (P9)', () => {
    // Defence in depth: the vintage key is a UNIQUE index, so a writer that
    // bypasses ingestFundamentals (a seed bug, a hand-run INSERT) is refused too.
    const db = freshDb();
    const w = new DatabaseSync(db);
    assert.throws(
        () =>
            w.exec(
                'INSERT INTO fundamentals (org_permid, field_code, period, value, currency, basis, scale, periodicity, reporting_state, knowledge_date, retrieved_at, source) ' +
                    'SELECT org_permid, field_code, period, value, currency, basis, scale, periodicity, reporting_state, knowledge_date, retrieved_at, source ' +
                    "FROM fundamentals WHERE org_permid = '4295904307' AND period = 'FY2023' AND field_code = 'TR.Revenue' AND basis = 'standardized'",
            ),
        /UNIQUE constraint failed/,
    );
    w.close();
});

test('ingest refuses a value that is not a whole number in its unit, and lands nothing', () => {
    const db = freshDb();
    // A float and a numeric string: what a Scale/unit mismatch or a stringified
    // numpy scalar looks like. GrossProfit is valid and lands first, so the
    // refusal must roll it back too.
    for (const bad of [62_753_000_000.5, '62753000000']) {
        const fixture = { 'IBM.N': { FY2024: { 'TR.GrossProfit': 34_653_000_000, 'TR.Revenue': bad } } };
        assert.throws(
            () => ingestFundamentals({ session: new FakeLsegSession(fixture), universe: ['IBM.N'], fields: ['TR.GrossProfit', 'TR.Revenue'], period: 'FY2024', dbPath: db }),
            (error) => /not a whole number of usd/.test(error.message),
        );
    }
    const w = new DatabaseSync(db);
    assert.equal(w.prepare("SELECT COUNT(*) n FROM fundamentals WHERE period = 'FY2024'").get().n, 0);
    w.close();
});

test('ingest refuses a row that names no instrument instead of silently skipping it', () => {
    const db = freshDb();
    const session = { getData: () => [{ period: 'FY2024', 'TR.Revenue': 1 }] };
    assert.throws(
        () => ingestFundamentals({ session, universe: ['IBM.N'], fields: ['TR.Revenue'], period: 'FY2024', dbPath: db }),
        (error) => /no Instrument/.test(error.message),
    );
});

test('ingestPrices refuses a major-unit float close rather than landing it 100× off', () => {
    const db = freshDb();
    // get_history returns closes in major units (223.05), but prices stores
    // usd_cents. The first, well-formed day must not survive the refusal either.
    const series = { 'IBM.N': [{ date: '2024-04-01', 'TR.PriceClose': 22_140 }, { date: '2024-04-02', 'TR.PriceClose': 223.05 }] };
    assert.throws(
        () => ingestPrices({ session: new FakeLsegSession(undefined, series), universe: ['IBM.N'], fields: ['TR.PriceClose'], dbPath: db }),
        (error) => /not a whole number of usd_cents/.test(error.message),
    );
    const w = new DatabaseSync(db);
    assert.equal(w.prepare("SELECT COUNT(*) n FROM prices WHERE price_date >= '2024-04-01'").get().n, 0);
    w.close();
});

test('ingestFundamentals refuses a Pricing field — it belongs in the history path (P7)', () => {
    const db = freshDb();
    assert.throws(
        () =>
            ingestFundamentals({
                session: new FakeLsegSession(),
                universe: ['IBM.N'],
                fields: ['TR.PriceClose'],
                period: 'FY2024',
                dbPath: db,
            }),
        (error) => /Pricing field/.test(error.message) && /ingestPrices/.test(error.message),
    );
});

test('ingestPrices lands a close series at its own grain, readable by RIC (P7)', () => {
    const db = freshDb();
    const result = ingestPrices({
        session: new FakeLsegSession(),
        universe: ['IBM.N'],
        fields: ['TR.PriceClose'],
        start: '2024-04-01',
        end: '2024-04-03',
        dbPath: db,
        source: 'FakeLsegSession history (test)',
        retrievedAt: '2025-01-15',
    });
    assert.equal(result.quotes, 1);
    assert.equal(result.datapoints, 3, 'three trading days landed');

    // The series reads back through the guarded pipeline, keyed by the RIC's quote
    // PermID, ending at the last close in the fixture.
    const { rows } = priceCloseSeries({ ric: 'IBM.N', from: '2024-04-01', to: '2024-04-03', dbPath: db, logPath: join(mkdtempSync(join(tmpdir(), 'l-')), 'a.jsonl') });
    assert.equal(rows.length, 3);
    assert.equal(rows[0].price_date, '2024-04-01');
    assert.equal(rows[rows.length - 1].close, 22_050);
});

test('ingestPrices refuses a non-Pricing field (mirror of the fundamentals guard, P7)', () => {
    const db = freshDb();
    assert.throws(
        () =>
            ingestPrices({
                session: { getHistory: () => [{ Instrument: 'IBM.N', date: '2024-04-01', 'TR.Revenue': 1 }] },
                universe: ['IBM.N'],
                fields: ['TR.Revenue'],
                dbPath: db,
            }),
        (error) => /not a Pricing field/.test(error.message) && /ingestFundamentals/.test(error.message),
    );
});

test('the real session refuses to run without a credential', () => {
    const prev = process.env.LSEG_APP_KEY;
    delete process.env.LSEG_APP_KEY;
    try {
        assert.throws(
            () => new RealLsegSession().getData(['IBM.N'], ['TR.Revenue'], { period: 'FY2024' }),
            (error) => /LSEG_APP_KEY/.test(error.message),
        );
    } finally {
        if (prev !== undefined) process.env.LSEG_APP_KEY = prev;
    }
});
