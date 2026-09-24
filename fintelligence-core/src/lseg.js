/**
 * The LSEG company-fundamentals warehouse and its scenarios.
 *
 * The SaaS demo shows the engine works; the markets demo shows it where a number
 * has to face a regulator; the Enron demo shows it against a historical
 * reporting gap. This one shows it against *vendor market data*: the company
 * fundamentals an analyst pulls from LSEG (London Stock Exchange Group, formerly
 * Refinitiv) by `TR.*` field code through the `lseg-data` library. The same
 * guarantee applies — a reported figure reconciled against the line items that
 * compose it, grounded and hash-chained — with provenance down to the exact LSEG
 * field code each number came from.
 *
 * Two scenarios:
 *   1. a fundamentals snapshot for one instrument/period (revenue, cost of
 *      revenue, gross profit, operating income, net income, total debt), each
 *      resolved to its blessed LSEG field the one agreed way;
 *   2. a reconciliation of the reporting identity Gross Profit = Revenue − Cost
 *      of Revenue, computing the left side from the component fields and
 *      comparing it to the reported `TR.GrossProfit` — PASS when they tie,
 *      EXCEPTION with the exact variance when a value was altered after the fact.
 *
 * Data discipline (see db/lseg-anchor.md): the instrument RICs and the `TR.*`
 * field codes are REAL LSEG identifiers — validate the codes through lseg-mcp
 * before any real ingest. The values are SYNTHETIC and labelled synthetic (no
 * LSEG entitlement ships here), authored so the accounting identities hold
 * exactly. Where real data belongs, the ingest seam (src/lseg-ingest.js) lands
 * it here with the same provenance shape.
 *
 * Like the markets and Enron scenarios, nothing here calls a model: the queries
 * are canonical, so the demo runs with no API credential and no LSEG entitlement.
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { guard } from './guard.js';
import { buildLineage } from './lineage.js';
import { append } from './audit.js';
import { lsegRegistry } from './registry.js';
import { SqliteWarehouse } from './warehouse.js';

const here = dirname(fileURLToPath(import.meta.url));
export const LSEG_SCHEMA_PATH = join(here, '..', 'db', 'lseg-schema.sql');
export const LSEG_DB_PATH = join(here, '..', 'db', 'lseg.db');
export const LSEG_LOG_PATH = join(here, '..', 'db', 'lseg-audit.jsonl');

/** The instrument and period the scenarios default to. */
export const DEFAULT_RIC = 'IBM.N';
export const DEFAULT_PERIOD = 'FY2023';

/** The source string every seeded datapoint carries (synthetic, no entitlement). */
export const FEED_SOURCE =
    'LSEG synthetic snapshot (no entitlement) — validate TR.* field codes via lseg-mcp before real ingest';

/** Tables an LSEG query may read. */
export const LSEG_ALLOWED_TABLES = Object.freeze(['instruments', 'lseg_fields', 'fundamentals']);

/** Column-level allow-list for the LSEG warehouse. */
export const LSEG_ALLOWED_COLUMNS = Object.freeze({
    instruments: ['ric', 'name', 'isin', 'exchange', 'currency', 'sector'],
    lseg_fields: ['field_code', 'name', 'category', 'unit', 'description'],
    fundamentals: ['id', 'ric', 'field_code', 'period', 'value', 'currency', 'retrieved_at', 'source'],
});

export const LSEG_REGISTRY = lsegRegistry();

/** The instruments, keyed by real RIC. Names/venues real; figures synthetic. */
const INSTRUMENTS = [
    { ric: 'IBM.N', name: 'International Business Machines Corp', isin: 'US4592001014', exchange: 'NYSE', currency: 'USD', sector: 'Technology' },
    { ric: 'AAPL.O', name: 'Apple Inc', isin: 'US0378331005', exchange: 'NASDAQ', currency: 'USD', sector: 'Technology' },
    { ric: 'VOD.L', name: 'Vodafone Group PLC', isin: 'GB00BH4HKS39', exchange: 'LSE', currency: 'USD', sector: 'Telecommunications' },
];

