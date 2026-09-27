/**
 * LSEG bridge tests: RealLsegSession spawns the real Python bridge
 * (scripts/lseg_fetch.py) against a fake `lseg.data` module
 * (test/fixtures/fake-lseg) that returns the frame shapes lseg-data documents. No
 * entitlement and no pandas — but the actual bridge code runs, so its mapping
 * discipline is pinned: values map to field codes by name only, missing values are
 * absent (never NaN or "<NA>"), a frame it cannot map is refused rather than
 * guessed, and a crashed bridge is never mistaken for an empty result. Skipped
 * where no python3 is available.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedLseg, reconcileGrossProfit } from '../src/lseg.js';
import { RealLsegSession, ingestFundamentals } from '../src/lseg-ingest.js';

const PYTHON = process.env.LSEG_PYTHON || 'python3';
const FAKE_LSEG = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-lseg');
const skip = spawnSync(PYTHON, ['--version']).status === 0 ? false : `${PYTHON} is not available`;

/**
 * Run `call` with a RealLsegSession whose bridge imports the fake lseg.data. The
 * scenario is JSON (a string, so a test can use Python's bare NaN token).
 */
function withFakeLseg(scenario, call) {
    const env = {
        PYTHONPATH: FAKE_LSEG,
        PYTHONDONTWRITEBYTECODE: '1',
        FAKE_LSEG_SCENARIO: typeof scenario === 'string' ? scenario : JSON.stringify(scenario),
    };
    const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
    Object.assign(process.env, env);
    try {
        return call(new RealLsegSession({ appKey: 'test-key', pythonPath: PYTHON }));
    } finally {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
}

const GP_FIELDS = ['TR.Revenue', 'TR.CostOfRevenueTotal', 'TR.GrossProfit'];

test('get_data maps columns by header name, and missing values are absent — never NaN or "<NA>"', { skip }, () => {
    // Upper-cased headers in a different order from the request, a numpy-style
    // integer, and three flavours of missing value (NaN, pandas NA, None).
    const scenario = `{"data": {
        "columns": ["Instrument", "TR.GROSSPROFIT", "TR.REVENUE", "TR.COSTOFREVENUETOTAL"],
        "rows": [
            ["IBM.N", 34653000000, {"$int64": 62753000000}, 28100000000],
            ["AAPL.O", NaN, {"$na": true}, null]
        ]}}`;
    const rows = withFakeLseg(scenario, (s) => s.getData(['IBM.N', 'AAPL.O'], GP_FIELDS, { period: 'FY2024' }));
    assert.deepEqual(rows, [
        { Instrument: 'IBM.N', period: 'FY2024', 'TR.Revenue': 62_753_000_000, 'TR.CostOfRevenueTotal': 28_100_000_000, 'TR.GrossProfit': 34_653_000_000 },
        { Instrument: 'AAPL.O', period: 'FY2024' },
    ]);
});

test('a requested field with no column of its own is refused, not matched by position', { skip }, () => {
    // Display-name headers: the old fallback paired the i-th field with the i-th
    // column, so a reordered or missing column put values under the wrong code.
    const scenario = { data: { columns: ['Instrument', 'Gross Profit', 'Revenue'], rows: [['IBM.N', 34_653_000_000, 62_753_000_000]] } };
    assert.throws(
        () => withFakeLseg(scenario, (s) => s.getData(['IBM.N'], ['TR.Revenue', 'TR.GrossProfit'], { period: 'FY2024' })),
        (error) => error.kind === 'bad_response' && /by position/.test(error.message),
    );
});

test('get_history for one instrument: rows carry the instrument and ISO trading dates', { skip }, () => {
    const scenario = {
        history: { index: [{ $ts: '2024-04-01' }, { $ts: '2024-04-02' }], columns: ['TR.PRICECLOSE'], rows: [[22_140], [null]] },
    };
    const rows = withFakeLseg(scenario, (s) => s.getHistory(['IBM.N'], ['TR.PriceClose'], { start: '2024-04-01', end: '2024-04-02' }));
    assert.deepEqual(rows, [
        { Instrument: 'IBM.N', date: '2024-04-01', 'TR.PriceClose': 22_140 },
        { Instrument: 'IBM.N', date: '2024-04-02' },
    ]);
});

test('get_history for several instruments: an (instrument, field) MultiIndex maps per instrument', { skip }, () => {
    const scenario = {
        history: {
            index: [{ $ts: '2024-04-01' }],
            columns: [['IBM.N', 'TR.PRICECLOSE'], ['AAPL.O', 'TR.PRICECLOSE']],
            rows: [[22_140, 17_000]],
        },
    };
    const rows = withFakeLseg(scenario, (s) => s.getHistory(['IBM.N', 'AAPL.O'], ['TR.PriceClose']));
    assert.deepEqual(rows, [
        { Instrument: 'IBM.N', date: '2024-04-01', 'TR.PriceClose': 22_140 },
        { Instrument: 'AAPL.O', date: '2024-04-01', 'TR.PriceClose': 17_000 },
    ]);
});

test('a history frame that never says which instrument a value belongs to is refused', { skip }, () => {
    // Two instruments, two fields, flat columns. The old mapping emitted rows with
    // no instrument here, which ingest then skipped — a live pull landed nothing.
    const scenario = {
        history: { index: [{ $ts: '2024-04-01' }], columns: ['TR.PRICECLOSE', 'TR.PRICEOPEN'], rows: [[22_140, 22_000]] },
    };
    assert.throws(
        () => withFakeLseg(scenario, (s) => s.getHistory(['IBM.N', 'AAPL.O'], ['TR.PriceClose', 'TR.PriceOpen'])),
        (error) => error.kind === 'bad_response' && /refusing to guess/.test(error.message),
    );
});

test('a bridge that dies without a structured error is a failure, not an empty result', { skip }, () => {
    assert.throws(
        () => withFakeLseg({ data: { crash: true } }, (s) => s.getData(['IBM.N'], ['TR.Revenue'], { period: 'FY2024' })),
        (error) => /without a structured error/.test(error.message) && /exit 3/.test(error.message),
    );
});

test('an entitlement failure surfaces as permission_denied', { skip }, () => {
    const scenario = { data: { raise: '403 Forbidden: user is not entitled to TR.Revenue' } };
    assert.throws(
        () => withFakeLseg(scenario, (s) => s.getData(['IBM.N'], ['TR.Revenue'], { period: 'FY2024' })),
        (error) => error.kind === 'permission_denied',
    );
});

test('end to end: RealLsegSession → Python bridge → ingest lands data that reconciles', { skip }, () => {
    const db = join(mkdtempSync(join(tmpdir(), 'fintel-bridge-')), 'lseg.db');
    seedLseg(db);
    const scenario = {
        data: {
            columns: ['Instrument', 'TR.REVENUE', 'TR.COSTOFREVENUETOTAL', 'TR.GROSSPROFIT'],
            rows: [['IBM.N', 62_753_000_000, 28_100_000_000, 34_653_000_000]],
        },
    };
    const result = withFakeLseg(scenario, (session) =>
        ingestFundamentals({ session, universe: ['IBM.N'], fields: GP_FIELDS, period: 'FY2024', dbPath: db, retrievedAt: '2025-01-15' }),
    );
    assert.equal(result.datapoints, 3);
    const { rows } = reconcileGrossProfit({ ric: 'IBM.N', period: 'FY2024', dbPath: db, logPath: join(mkdtempSync(join(tmpdir(), 'l-')), 'a.jsonl') });
    assert.equal(rows[0].identity_gross_usd, rows[0].reported_gross_usd);
    assert.equal(rows[0].reported_gross_usd, 34_653_000_000);
});
