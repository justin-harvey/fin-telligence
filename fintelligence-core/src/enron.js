/**
 * The synthetic Enron POC warehouse and its scenarios.
 *
 * The SaaS demo shows the engine works; the markets demo shows it where a number
 * has to face a regulator. This shows it against a case where the reported
 * numbers and the underlying reality had famously come apart: Enron's FY2000
 * 10-K. Two scenarios reconstruct the two mechanics of that gap —
 *
 *   1. revenue booked GROSS (full trade notional) to make $40bn look like
 *      $100bn, versus the far smaller net merchant margin actually earned;
 *   2. debt kept OFF the balance sheet in special-purpose entities, so reported
 *      leverage of ~$10bn understated the true obligations.
 *
 * Both compute the reported figure and the underlying figure in a single guarded
 * query, ground each against the returned rows, and append a signed, hash-chained
 * audit entry — so the gap between "as reported" and "what the rows support" is
 * itself an attested, tamper-evident record.
 *
 * Data discipline: the AGGREGATES reconcile to Enron's real reported figures
 * (cited in db/enron-anchor.md and stored verbatim in `reported_financials`).
 * The transaction-level rows are SYNTHETIC, and the off-balance-sheet SPE
 * amounts are illustrative of the mechanism, not a claimed exact historical
 * total. Money is INTEGER USD MILLIONS throughout (see db/enron-schema.sql).
 *
 * Like the markets scenarios, nothing here calls a model: the queries are
 * canonical, so the demo runs with no API credential.
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { guard } from './guard.js';
import { buildLineage } from './lineage.js';
import { append } from './audit.js';
import { enronRegistry } from './registry.js';
import { SqliteWarehouse } from './warehouse.js';

const here = dirname(fileURLToPath(import.meta.url));
export const ENRON_SCHEMA_PATH = join(here, '..', 'db', 'enron-schema.sql');
export const ENRON_DB_PATH = join(here, '..', 'db', 'enron.db');
export const ENRON_LOG_PATH = join(here, '..', 'db', 'enron-audit.jsonl');

/** The fiscal year the scenarios default to — Enron's last full year reported. */
export const FISCAL_YEAR = 2000;

/** The filing every real anchor figure is cited to. */
export const FILING_SOURCE =
    'Enron Corp 10-K FY2000, filed 2001-04-02, SEC accession 0001024401-01-500010';

/** Tables an Enron query may read. */
export const ENRON_ALLOWED_TABLES = Object.freeze([
    'entities',
    'reported_financials',
    'revenue_transactions',
    'debt_instruments',
]);

/** Column-level allow-list for the Enron warehouse. */
export const ENRON_ALLOWED_COLUMNS = Object.freeze({
    entities: ['id', 'name', 'kind', 'consolidated', 'sponsor', 'formed_year'],
    reported_financials: ['fiscal_year', 'statement', 'line_item', 'amount_usd_millions', 'source'],
    revenue_transactions: [
        'id', 'entity_id', 'fiscal_year', 'segment', 'counterparty',
        'basis', 'gross_notional_usd_millions', 'net_margin_usd_millions',
    ],
    debt_instruments: [
        'id', 'entity_id', 'fiscal_year', 'instrument', 'on_balance_sheet', 'principal_usd_millions',
    ],
});

export const ENRON_REGISTRY = enronRegistry();

/**
 * The reporting entities. Enron is consolidated; the SPEs are the vehicles that
 * held debt off the balance sheet. Names are the real ones from the record;
 * their amounts (in `debt_instruments`) are synthetic and illustrative.
 */