/**
 * The LSEG field dictionary the warehouse holds. Field codes are real LSEG
 * `TR.*` conventions; units are the native unit each value is stored in. This
 * mirrors what lseg-mcp's `search_data_dictionary` resolves.
 */
const FIELDS = [
    { code: 'TR.Revenue', name: 'Revenue', category: 'Fundamentals', unit: 'usd', description: 'Total revenue for the reporting period.' },
    { code: 'TR.CostOfRevenueTotal', name: 'Cost of Revenue, Total', category: 'Fundamentals', unit: 'usd', description: 'Total cost of revenue for the reporting period.' },
    { code: 'TR.GrossProfit', name: 'Gross Profit', category: 'Fundamentals', unit: 'usd', description: 'Revenue less cost of revenue, as reported.' },
    { code: 'TR.OperatingIncome', name: 'Operating Income', category: 'Fundamentals', unit: 'usd', description: 'Income from operations.' },
    { code: 'TR.NetIncomeAfterTaxes', name: 'Net Income After Taxes', category: 'Fundamentals', unit: 'usd', description: 'Net income after taxes.' },
    { code: 'TR.TotalDebtOutstanding', name: 'Total Debt Outstanding', category: 'Fundamentals', unit: 'usd', description: 'Total interest-bearing debt outstanding.' },
    { code: 'TR.TotalAssetsReported', name: 'Total Assets, Reported', category: 'Fundamentals', unit: 'usd', description: 'Total assets as reported on the balance sheet.' },
    { code: 'TR.PriceClose', name: 'Price Close', category: 'Pricing', unit: 'usd_cents', description: 'Closing price, in currency minor units (cents).' },
    { code: 'TR.CompanyMarketCap', name: 'Company Market Capitalisation', category: 'Valuation', unit: 'usd', description: 'Market capitalisation.' },
];

/**
 * Synthetic fundamentals per (instrument, period), authored so the identity
 * Gross Profit = Revenue − Cost of Revenue holds exactly. All monetary values
 * whole USD; price in USD cents. Not a claim about any real company's results.
 */
const FUNDAMENTALS = {
    'IBM.N': {
        FY2023: {
            'TR.Revenue': 61_860_000_000,
            'TR.CostOfRevenueTotal': 27_946_000_000,
            'TR.GrossProfit': 33_914_000_000,
            'TR.OperatingIncome': 8_600_000_000,
            'TR.NetIncomeAfterTaxes': 7_502_000_000,
            'TR.TotalDebtOutstanding': 50_121_000_000,
            'TR.TotalAssetsReported': 135_241_000_000,
            'TR.PriceClose': 16_355,
            'TR.CompanyMarketCap': 149_000_000_000,
        },
        FY2022: {
            'TR.Revenue': 60_530_000_000,
            'TR.CostOfRevenueTotal': 27_235_000_000,
            'TR.GrossProfit': 33_295_000_000,
            'TR.OperatingIncome': 7_510_000_000,
            'TR.NetIncomeAfterTaxes': 1_639_000_000,
            'TR.TotalDebtOutstanding': 50_700_000_000,
            'TR.TotalAssetsReported': 127_243_000_000,
            'TR.PriceClose': 14_075,
            'TR.CompanyMarketCap': 128_000_000_000,
        },
    },
    'AAPL.O': {
        FY2023: {
            'TR.Revenue': 383_285_000_000,
            'TR.CostOfRevenueTotal': 214_137_000_000,
            'TR.GrossProfit': 169_148_000_000,
            'TR.OperatingIncome': 114_301_000_000,
            'TR.NetIncomeAfterTaxes': 96_995_000_000,
            'TR.TotalDebtOutstanding': 111_088_000_000,
            'TR.TotalAssetsReported': 352_583_000_000,
            'TR.PriceClose': 19_256,
            'TR.CompanyMarketCap': 2_994_000_000_000,
        },
    },
    'VOD.L': {
        FY2023: {
            'TR.Revenue': 45_706_000_000,
            'TR.CostOfRevenueTotal': 30_900_000_000,
            'TR.GrossProfit': 14_806_000_000,
            'TR.OperatingIncome': 3_660_000_000,
            'TR.NetIncomeAfterTaxes': 12_000_000_000,
            'TR.TotalDebtOutstanding': 60_700_000_000,
            'TR.TotalAssetsReported': 145_000_000_000,
            'TR.PriceClose': 7_412,
            'TR.CompanyMarketCap': 20_300_000_000,
        },
    },
};

