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

/**
 * The default as-of (knowledge-time) cutoff: a fixed far-future sentinel meaning
 * "the latest vintage known", used when a caller does not pin an as-of date. It
 * is a constant, never `today`, on purpose — a reproducible result hash must not
 * drift with the wall clock. An explicit as-of reproduces a figure as it stood
 * at that knowledge date (see finding #5, the bitemporal model).
 */
export const AS_OF_LATEST = '9999-12-31';

/** The source string every seeded datapoint carries (synthetic, no entitlement). */
export const FEED_SOURCE =
    'LSEG synthetic snapshot (no entitlement) — validate TR.* field codes via lseg-mcp before real ingest';

/**
 * The default cache-retention TTL, in days, for persisted vendor data (finding
 * #7). A snapshot warehouse holds vendor values, so "how long may we cache this"
 * is a licensing question; this is the default a source is tagged with when a
 * caller does not set one. Illustrative only — the real number comes from the
 * signed LSEG agreement (see db/lseg-licensing.md).
 */
export const DEFAULT_RETENTION_DAYS = 90;

/**
 * The licensing / redistribution / retention policy per data source (finding #7).
 * Keyed by the `source` string the fundamentals/prices rows carry, so the policy
 * lives once here rather than duplicated on every row. The seeded synthetic source
 * is NON-DISPLAY (derived reconciliation, not shown as a live quote), internal-only
 * (no redistribution), with the default cache TTL. These are illustrative defaults
 * for the synthetic snapshot — a live source's terms must be signed off against the
 * actual LSEG agreement before a live key.
 */
const DATA_SOURCES = [
    {
        source: FEED_SOURCE,
        usageClass: 'non-display',
        retentionDays: DEFAULT_RETENTION_DAYS,
        redistribution: 'internal-only (no redistribution)',
        notes: 'Synthetic snapshot, no LSEG entitlement bundled; illustrative policy — sign off real terms before a live key.',
    },
];

/** Tables an LSEG query may read. */
export const LSEG_ALLOWED_TABLES = Object.freeze(['organizations', 'instruments', 'lseg_fields', 'fundamentals', 'prices', 'data_sources']);