const ENTITIES = [
    { id: 1, name: 'Enron Corp.', kind: 'parent', consolidated: 1, sponsor: null, formed_year: 1985 },
    { id: 2, name: 'JEDI', kind: 'spe', consolidated: 0, sponsor: 'CalPERS / Enron', formed_year: 1993 },
    { id: 3, name: 'Chewco Investments', kind: 'spe', consolidated: 0, sponsor: 'Enron officer', formed_year: 1997 },
    { id: 4, name: 'LJM1', kind: 'spe', consolidated: 0, sponsor: 'CFO-related', formed_year: 1999 },
    { id: 5, name: 'LJM2', kind: 'spe', consolidated: 0, sponsor: 'CFO-related', formed_year: 1999 },
    { id: 6, name: 'Raptor vehicles', kind: 'spe', consolidated: 0, sponsor: 'LJM2', formed_year: 2000 },
    { id: 7, name: 'Whitewing / Osprey', kind: 'spe', consolidated: 0, sponsor: 'Enron', formed_year: 1997 },
];

/**
 * Synthetic merchant deals whose gross notionals sum, per segment per year, to
 * Enron's real reported revenue, while net margins sum to the reported operating
 * income. Enron entity (id 1). All figures USD millions.
 */
const REVENUE_TRANSACTIONS = [
    // FY2000 — total gross 100,789 (reported total revenues), net 1,953 (operating income).
    { fy: 2000, segment: 'natural gas', counterparty: 'EnronOnline — Henry Hub gas supply', gross: 30_300, net: 540 },
    { fy: 2000, segment: 'natural gas', counterparty: 'West-coast gas trading book', gross: 20_200, net: 360 },
    { fy: 2000, segment: 'electricity', counterparty: 'California ISO power sales', gross: 20_000, net: 420 },
    { fy: 2000, segment: 'electricity', counterparty: 'PJM merchant power book', gross: 13_823, net: 280 },
    { fy: 2000, segment: 'metals', counterparty: 'MG plc metals trading (London)', gross: 9_234, net: 150 },
    { fy: 2000, segment: 'other', counterparty: 'Broadband intermediation', gross: 4_000, net: 100 },
    { fy: 2000, segment: 'other', counterparty: 'Weather & other derivatives', gross: 3_232, net: 103 },
    // FY1999 — total gross 40,112, net 802. No metals segment yet.
    { fy: 1999, segment: 'natural gas', counterparty: 'EnronOnline — Henry Hub gas supply', gross: 19_536, net: 400 },
    { fy: 1999, segment: 'electricity', counterparty: 'California ISO power sales', gross: 15_238, net: 300 },
    { fy: 1999, segment: 'other', counterparty: 'Broadband intermediation', gross: 5_338, net: 102 },
];

/**
 * Synthetic debt. On-balance-sheet rows sum to Enron's real reported debt
 * (short-term 1,679 + long-term 8,550 = 10,229); the off-balance-sheet SPE rows
 * are illustrative of the hidden leverage, not a claimed exact figure. USD millions.
 */
const DEBT_INSTRUMENTS = [
    // Reported, on the balance sheet (Enron parent).
    { fy: 2000, entity_id: 1, instrument: 'Commercial paper & short-term notes', on_sheet: 1, principal: 1_679 },
    { fy: 2000, entity_id: 1, instrument: 'Senior unsecured notes due 2003', on_sheet: 1, principal: 3_000 },
    { fy: 2000, entity_id: 1, instrument: 'Senior unsecured notes due 2005', on_sheet: 1, principal: 3_000 },
    { fy: 2000, entity_id: 1, instrument: 'Zero-coupon convertible notes', on_sheet: 1, principal: 2_550 },
    // Kept off the balance sheet, in the SPEs (illustrative amounts).
    { fy: 2000, entity_id: 2, instrument: 'JEDI partnership financing', on_sheet: 0, principal: 1_200 },
    { fy: 2000, entity_id: 3, instrument: 'Chewco note', on_sheet: 0, principal: 600 },
    { fy: 2000, entity_id: 4, instrument: 'LJM1 related-party financing', on_sheet: 0, principal: 900 },
    { fy: 2000, entity_id: 5, instrument: 'LJM2 related-party financing', on_sheet: 0, principal: 3_900 },
    { fy: 2000, entity_id: 6, instrument: 'Raptor hedging vehicles', on_sheet: 0, principal: 2_500 },
    { fy: 2000, entity_id: 7, instrument: 'Whitewing / Osprey notes', on_sheet: 0, principal: 2_400 },
];