/** The date the synthetic snapshot is stamped as retrieved. */
const RETRIEVED_AT = '2024-03-31';

/**
 * Build the LSEG warehouse: schema plus the deterministic synthetic snapshot
 * above. No randomness — every value is authored so the accounting identities
 * reconcile exactly.
 *
 * @param {string} [path]
 * @returns {{ instruments: number, fields: number, datapoints: number }}
 */
export function seedLseg(path = LSEG_DB_PATH) {
    const db = new DatabaseSync(path);
    db.exec('PRAGMA foreign_keys = ON');
    for (const table of ['fundamentals', 'lseg_fields', 'instruments']) {
        db.exec(`DROP TABLE IF EXISTS ${table}`);
    }
    db.exec(readFileSync(LSEG_SCHEMA_PATH, 'utf8'));

    const insertInstrument = db.prepare(
        'INSERT INTO instruments (ric, name, isin, exchange, currency, sector) VALUES (?,?,?,?,?,?)',
    );
    const insertField = db.prepare(
        'INSERT INTO lseg_fields (field_code, name, category, unit, description) VALUES (?,?,?,?,?)',
    );
    const insertFact = db.prepare(
        'INSERT INTO fundamentals (ric, field_code, period, value, currency, retrieved_at, source) VALUES (?,?,?,?,?,?,?)',
    );

    for (const i of INSTRUMENTS) insertInstrument.run(i.ric, i.name, i.isin, i.exchange, i.currency, i.sector);
    for (const f of FIELDS) insertField.run(f.code, f.name, f.category, f.unit, f.description);

    let datapoints = 0;
    for (const i of INSTRUMENTS) {
        const byPeriod = FUNDAMENTALS[i.ric] ?? {};
        for (const [period, values] of Object.entries(byPeriod)) {
            for (const [code, value] of Object.entries(values)) {
                insertFact.run(i.ric, code, period, value, i.currency, RETRIEVED_AT, FEED_SOURCE);
                datapoints += 1;
            }
        }
    }

    db.close();
    return { instruments: INSTRUMENTS.length, fields: FIELDS.length, datapoints };
}

/** Options common to the scenario runners. */
const guardOptions = { allowedTables: LSEG_ALLOWED_TABLES, allowedColumns: LSEG_ALLOWED_COLUMNS };

/**
 * Scenario 1 — a fundamentals snapshot for one instrument/period.
 *
 * Computes the key line items in one guarded query, each resolved to its blessed
 * LSEG field the one agreed way, grounded against the returned row and appended
 * to the signed, hash-chained audit log.
 *
 * @param {object} [params]
 * @param {string} [params.ric]
 * @param {string} [params.period]
 * @param {string} [params.dbPath]
 * @param {string} [params.logPath]
 * @param {object|null} [params.signer]
 * @param {{ query: Function }} [params.warehouse]
 * @returns {{ rows: object[], lineage: object, entry: object }}
 */
