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
export const LSEG_ALLOWED_TABLES = Object.freeze(['organizations', 'instruments', 'lseg_fields', 'fundamentals']);

/** Column-level allow-list for the LSEG warehouse. */
export const LSEG_ALLOWED_COLUMNS = Object.freeze({
    organizations: ['org_permid', 'name', 'sector'],
    instruments: ['ric', 'org_permid', 'isin', 'exchange', 'currency'],
    lseg_fields: ['field_code', 'name', 'category', 'unit', 'description'],
    fundamentals: ['id', 'org_permid', 'field_code', 'period', 'value', 'currency', 'basis', 'scale', 'periodicity', 'reporting_state', 'retrieved_at', 'source'],
});

/** The reporting bases a fundamentals value can be aligned to (see schema). */
export const BASIS_STANDARDIZED = 'standardized';
export const BASIS_AS_REPORTED = 'as_reported';

export const LSEG_REGISTRY = lsegRegistry();

/**
 * The organizations (issuers), keyed by real LSEG **Org PermID** (permid.org).
 * Fundamentals hang off this stable entity key, never off a RIC. The PermIDs
 * are real LSEG identifiers — validate before any real ingest, like the RICs and
 * TR.* codes.
 */
const ORGANIZATIONS = [
    { orgPermid: '4295904307', name: 'International Business Machines Corp', sector: 'Technology' },
    { orgPermid: '4295905573', name: 'Apple Inc', sector: 'Technology' },
    { orgPermid: '4295896661', name: 'Vodafone Group PLC', sector: 'Telecommunications' },
];

/**
 * The instruments (quotes/listings), keyed by real RIC — a MUTABLE alias onto
 * the stable organization. Names/venues real; figures synthetic. The seed keeps
 * one listing per issuer, so RIC ↔ Org PermID is 1:1 here, but the model does
 * not assume that (an org can carry many RICs across venues).
 */