/**
 * Enron's real reported figures, transcribed verbatim from the 10-K, in USD
 * millions. The citation anchor a computed figure can be checked against.
 */
const REPORTED_FINANCIALS = [
    { fy: 2000, stmt: 'income', item: 'Total revenues', amount: 100_789 },
    { fy: 1999, stmt: 'income', item: 'Total revenues', amount: 40_112 },
    { fy: 1998, stmt: 'income', item: 'Total revenues', amount: 31_260 },
    { fy: 2000, stmt: 'income', item: 'Operating income', amount: 1_953 },
    { fy: 2000, stmt: 'income', item: 'Net income', amount: 979 },
    { fy: 2000, stmt: 'balance', item: 'Total assets', amount: 65_503 },
    { fy: 2000, stmt: 'balance', item: 'Short-term debt', amount: 1_679 },
    { fy: 2000, stmt: 'balance', item: 'Long-term debt', amount: 8_550 },
    { fy: 2000, stmt: 'balance', item: 'Total current liabilities', amount: 28_406 },
    { fy: 2000, stmt: 'balance', item: 'Total shareholders equity', amount: 11_470 },
];

/**
 * Build the Enron warehouse: schema plus the deterministic synthetic activity
 * above. No randomness — every row is authored so the aggregates reconcile
 * exactly to the real reported figures.
 *
 * @param {string} [path]
 * @returns {{ entities: number, revenueTransactions: number, debtInstruments: number, reportedLineItems: number }}
 */
export function seedEnron(path = ENRON_DB_PATH) {
    const db = new DatabaseSync(path);
    db.exec('PRAGMA foreign_keys = ON');
    for (const table of ['debt_instruments', 'revenue_transactions', 'reported_financials', 'entities']) {
        db.exec(`DROP TABLE IF EXISTS ${table}`);
    }
    db.exec(readFileSync(ENRON_SCHEMA_PATH, 'utf8'));

    const insertEntity = db.prepare(
        'INSERT INTO entities (id, name, kind, consolidated, sponsor, formed_year) VALUES (?,?,?,?,?,?)',
    );
    const insertRevenue = db.prepare(
        'INSERT INTO revenue_transactions (entity_id, fiscal_year, segment, counterparty, basis, gross_notional_usd_millions, net_margin_usd_millions) VALUES (?,?,?,?,?,?,?)',
    );
    const insertDebt = db.prepare(
        'INSERT INTO debt_instruments (entity_id, fiscal_year, instrument, on_balance_sheet, principal_usd_millions) VALUES (?,?,?,?,?)',
    );
    const insertReported = db.prepare(
        'INSERT INTO reported_financials (fiscal_year, statement, line_item, amount_usd_millions, source) VALUES (?,?,?,?,?)',
    );

    for (const e of ENTITIES) insertEntity.run(e.id, e.name, e.kind, e.consolidated, e.sponsor, e.formed_year);
    for (const t of REVENUE_TRANSACTIONS) {
        insertRevenue.run(1, t.fy, t.segment, t.counterparty, 'gross', t.gross, t.net);
    }
    for (const d of DEBT_INSTRUMENTS) {
        insertDebt.run(d.entity_id, d.fy, d.instrument, d.on_sheet, d.principal);
    }
    for (const r of REPORTED_FINANCIALS) {
        insertReported.run(r.fy, r.stmt, r.item, r.amount, FILING_SOURCE);
    }

    db.close();
    return {
        entities: ENTITIES.length,
        revenueTransactions: REVENUE_TRANSACTIONS.length,
        debtInstruments: DEBT_INSTRUMENTS.length,
        reportedLineItems: REPORTED_FINANCIALS.length,
    };
}

/** Options common to the scenario runners. */
const guardOptions = { allowedTables: ENRON_ALLOWED_TABLES, allowedColumns: ENRON_ALLOWED_COLUMNS };