/** Column-level allow-list for the LSEG warehouse. */
export const LSEG_ALLOWED_COLUMNS = Object.freeze({
    organizations: ['org_permid', 'name', 'sector'],
    instruments: ['ric', 'org_permid', 'quote_permid', 'isin', 'exchange', 'currency'],
    lseg_fields: ['field_code', 'name', 'category', 'unit', 'description'],
    fundamentals: ['id', 'org_permid', 'field_code', 'period', 'value', 'currency', 'basis', 'scale', 'periodicity', 'reporting_state', 'knowledge_date', 'retrieved_at', 'source'],
    prices: ['id', 'quote_permid', 'field_code', 'price_date', 'value', 'currency', 'scale', 'retrieved_at', 'source'],
    data_sources: ['source', 'usage_class', 'retention_days', 'redistribution', 'notes'],
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
 *
 * `quotePermid` is the stable QUOTE-level key a price keys on (finding #6). Unlike
 * the Org PermIDs, these are NOT validated real quote PermIDs — they are clearly
 * marked synthetic placeholders (`QUOTE-PENDING:<RIC>`), to be replaced with the
 * real quote/instrument PermID (validated via lseg-mcp) before a live ingest. The
 * label keeps the claim discipline honest: real where validated, synthetic where
 * not, and never a fabricated identifier dressed up as real.
 */
const INSTRUMENTS = [
    { ric: 'IBM.N', orgPermid: '4295904307', quotePermid: 'QUOTE-PENDING:IBM.N', isin: 'US4592001014', exchange: 'NYSE', currency: 'USD' },
    { ric: 'AAPL.O', orgPermid: '4295905573', quotePermid: 'QUOTE-PENDING:AAPL.O', isin: 'US0378331005', exchange: 'NASDAQ', currency: 'USD' },
    { ric: 'VOD.L', orgPermid: '4295896661', quotePermid: 'QUOTE-PENDING:VOD.L', isin: 'GB00BH4HKS39', exchange: 'LSE', currency: 'USD' },
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

/**
 * A bitemporal restatement vintage to exercise finding #5. IBM.N FY2021's
 * gross-profit block is published in one shape, then RESTATED later: two vintages
 * of the same (org, field, period) on the standardized basis, distinguished only
 * by `knowledge_date` and `reporting_state`. An as-of read before the restatement
 * date reproduces the ORIGINAL figures (and their result hash); an as-of read
 * after — and the default "latest" read — returns the RESTATED ones. The prior
 * vintage is retained, never overwritten, so the hash-chained audit stays intact
 * across the restatement instead of reading it as tampering. Both vintages
 * satisfy the standardized identity Gross = Revenue − Cost. SYNTHETIC.
 */
const RESTATEMENTS = [
    {
        ric: 'IBM.N', period: 'FY2021', knowledgeDate: '2022-04-01', reportingState: 'original',
        values: { 'TR.Revenue': 57_350_000_000, 'TR.CostOfRevenueTotal': 30_000_000_000, 'TR.GrossProfit': 27_350_000_000 },
    },
    {
        ric: 'IBM.N', period: 'FY2021', knowledgeDate: '2023-05-15', reportingState: 'restated',
        values: { 'TR.Revenue': 57_900_000_000, 'TR.CostOfRevenueTotal': 30_200_000_000, 'TR.GrossProfit': 27_700_000_000 },
    },
];

/** The date the synthetic snapshot is stamped as retrieved (and first known). */
const RETRIEVED_AT = '2024-03-31';

/**
 * Synthetic daily closing-price series per instrument (finding #6: pricing is a
 * time series at its own grain, retrieved via `get_history`, not a per-period
 * fundamental). Values are in USD cents and end at the close previously
 * (mis)stored as the `TR.PriceClose` fundamental, so nothing about the numbers
 * regresses — only the grain is corrected. Keyed by RIC for readability; the seed
 * resolves each to its stable quote PermID as rows land in `prices`. Not a claim
 * about any real company's price history.
 */
const PRICE_FIELD = 'TR.PriceClose';
const PRICES = {
    'IBM.N':  [['2024-03-26', 16_050], ['2024-03-27', 16_210], ['2024-03-28', 16_355]],
    'AAPL.O': [['2024-03-26', 19_010], ['2024-03-27', 19_180], ['2024-03-28', 19_256]],
    'VOD.L':  [['2024-03-26', 7_500], ['2024-03-27', 7_460], ['2024-03-28', 7_412]],
};

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
    // Drop children before parents (prices → instruments/lseg_fields;
    // fundamentals → organizations/lseg_fields) so the FKs don't block a re-seed.
    // data_sources has no FK, so its order is free.
    for (const table of ['data_sources', 'prices', 'fundamentals', 'lseg_fields', 'instruments', 'organizations']) {
        db.exec(`DROP TABLE IF EXISTS ${table}`);
    }
    db.exec(readFileSync(LSEG_SCHEMA_PATH, 'utf8'));

    const insertOrg = db.prepare('INSERT INTO organizations (org_permid, name, sector) VALUES (?,?,?)');
    const insertInstrument = db.prepare(
        'INSERT INTO instruments (ric, org_permid, quote_permid, isin, exchange, currency) VALUES (?,?,?,?,?,?)',
    );
    const insertField = db.prepare(
        'INSERT INTO lseg_fields (field_code, name, category, unit, description) VALUES (?,?,?,?,?)',
    );
    const insertFact = db.prepare(
        'INSERT INTO fundamentals (org_permid, field_code, period, value, currency, basis, scale, periodicity, reporting_state, knowledge_date, retrieved_at, source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    );
    const insertPrice = db.prepare(
        'INSERT INTO prices (quote_permid, field_code, price_date, value, currency, scale, retrieved_at, source) VALUES (?,?,?,?,?,?,?,?)',
    );
    const insertSource = db.prepare(
        'INSERT INTO data_sources (source, usage_class, retention_days, redistribution, notes) VALUES (?,?,?,?,?)',
    );

    for (const o of ORGANIZATIONS) insertOrg.run(o.orgPermid, o.name, o.sector);
    for (const i of INSTRUMENTS) insertInstrument.run(i.ric, i.orgPermid, i.quotePermid, i.isin, i.exchange, i.currency);
    for (const f of FIELDS) insertField.run(f.code, f.name, f.category, f.unit, f.description);

    // The seed fixtures are keyed by RIC for readability; resolve each to its
    // stable Org PermID (and the listing's currency) as the fact rows are landed.
    const byRicOrg = new Map(INSTRUMENTS.map((i) => [i.ric, i.orgPermid]));
    const byRicCcy = new Map(INSTRUMENTS.map((i) => [i.ric, i.currency]));
    const byRicQuote = new Map(INSTRUMENTS.map((i) => [i.ric, i.quotePermid]));

    let datapoints = 0;
    const seedBasis = (byRic, basis) => {
        for (const [ric, byPeriod] of Object.entries(byRic)) {
            const orgPermid = byRicOrg.get(ric);
            const currency = byRicCcy.get(ric);
            for (const [period, values] of Object.entries(byPeriod)) {
                // Synthetic values are stored raw (scale 0), single-currency, as
                // last reported; periodicity is read off the period label. The
                // baseline snapshot's knowledge_date is the retrieval date — a
                // single vintage, so the latest-as-of read returns it unchanged.
                for (const [code, value] of Object.entries(values)) {
                    insertFact.run(orgPermid, code, period, value, currency, basis, 0, periodicityOf(period), 'reported', RETRIEVED_AT, RETRIEVED_AT, FEED_SOURCE);
                    datapoints += 1;
                }
            }
        }
    };
    seedBasis(FUNDAMENTALS, BASIS_STANDARDIZED);
    seedBasis(AS_REPORTED, BASIS_AS_REPORTED);

    // Bitemporal restatement vintages (finding #5): two vintages of the same
    // (org, field, period) on the standardized basis, differing only by
    // knowledge_date / reporting_state, so an as-of read reproduces the vintage
    // that was known at that knowledge date.
    for (const v of RESTATEMENTS) {
        const orgPermid = byRicOrg.get(v.ric);
        const currency = byRicCcy.get(v.ric);
        for (const [code, value] of Object.entries(v.values)) {
            insertFact.run(orgPermid, code, v.period, value, currency, BASIS_STANDARDIZED, 0, periodicityOf(v.period), v.reportingState, v.knowledgeDate, RETRIEVED_AT, FEED_SOURCE);
            datapoints += 1;
        }
    }

    // Pricing at its own grain (finding #6): a daily close series per quote,
    // landed in `prices` keyed by the stable quote PermID — not in `fundamentals`.
    let prices = 0;
    for (const [ric, series] of Object.entries(PRICES)) {
        const quotePermid = byRicQuote.get(ric);
        const currency = byRicCcy.get(ric);
        for (const [date, value] of series) {
            insertPrice.run(quotePermid, PRICE_FIELD, date, value, currency, 0, RETRIEVED_AT, FEED_SOURCE);
            prices += 1;
        }
    }

    // Licensing / retention policy per source (finding #7), so no persisted
    // vendor data is untagged.
    for (const s of DATA_SOURCES) insertSource.run(s.source, s.usageClass, s.retentionDays, s.redistribution, s.notes);

    db.close();
    return {
        organizations: ORGANIZATIONS.length,
        instruments: INSTRUMENTS.length,
        fields: FIELDS.length,
        datapoints,
        prices,
        sources: DATA_SOURCES.length,
    };
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
 * Resolve a RIC to its stable **quote** PermID via `instruments`. Pricing keys on
 * the quote (a price belongs to a listing at a venue), not on the org that keys
 * fundamentals (finding #6). Returns `null` for an unknown RIC, which the price
 * read lets fall through to an empty series rather than guessing a quote.
 *
 * @param {string} ric
 * @param {{ query: Function }} warehouse
 * @returns {string|null}
 */
function resolveQuotePermid(ric, warehouse) {
    const guarded = guard('SELECT quote_permid FROM instruments WHERE ric = ?', guardOptions);
    const rows = warehouse.query(guarded.sql, { params: [ric] });
    return rows[0]?.quote_permid ?? null;
}

/**
 * The bitemporal filter: keep only each field's latest vintage known at or before
 * an as-of knowledge date (finding #5). Without it, a field that has been restated
 * has two rows for the same (org, field, period, basis), and the field-keyed sums
 * would add both vintages together — the same double-count shape the `basis` scope
 * guards against, but along the knowledge-time axis.
 *
 * A correlated scalar subquery picks `MAX(knowledge_date) <= ?` for the row's own
 * (org, field, period, basis) group, so exactly one vintage survives: the most
 * recent one that was known by the as-of date. A group whose earliest vintage is
 * *after* the as-of date matches nothing (its MAX is NULL) — correctly, we did not
 * know that figure yet — so it reads as N/A downstream rather than as a zero.
 *
 * It is a scalar subquery, not a UNION, so the guard's column allow-list admits it
 * (the alias `f2` and the outer real-table qualifier both reference only
 * allow-listed columns). The single `?` binds the as-of date; it appears after the
 * outer WHERE's placeholders in statement text, so callers append it to `params`
 * last. Same-table alias `f2` disambiguates the correlation from the outer row.
 */
const LATEST_VINTAGE_AS_OF =
    'knowledge_date = (SELECT MAX(knowledge_date) FROM fundamentals f2 ' +
    'WHERE f2.org_permid = fundamentals.org_permid AND f2.field_code = fundamentals.field_code ' +
    'AND f2.period = fundamentals.period AND f2.basis = fundamentals.basis ' +
    'AND f2.knowledge_date <= ?)';

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
    asOf = AS_OF_LATEST,
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
        // The as-of filter keeps only the latest vintage of each field known by
        // the knowledge date, so a restated field is not summed twice either.
        `FROM fundamentals WHERE org_permid = ? AND period = ? AND basis = ? AND ${LATEST_VINTAGE_AS_OF}`;
    const guarded = guard(sql, guardOptions);
    const rows = warehouse.query(guarded.sql, { params: [orgPermid, period, BASIS_STANDARDIZED, asOf] });

    const lineage = buildLineage({
        question:
            `${ric} ${period} fundamentals snapshot (LSEG TR.* fields)` +
            (asOf === AS_OF_LATEST ? '' : ` as of ${asOf}`),
        sql: guarded.sql,
        tables: guarded.tables,
        rows,
        limitInjected: guarded.limitInjected,
        asOf: asOf === AS_OF_LATEST ? null : asOf,
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
    asOf = AS_OF_LATEST,
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
        // Latest vintage per field known by the as-of date, so a restated
        // component is counted once, not summed across its vintages.
        `FROM fundamentals WHERE org_permid = ? AND period = ? AND basis = ? AND ${LATEST_VINTAGE_AS_OF}`;
    const guarded = guard(sql, guardOptions);
    const rows = warehouse.query(guarded.sql, { params: [orgPermid, period, BASIS_STANDARDIZED, asOf] });

    const lineage = buildLineage({
        question:
            `${ric} ${period} gross profit: Revenue − Cost of Revenue reconciled to reported TR.GrossProfit (standardized/COA basis)` +
            (asOf === AS_OF_LATEST ? '' : ` as of ${asOf}`),
        sql: guarded.sql,
        tables: guarded.tables,
        rows,
        limitInjected: guarded.limitInjected,
        asOf: asOf === AS_OF_LATEST ? null : asOf,
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
    asOf = AS_OF_LATEST,
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
        // The as-of filter correlates on basis, so each basis independently keeps
        // its latest vintage known by the knowledge date (no cross-vintage sum).
        `FROM fundamentals WHERE org_permid = ? AND period = ? AND ${LATEST_VINTAGE_AS_OF}`;
    const guarded = guard(sql, guardOptions);
    const rows = warehouse.query(guarded.sql, { params: [orgPermid, period, asOf] });

    const lineage = buildLineage({
        question:
            `${ric} ${period} gross profit: LSEG standardized (COA) reconciled to as-reported` +
            (asOf === AS_OF_LATEST ? '' : ` as of ${asOf}`),
        sql: guarded.sql,
        tables: guarded.tables,
        rows,
        limitInjected: guarded.limitInjected,
        asOf: asOf === AS_OF_LATEST ? null : asOf,
    });
    const entry = append({ ...lineage, scenario: 'lseg_standardized_vs_as_reported', ric, period }, {
        path: logPath,
        complianceTags: ['reconciliation', 'processing-integrity', 'reproducible'],
        signer,
    });
    return { rows, lineage, entry };
}

/**
 * Scenario 4 — a closing-price time series for one instrument over a date range.
 *
 * Pricing is a time series at its own grain (finding #6), so this reads from
 * `prices` (keyed by the stable **quote** PermID), not from `fundamentals` (keyed
 * by the org, a value per fiscal period). The RIC is resolved to its quote PermID,
 * then a guarded query returns one row per trading day in the (optional) [from,
 * to] range, ordered by date, attested and hash-chained like the other scenarios.
 * An unknown RIC resolves to `null` and returns an empty series rather than
 * guessing a quote.
 *
 * @param {object} [params]
 * @param {string} [params.ric]
 * @param {string|null} [params.from]  inclusive ISO start date (default: unbounded)
 * @param {string|null} [params.to]    inclusive ISO end date (default: unbounded)
 * @param {string} [params.field]      the pricing field code (default TR.PriceClose)
 * @param {string} [params.dbPath]
 * @param {string} [params.logPath]
 * @param {object|null} [params.signer]
 * @param {{ query: Function }} [params.warehouse]
 * @returns {{ rows: object[], lineage: object, entry: object }}
 */
export function priceCloseSeries({
    ric = DEFAULT_RIC,
    from = null,
    to = null,
    field = PRICE_FIELD,
    dbPath = LSEG_DB_PATH,
    logPath = LSEG_LOG_PATH,
    signer = null,
    warehouse = new SqliteWarehouse(dbPath),
} = {}) {
    // Pricing keys on the stable quote PermID (a listing at a venue), not the org.
    const quotePermid = resolveQuotePermid(ric, warehouse);
    // The date range is optional; build the WHERE and its bound params together so
    // an omitted bound simply drops its predicate (values are always parameters,
    // never inlined). quote_permid, field_code and price_date are all allow-listed.
    const clauses = ['quote_permid = ?', 'field_code = ?'];
    const params = [quotePermid, field];
    if (from) { clauses.push('price_date >= ?'); params.push(from); }
    if (to) { clauses.push('price_date <= ?'); params.push(to); }
    const sql =
        'SELECT price_date, value AS close, currency FROM prices ' +
        `WHERE ${clauses.join(' AND ')} ORDER BY price_date`;
    const guarded = guard(sql, guardOptions);
    const rows = warehouse.query(guarded.sql, { params });

    const span = from || to ? ` ${from ?? '…'}..${to ?? '…'}` : '';
    const lineage = buildLineage({
        question: `${ric}${span} closing-price series (LSEG ${field}, get_history grain)`,
        sql: guarded.sql,
        tables: guarded.tables,
        rows,
        limitInjected: guarded.limitInjected,
    });
    const entry = append({ ...lineage, scenario: 'lseg_price_close_series', ric }, {
        path: logPath,
        complianceTags: ['pricing', 'lseg', 'reproducible'],
        signer,
    });
    return { rows, lineage, entry };
}