const INSTRUMENTS = [
    { ric: 'IBM.N', orgPermid: '4295904307', isin: 'US4592001014', exchange: 'NYSE', currency: 'USD' },
    { ric: 'AAPL.O', orgPermid: '4295905573', isin: 'US0378331005', exchange: 'NASDAQ', currency: 'USD' },
    { ric: 'VOD.L', orgPermid: '4295896661', isin: 'GB00BH4HKS39', exchange: 'LSE', currency: 'USD' },
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

/**
 * The as-reported gross-profit block per (instrument, period): Revenue, Cost of
 * Revenue and Gross Profit as the company itself presented them in the filing,
 * to sit alongside the standardized (COA) values above under `basis =
 * 'as_reported'`. Modelled only for the gross-profit line (the standardized
 * identity's subject); other fields stay standardized-only.
 *
 * Most periods tie to the standardized model exactly — the common case, where
 * LSEG's normalisation agrees with the filing. IBM.N FY2022 carries a single
 * deliberate, SYNTHETIC divergence: $500m the company reported below the
 * gross-profit line (in operating expense) that LSEG's COA model folds into Cost
 * of Revenue. So as-reported Cost is $500m lower and as-reported Gross Profit
 * $500m higher than the standardized figures — a real *classification*
 * difference (not a data error, not tampering), which is what a
 * standardized-vs-as-reported reconciliation is built to surface.
 */
const AS_REPORTED = {
    'IBM.N': {
        FY2023: {
            'TR.Revenue': 61_860_000_000,
            'TR.CostOfRevenueTotal': 27_946_000_000,
            'TR.GrossProfit': 33_914_000_000, // ties to standardized
        },
        FY2022: {
            'TR.Revenue': 60_530_000_000,
            'TR.CostOfRevenueTotal': 26_735_000_000, // $500m reclassified out of COGS in the filing
            'TR.GrossProfit': 33_795_000_000, // standardized 33,295m + 500m → a caught classification difference
        },
    },
    'AAPL.O': {
        FY2023: {
            'TR.Revenue': 383_285_000_000,
            'TR.CostOfRevenueTotal': 214_137_000_000,
            'TR.GrossProfit': 169_148_000_000, // ties to standardized
        },
    },
    'VOD.L': {
        FY2023: {
            'TR.Revenue': 45_706_000_000,
            'TR.CostOfRevenueTotal': 30_900_000_000,
            'TR.GrossProfit': 14_806_000_000, // ties to standardized
        },
    },
};

/** The date the synthetic snapshot is stamped as retrieved. */
const RETRIEVED_AT = '2024-03-31';

/**
 * Read the periodicity off a period label: the leading letters before the year
 * ('FY2023' → 'FY', 'FQ2023Q1' → 'FQ'), defaulting to 'FY'. Used at ingest/seed
 * so a figure carries whether it is annual, quarterly, or LTM — you cannot
 * reconcile across periodicities.
 *
 * @param {string} period
 * @returns {string}
 */
export function periodicityOf(period) {
    return (String(period).match(/^[A-Za-z]+/)?.[0] ?? 'FY').toUpperCase();
}

/**
 * Build the LSEG warehouse: schema plus the deterministic synthetic snapshot
 * above. No randomness — every value is authored so the accounting identities
 * reconcile exactly.
 *
 * @param {string} [path]
 * @returns {{ organizations: number, instruments: number, fields: number, datapoints: number }}
 */
export function seedLseg(path = LSEG_DB_PATH) {
    const db = new DatabaseSync(path);
    db.exec('PRAGMA foreign_keys = ON');
    for (const table of ['fundamentals', 'lseg_fields', 'instruments', 'organizations']) {
        db.exec(`DROP TABLE IF EXISTS ${table}`);
    }
    db.exec(readFileSync(LSEG_SCHEMA_PATH, 'utf8'));

    const insertOrg = db.prepare('INSERT INTO organizations (org_permid, name, sector) VALUES (?,?,?)');
    const insertInstrument = db.prepare(
        'INSERT INTO instruments (ric, org_permid, isin, exchange, currency) VALUES (?,?,?,?,?)',
    );
    const insertField = db.prepare(
        'INSERT INTO lseg_fields (field_code, name, category, unit, description) VALUES (?,?,?,?,?)',
    );
    const insertFact = db.prepare(
        'INSERT INTO fundamentals (org_permid, field_code, period, value, currency, basis, scale, periodicity, reporting_state, retrieved_at, source) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    );

    for (const o of ORGANIZATIONS) insertOrg.run(o.orgPermid, o.name, o.sector);
    for (const i of INSTRUMENTS) insertInstrument.run(i.ric, i.orgPermid, i.isin, i.exchange, i.currency);
    for (const f of FIELDS) insertField.run(f.code, f.name, f.category, f.unit, f.description);

    // The seed fixtures are keyed by RIC for readability; resolve each to its
    // stable Org PermID (and the listing's currency) as the fact rows are landed.
    const byRicOrg = new Map(INSTRUMENTS.map((i) => [i.ric, i.orgPermid]));
    const byRicCcy = new Map(INSTRUMENTS.map((i) => [i.ric, i.currency]));

    let datapoints = 0;
    const seedBasis = (byRic, basis) => {
        for (const [ric, byPeriod] of Object.entries(byRic)) {
            const orgPermid = byRicOrg.get(ric);
            const currency = byRicCcy.get(ric);
            for (const [period, values] of Object.entries(byPeriod)) {
                // Synthetic values are stored raw (scale 0), single-currency, as
                // last reported; periodicity is read off the period label.
                for (const [code, value] of Object.entries(values)) {
                    insertFact.run(orgPermid, code, period, value, currency, basis, 0, periodicityOf(period), 'reported', RETRIEVED_AT, FEED_SOURCE);
                    datapoints += 1;
                }
            }
        }
    };
    seedBasis(FUNDAMENTALS, BASIS_STANDARDIZED);
    seedBasis(AS_REPORTED, BASIS_AS_REPORTED);

    db.close();
    return { organizations: ORGANIZATIONS.length, instruments: INSTRUMENTS.length, fields: FIELDS.length, datapoints };
}

/** Options common to the scenario runners. */
const guardOptions = { allowedTables: LSEG_ALLOWED_TABLES, allowedColumns: LSEG_ALLOWED_COLUMNS };

/**
 * Resolve a RIC — a mutable quote alias — to its stable Org PermID via the
 * `instruments` table. This is the one place the alias becomes the entity key;
 * fundamentals are then read by `org_permid`, never by RIC (finding #1). Returns
 * `null` for an unknown RIC, which the scenarios let fall through to an empty /
 * N-A result rather than guessing an entity.
 *
 * @param {string} ric
 * @param {{ query: Function }} warehouse
 * @returns {string|null}
 */
function resolveOrgPermid(ric, warehouse) {
    const guarded = guard('SELECT org_permid FROM instruments WHERE ric = ?', guardOptions);
    const rows = warehouse.query(guarded.sql, { params: [ric] });
    return rows[0]?.org_permid ?? null;
}

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
    // RIC is a mutable alias; fundamentals key on the stable Org PermID.
    const orgPermid = resolveOrgPermid(ric, warehouse);
    const sql =
        'SELECT ' +
        `${LSEG_REGISTRY.resolve('revenue_usd').sql} AS revenue_usd, ` +
        `${LSEG_REGISTRY.resolve('cost_of_revenue_usd').sql} AS cost_of_revenue_usd, ` +
        `${LSEG_REGISTRY.resolve('gross_profit_usd').sql} AS gross_profit_usd, ` +
        `${LSEG_REGISTRY.resolve('operating_income_usd').sql} AS operating_income_usd, ` +
        `${LSEG_REGISTRY.resolve('net_income_usd').sql} AS net_income_usd, ` +
        `${LSEG_REGISTRY.resolve('total_debt_usd').sql} AS total_debt_usd ` +
        // The snapshot is the standardized (COA) model; as-reported rows live at
        // the same grain and would otherwise double-count each field-keyed sum.
        'FROM fundamentals WHERE org_permid = ? AND period = ? AND basis = ?';
    const guarded = guard(sql, guardOptions);
    const rows = warehouse.query(guarded.sql, { params: [orgPermid, period, BASIS_STANDARDIZED] });

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
 * Scenario 2 — the standardized-model integrity check: Gross Profit = Revenue −
 * Cost of Revenue for one instrument/period, on the standardized (COA) basis.
 *
 * Honest framing (see db/lseg-anchor.md): in LSEG's standardized model Gross
 * Profit (`SGRP`) is *defined as* Revenue (`SREV`) − Cost of Revenue (`SCOR`),
 * so on clean vendor data this identity holds by construction. This is therefore
 * a *pipeline-integrity / tamper-evidence* check — it fires on ingest corruption
 * or a value altered after landing, not on a discrepancy in LSEG's own numbers.
 * The check that tests LSEG's *data* is the standardized-vs-as-reported
 * reconciliation below.
 *
 * Computes the left side from the component LSEG fields and returns it alongside
 * the reported `TR.GrossProfit`, both in one attested statement. One aggregate
 * pass over the standardized rows for `(ric, period)`: the field-keyed sums and
 * the identity (`Revenue − Cost`) are computed in a single SELECT, so the table
 * is scanned once. Not a UNION — the guard's column allow-list resolves an
 * aggregate SELECT's aliased columns but rejects a union's synthesised ones.
 *
 * Coverage: the same pass returns a non-null row count for each required
 * component (Revenue, Cost of Revenue, reported Gross Profit). A field-keyed
 * sum over a missing row is NULL, not 0 (see lsegRegistry), so an absent
 * component reads as N/A downstream rather than as a spurious `0 − 0 = 0` PASS.
 * The counts let the control name which component is missing.
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
    // RIC is a mutable alias; fundamentals key on the stable Org PermID.
    const orgPermid = resolveOrgPermid(ric, warehouse);
    const revenue = LSEG_REGISTRY.resolve('revenue_usd').sql;
    const cost = LSEG_REGISTRY.resolve('cost_of_revenue_usd').sql;
    const gross = LSEG_REGISTRY.resolve('gross_profit_usd').sql;
    // Presence: how many non-null rows back each required component. COUNT over
    // a CASE with no ELSE counts only the matching, non-null rows, so 0 means
    // the field is genuinely absent (LSEG <NA>, unentitled, coverage gap) — not
    // a real zero. field_code and value are both allow-listed columns.
    const present = (code) => `COUNT(CASE WHEN field_code = '${code}' THEN value END)`;
    // FX / basis consistency: the components being subtracted must share a
    // currency, scale and periodicity. Count the DISTINCT values of each across
    // the three required fields — >1 means the identity is combining incomparable
    // figures (see finding #2), which the control refuses rather than mis-computes.
    const req = "field_code IN ('TR.Revenue', 'TR.CostOfRevenueTotal', 'TR.GrossProfit')";
    const variantsOf = (col) => `COUNT(DISTINCT CASE WHEN ${req} THEN ${col} END)`;
    const sql =
        'SELECT ' +
        `(${revenue}) - (${cost}) AS identity_gross_usd, ` +
        `${gross} AS reported_gross_usd, ` +
        `${present('TR.Revenue')} AS revenue_present, ` +
        `${present('TR.CostOfRevenueTotal')} AS cost_present, ` +
        `${present('TR.GrossProfit')} AS gross_present, ` +
        `${variantsOf('currency')} AS currency_variants, ` +
        `${variantsOf('scale')} AS scale_variants, ` +
        `${variantsOf('periodicity')} AS periodicity_variants, ` +
        `MAX(CASE WHEN field_code = 'TR.Revenue' THEN currency END) AS currency ` +
        'FROM fundamentals WHERE org_permid = ? AND period = ? AND basis = ?';
    const guarded = guard(sql, guardOptions);
    const rows = warehouse.query(guarded.sql, { params: [orgPermid, period, BASIS_STANDARDIZED] });

    const lineage = buildLineage({
        question: `${ric} ${period} gross profit: Revenue − Cost of Revenue reconciled to reported TR.GrossProfit (standardized/COA basis)`,
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

/**
 * Scenario 3 — reconcile LSEG's standardized (COA) gross profit against the
 * gross profit as the company itself reported it, for one instrument/period.
 *
 * This is the reconciliation that tests LSEG's *data*, not an identity that
 * holds by construction. LSEG normalises every issuer into a common Chart of
 * Accounts so figures compare across companies; that normalisation can
 * reclassify a line item across the gross-profit boundary, so the standardized
 * figure and the as-reported figure legitimately differ. A tie is the common
 * case (LSEG agrees with the filing); a variance is a real *classification*
 * difference an analyst must understand before citing a number — which basis a
 * regulator is being shown, and why the two disagree.
 *
 * One aggregate pass over `(ric, period)`, selecting the `TR.GrossProfit` value
 * on each basis plus a presence count per basis (so an absent side reads as N/A,
 * not a false tie to zero — the same coverage discipline as scenario 2). The
 * basis literals are constants, not input; `basis`, `field_code` and `value` are
 * all allow-listed, so the guard admits the query and no UNION is needed.
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
export function reconcileStandardizedVsAsReported({
    ric = DEFAULT_RIC,
    period = DEFAULT_PERIOD,
    dbPath = LSEG_DB_PATH,
    logPath = LSEG_LOG_PATH,
    signer = null,
    warehouse = new SqliteWarehouse(dbPath),
} = {}) {
    // RIC is a mutable alias; fundamentals key on the stable Org PermID.
    const orgPermid = resolveOrgPermid(ric, warehouse);
    const grossOn = (basis) => `SUM(CASE WHEN field_code = 'TR.GrossProfit' AND basis = '${basis}' THEN value END)`;
    const presentOn = (basis) => `COUNT(CASE WHEN field_code = 'TR.GrossProfit' AND basis = '${basis}' THEN value END)`;
    // Comparing the two bases is only valid when they share currency/scale/
    // periodicity — count the DISTINCT values across both gross-profit rows.
    const variantsOf = (col) => `COUNT(DISTINCT CASE WHEN field_code = 'TR.GrossProfit' THEN ${col} END)`;
    const sql =
        'SELECT ' +
        `${grossOn(BASIS_STANDARDIZED)} AS standardized_gross_usd, ` +
        `${grossOn(BASIS_AS_REPORTED)} AS as_reported_gross_usd, ` +
        `${presentOn(BASIS_STANDARDIZED)} AS standardized_present, ` +
        `${presentOn(BASIS_AS_REPORTED)} AS as_reported_present, ` +
        `${variantsOf('currency')} AS currency_variants, ` +
        `${variantsOf('scale')} AS scale_variants, ` +
        `${variantsOf('periodicity')} AS periodicity_variants, ` +
        `MAX(CASE WHEN field_code = 'TR.GrossProfit' THEN currency END) AS currency ` +
        'FROM fundamentals WHERE org_permid = ? AND period = ?';
    const guarded = guard(sql, guardOptions);
    const rows = warehouse.query(guarded.sql, { params: [orgPermid, period] });

    const lineage = buildLineage({
        question: `${ric} ${period} gross profit: LSEG standardized (COA) reconciled to as-reported`,
        sql: guarded.sql,
        tables: guarded.tables,
        rows,
        limitInjected: guarded.limitInjected,
    });
    const entry = append({ ...lineage, scenario: 'lseg_standardized_vs_as_reported', ric, period }, {
        path: logPath,
        complianceTags: ['reconciliation', 'processing-integrity', 'reproducible'],
        signer,
    });
    return { rows, lineage, entry };
}