/**
 * Scenario 1 — revenue as reported (gross) versus merchant revenue (net margin).
 *
 * Computes both figures in one guarded query using the canonical metrics, so the
 * gross-vs-net gap that turned $40bn into $100bn is a grounded, attested result.
 *
 * @param {object} [params]
 * @param {number} [params.fiscalYear]
 * @param {string} [params.dbPath]
 * @param {string} [params.logPath]
 * @param {object|null} [params.signer]
 * @param {{ query: Function }} [params.warehouse]
 * @returns {{ rows: object[], lineage: object, entry: object }}
 */
export function revenueByBasis({
    fiscalYear = FISCAL_YEAR,
    dbPath = ENRON_DB_PATH,
    logPath = ENRON_LOG_PATH,
    signer = null,
    warehouse = new SqliteWarehouse(dbPath),
} = {}) {
    const sql =
        `SELECT ${ENRON_REGISTRY.resolve('revenue_gross_usd_millions').sql} AS revenue_gross_usd_millions, ` +
        `${ENRON_REGISTRY.resolve('revenue_net_usd_millions').sql} AS revenue_net_usd_millions ` +
        'FROM revenue_transactions WHERE fiscal_year = ?';
    const guarded = guard(sql, guardOptions);
    const rows = warehouse.query(guarded.sql, { params: [fiscalYear] });

    const lineage = buildLineage({
        question: `FY${fiscalYear} revenue as reported (gross) versus merchant revenue (net margin)`,
        sql: guarded.sql,
        tables: guarded.tables,
        rows,
        limitInjected: guarded.limitInjected,
    });
    const entry = append({ ...lineage, scenario: 'revenue_gross_vs_net', fiscalYear }, {
        path: logPath,
        complianceTags: ['revenue recognition', 'gross-vs-net', 'reproducible'],
        signer,
    });
    return { rows, lineage, entry };
}

/**
 * Scenario 2 — reported debt versus true debt including off-balance-sheet SPEs.
 *
 * One guarded query returns both the on-balance-sheet total (which reconciles to
 * the reported $10,229m) and the total across every entity, so the hidden
 * leverage is a grounded, attested figure rather than an assertion.
 *
 * @param {object} [params]
 * @param {number} [params.fiscalYear]
 * @param {string} [params.dbPath]
 * @param {string} [params.logPath]
 * @param {object|null} [params.signer]
 * @param {{ query: Function }} [params.warehouse]
 * @returns {{ rows: object[], lineage: object, entry: object }}
 */
export function debtWithHiddenLeverage({
    fiscalYear = FISCAL_YEAR,
    dbPath = ENRON_DB_PATH,
    logPath = ENRON_LOG_PATH,
    signer = null,
    warehouse = new SqliteWarehouse(dbPath),
} = {}) {
    const sql =
        `SELECT ${ENRON_REGISTRY.resolve('debt_reported_usd_millions').sql} AS reported_debt_usd_millions, ` +
        `${ENRON_REGISTRY.resolve('debt_total_usd_millions').sql} AS total_debt_incl_spe_usd_millions ` +
        'FROM debt_instruments WHERE fiscal_year = ?';
    const guarded = guard(sql, guardOptions);
    const rows = warehouse.query(guarded.sql, { params: [fiscalYear] });

    const lineage = buildLineage({
        question: `FY${fiscalYear} reported debt versus total debt including off-balance-sheet SPEs`,
        sql: guarded.sql,
        tables: guarded.tables,
        rows,
        limitInjected: guarded.limitInjected,
    });
    const entry = append({ ...lineage, scenario: 'debt_reported_vs_true', fiscalYear }, {
        path: logPath,
        complianceTags: ['off-balance-sheet', 'leverage', 'reproducible'],
        signer,
    });
    return { rows, lineage, entry };
}