export function fundamentalsSnapshot({
    ric = DEFAULT_RIC,
    period = DEFAULT_PERIOD,
    dbPath = LSEG_DB_PATH,
    logPath = LSEG_LOG_PATH,
    signer = null,
    warehouse = new SqliteWarehouse(dbPath),
} = {}) {
    const sql =
        'SELECT ' +
        `${LSEG_REGISTRY.resolve('revenue_usd').sql} AS revenue_usd, ` +
        `${LSEG_REGISTRY.resolve('cost_of_revenue_usd').sql} AS cost_of_revenue_usd, ` +
        `${LSEG_REGISTRY.resolve('gross_profit_usd').sql} AS gross_profit_usd, ` +
        `${LSEG_REGISTRY.resolve('operating_income_usd').sql} AS operating_income_usd, ` +
        `${LSEG_REGISTRY.resolve('net_income_usd').sql} AS net_income_usd, ` +
        `${LSEG_REGISTRY.resolve('total_debt_usd').sql} AS total_debt_usd ` +
        'FROM fundamentals WHERE ric = ? AND period = ?';
    const guarded = guard(sql, guardOptions);
    const rows = warehouse.query(guarded.sql, { params: [ric, period] });

    const lineage = buildLineage({
        question: `${ric} ${period} fundamentals snapshot (LSEG TR.* fields)`,
        sql: guarded.sql,
        tables: guarded.tables,
        rows,
        limitInjected: guarded.limitInjected,
    });
    const entry = append({ ...lineage, scenario: 'lseg_fundamentals_snapshot', ric, period }, {
        path: logPath,
        complianceTags: ['fundamentals', 'lseg', 'reproducible'],
        signer,
    });
    return { rows, lineage, entry };
}

/**
 * Scenario 2 — reconcile the reporting identity Gross Profit = Revenue − Cost of
 * Revenue for one instrument/period.
 *
 * Computes the left side from the component LSEG fields and returns it alongside
 * the reported `TR.GrossProfit`, both in one attested statement. Two scalar
 * subqueries (one arithmetic, one direct) rather than a UNION, because the
 * guard's column allow-list resolves scalar-subquery columns but rejects a
 * union's synthesised ones. A processing-integrity control compares them and
 * passes only when they tie; a variance is an exception a query alone would
 * never surface.
 *
 * @param {object} [params]
 * @param {string} [params.ric]
 * @param {string} [params.period]
 * @param {string} [params.dbPath]
 * @param {string} [params.logPath]
 * @param {object|null} [params.signer]
 * @param {{ query: Function }} [params.warehouse]
 * @returns {{ rows: object[], lineage: object, entry: object }}
 */
export function reconcileGrossProfit({
    ric = DEFAULT_RIC,
    period = DEFAULT_PERIOD,
    dbPath = LSEG_DB_PATH,
    logPath = LSEG_LOG_PATH,
    signer = null,
    warehouse = new SqliteWarehouse(dbPath),
} = {}) {
    const revenue = LSEG_REGISTRY.resolve('revenue_usd').sql;
    const cost = LSEG_REGISTRY.resolve('cost_of_revenue_usd').sql;
    const gross = LSEG_REGISTRY.resolve('gross_profit_usd').sql;
    const sql =
        'SELECT ' +
        `(SELECT ${revenue} - ${cost} FROM fundamentals ` +
        'WHERE ric = ? AND period = ?) AS identity_gross_usd, ' +
        `(SELECT ${gross} FROM fundamentals ` +
        'WHERE ric = ? AND period = ?) AS reported_gross_usd';
    const guarded = guard(sql, guardOptions);
    const rows = warehouse.query(guarded.sql, { params: [ric, period, ric, period] });

    const lineage = buildLineage({
        question: `${ric} ${period} gross profit: Revenue − Cost of Revenue reconciled to reported TR.GrossProfit`,
        sql: guarded.sql,
        tables: guarded.tables,
        rows,
        limitInjected: guarded.limitInjected,
    });
    const entry = append({ ...lineage, scenario: 'lseg_gross_profit_reconciliation', ric, period }, {
        path: logPath,
        complianceTags: ['reconciliation', 'processing-integrity', 'reproducible'],
        signer,
    });
    return { rows, lineage, entry };
}
