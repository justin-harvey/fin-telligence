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
import { seedLseg, reconcileGrossProfit } from '../src/lseg.js';
import {
    FakeLsegSession,
    RealLsegSession,
    ingestFundamentals,
    DEFAULT_FIXTURE,
} from '../src/lseg-ingest.js';

const FIELDS = [
    'TR.Revenue',
    'TR.CostOfRevenueTotal',
    'TR.GrossProfit',
    'TR.OperatingIncome',
    'TR.NetIncomeAfterTaxes',
    'TR.TotalDebtOutstanding',
    'TR.TotalAssetsReported',
    'TR.PriceClose',
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

test('the real session stub fails loudly and explains the live path', () => {
    assert.throws(
        () => new RealLsegSession().getData(['IBM.N'], ['TR.Revenue']),
        (error) => /not a live adapter/.test(error.message) && /lseg-data/.test(error.message),
    );
});