/**
 * Reconciliation query — the reported debt computed from the ledger versus the
 * figure as filed in the 10-K, both in one attested statement. Two scalar
 * subqueries (one per table) rather than a UNION, because the guard's column
 * allow-list resolves scalar-subquery columns but rejects a union's synthesised
 * ones. A processing-integrity control compares the two and passes only when
 * they tie out; a variance is an exception a query alone would never surface.
 *
 * @param {object} [params]
 * @param {number} [params.fiscalYear]
 * @param {string} [params.dbPath]
 * @param {string} [params.logPath]
 * @param {object|null} [params.signer]
 * @param {{ query: Function }} [params.warehouse]
 * @returns {{ rows: object[], lineage: object, entry: object }}
 */
export function reconcileReportedDebt({
    fiscalYear = FISCAL_YEAR,
    dbPath = ENRON_DB_PATH,
    logPath = ENRON_LOG_PATH,
    signer = null,
    warehouse = new SqliteWarehouse(dbPath),
} = {}) {
    const sql =
        'SELECT ' +
        `(SELECT ${ENRON_REGISTRY.resolve('debt_reported_usd_millions').sql} FROM debt_instruments ` +
        'WHERE fiscal_year = ?) AS ledger_reported_usd_millions, ' +
        "(SELECT SUM(amount_usd_millions) FROM reported_financials " +
        "WHERE fiscal_year = ? AND line_item IN ('Short-term debt', 'Long-term debt')) AS filed_reported_usd_millions";
    const guarded = guard(sql, guardOptions);
    const rows = warehouse.query(guarded.sql, { params: [fiscalYear, fiscalYear] });

    const lineage = buildLineage({
        question: `FY${fiscalYear} reported debt: ledger-computed reconciled to the figure as filed in the 10-K`,
        sql: guarded.sql,
        tables: guarded.tables,
        rows,
        limitInjected: guarded.limitInjected,
    });
    const entry = append({ ...lineage, scenario: 'debt_reconciliation', fiscalYear }, {
        path: logPath,
        complianceTags: ['reconciliation', 'processing-integrity', 'reproducible'],
        signer,
    });
    return { rows, lineage, entry };
}

/**
 * Reconciliation query — gross revenue computed from the deal ledger versus the
 * total revenues figure as filed in the 10-K, in one attested statement. A
 * processing-integrity control passes only when they tie out; a variance means
 * the booked deals no longer sum to what was reported.
 *
 * @param {object} [params]
 * @param {number} [params.fiscalYear]
 * @param {string} [params.dbPath]
 * @param {string} [params.logPath]
 * @param {object|null} [params.signer]
 * @param {{ query: Function }} [params.warehouse]
 * @returns {{ rows: object[], lineage: object, entry: object }}
 */
export function reconcileReportedRevenue({
    fiscalYear = FISCAL_YEAR,
    dbPath = ENRON_DB_PATH,
    logPath = ENRON_LOG_PATH,
    signer = null,
    warehouse = new SqliteWarehouse(dbPath),
} = {}) {
    const sql =
        'SELECT ' +
        '(SELECT SUM(gross_notional_usd_millions) FROM revenue_transactions ' +
        'WHERE fiscal_year = ?) AS ledger_gross_usd_millions, ' +
        "(SELECT SUM(amount_usd_millions) FROM reported_financials " +
        "WHERE fiscal_year = ? AND line_item = 'Total revenues') AS filed_revenue_usd_millions";
    const guarded = guard(sql, guardOptions);
    const rows = warehouse.query(guarded.sql, { params: [fiscalYear, fiscalYear] });

    const lineage = buildLineage({
        question: `FY${fiscalYear} gross revenue reconciled to total revenues as filed in the 10-K`,
        sql: guarded.sql,
        tables: guarded.tables,
        rows,
        limitInjected: guarded.limitInjected,
    });
    const entry = append({ ...lineage, scenario: 'revenue_reconciliation', fiscalYear }, {
        path: logPath,
        complianceTags: ['reconciliation', 'revenue recognition', 'reproducible'],
        signer,
    });
    return { rows, lineage, entry };
}
