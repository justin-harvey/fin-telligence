/**
 * The LSEG ingest seam — where real vendor data enters the warehouse.
 *
 * Everything else in the LSEG stack reads a *read-only* warehouse through the
 * guard. This module is the one place that writes into it, and it is the trust
 * boundary: external LSEG data lands here, tagged with provenance (which `TR.*`
 * field, when retrieved, from which feed), and from that point on the guarded,
 * grounded, hash-chained read pipeline treats it as source of truth.
 *
 * The seam is a session interface, so the *design* is complete today and the
 * *credential* is the only thing that changes to go live:
 *
 *   - `LsegSession` — the contract: `getData(universe, fields, options)` returns
 *     wide rows (one per instrument), keyed by `TR.*` field code, carrying a
 *     `period`. This is exactly the shape `lseg.data.get_data(...,
 *     use_field_names_in_headers=True)` yields once its DataFrame is turned into
 *     records.
 *   - `FakeLsegSession` — a deterministic in-memory session over a fixture, so
 *     the whole ingest path is exercised (and unit-tested) with NO LSEG
 *     entitlement. This is what the demo and tests run on.
 *   - `RealLsegSession` — the shape a live session takes. Intentionally not a
 *     live integration (no LSEG dependency or network call ships in the core):
 *     it fails loudly and explains precisely what a real implementation does —
 *     run the `lseg-data` call that lseg-mcp drafted, against an active LSEG
 *     Workspace session, and map the returned DataFrame into wide rows.
 *
 * Field codes are validated against the warehouse's dictionary (`lseg_fields`)
 * before anything is written — an unknown code is refused with a pointer to
 * lseg-mcp, whose whole job is resolving and validating `TR.*` codes. That keeps
 * the "real identifiers" half of the claim discipline honest at the boundary.
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LSEG_DB_PATH, LSEG_SCHEMA_PATH, DEFAULT_PERIOD, DEFAULT_RETENTION_DAYS, periodicityOf } from './lseg.js';

/**
 * Register a data source's licensing/retention policy (finding #7) so no persisted
 * vendor data is left untagged. INSERT OR IGNORE: the first ingest of a source sets
 * its policy; later ingests keep it (change it deliberately, not by re-ingesting).
 *
 * @param {object} db  an open DatabaseSync
 * @param {{ source: string, usageClass: string, retentionDays: number|null, redistribution: string }} policy
 */
function registerSource(db, { source, usageClass, retentionDays, redistribution }) {
    db.prepare(
        'INSERT OR IGNORE INTO data_sources (source, usage_class, retention_days, redistribution, notes) VALUES (?,?,?,?,?)',
    ).run(source, usageClass, retentionDays ?? null, redistribution, 'Registered at ingest — confirm terms against the LSEG agreement.');
}

const here = dirname(fileURLToPath(import.meta.url));
/** The Python bridge RealLsegSession shells out to for real LSEG data. */
export const LSEG_FETCH_SCRIPT = join(here, '..', 'scripts', 'lseg_fetch.py');

/**
 * The session contract every LSEG data source honours. Documentation-only in
 * JS (no interfaces), but the shape both implementations below share.
 *
 * @typedef {object} LsegSession
 * @property {(universe: string[], fields: string[], options?: { period?: string }) => object[]} getData
 *   Returns one wide row per instrument: `{ Instrument, period, [fieldCode]: value }`.
 */

/**
 * A deterministic in-memory session over a fixture, so the ingest path runs with
 * no LSEG entitlement. The fixture is `{ ric: { period: { fieldCode: value } } }`;
 * `getData` returns the requested fields for the requested universe/period as
 * wide rows, omitting any datapoint the fixture does not hold.
 */
export class FakeLsegSession {
    /**
     * @param {Record<string, Record<string, Record<string, number>>>} [fixture]  fundamentals fixture
     * @param {Record<string, Array<{date: string, [field: string]: number|string}>>} [priceFixture]  history fixture
     */
    constructor(fixture = DEFAULT_FIXTURE, priceFixture = DEFAULT_PRICE_FIXTURE) {
        this.fixture = fixture;
        this.priceFixture = priceFixture;
    }

    /**
     * @param {string[]} universe  RICs to pull
     * @param {string[]} fields     TR.* field codes to pull
     * @param {{ period?: string }} [options]
     * @returns {object[]}
     */
    getData(universe, fields, { period = DEFAULT_PERIOD } = {}) {
        const rows = [];
        for (const ric of universe) {
            const values = this.fixture[ric]?.[period];
            if (!values) continue;
            const row = { Instrument: ric, period };
            for (const field of fields) {
                if (values[field] != null) row[field] = values[field];
            }
            rows.push(row);
        }
        return rows;
    }

    /**
     * The history path: one row per (instrument, trading day) for the requested
     * pricing fields, optionally clipped to [start, end]. Mirrors `get_history`'s
     * time-series shape — the grain a price actually lives at (finding #6).
     *
     * @param {string[]} universe  RICs to pull
     * @param {string[]} fields     pricing field codes (e.g. TR.PriceClose)
     * @param {{ start?: string, end?: string }} [options]
     * @returns {object[]}
     */
    getHistory(universe, fields, { start = null, end = null } = {}) {
        const rows = [];
        for (const ric of universe) {
            for (const point of this.priceFixture[ric] ?? []) {
                if (start && point.date < start) continue;
                if (end && point.date > end) continue;
                const row = { Instrument: ric, date: point.date };
                for (const field of fields) {
                    if (point[field] != null) row[field] = point[field];
                }
                rows.push(row);
            }
        }
        return rows;
    }
}

/**
 * A live LSEG session: fetches real fundamentals through the Python `lseg-data`
 * library via the `scripts/lseg_fetch.py` bridge, returning the same wide rows
 * the fake session does. This is the credential-swap seam — with a valid app key
 * and lseg-data installed, `ingestFundamentals({ session: new RealLsegSession() })`
 * lands genuine LSEG data and nothing downstream changes.
 *
 * The credential (an LSEG Data Platform / Workspace app key entitled for the
 * requested fields) is read, in order, from the `appKey` option or `$LSEG_APP_KEY`.
 * Without one it refuses to run rather than silently returning nothing. The exact
 * `lseg-data` call is confirmed via lseg-mcp (`draft_api_call` /
 * `get_package_signature`) — see mcp/README.md.
 */
export class RealLsegSession {
    /**
     * @param {object} [config]
     * @param {string} [config.appKey]      LSEG app key (defaults to $LSEG_APP_KEY)
     * @param {string} [config.pythonPath]  interpreter for the bridge (defaults to $LSEG_PYTHON or 'python3')
     * @param {string} [config.scriptPath]  path to lseg_fetch.py
     * @param {object} [config.parameters]  extra lseg-data field parameters
     * @param {number} [config.chunkSize]   universe batch size (real sessions are
     *   request-size / rate limited; the bridge chunks a large universe)
     * @param {number} [config.maxRetries]  transport retries per chunk (backoff doubles)
     * @param {number} [config.backoff]     initial backoff seconds for a transport retry
     */
    constructor({
        appKey = process.env.LSEG_APP_KEY,
        pythonPath = process.env.LSEG_PYTHON || 'python3',
        scriptPath = LSEG_FETCH_SCRIPT,
        parameters = {},
        chunkSize = 100,
        maxRetries = 3,
        backoff = 0.5,
    } = {}) {
        this.appKey = appKey;
        this.pythonPath = pythonPath;
        this.scriptPath = scriptPath;
        this.parameters = parameters;
        this.chunkSize = chunkSize;
        this.maxRetries = maxRetries;
        this.backoff = backoff;
    }

    /** Guard: RealLsegSession needs a credential; the fake one does not. */
    requireCredential() {
        if (!this.appKey) {
            throw new Error(
                'No LSEG credential. Set LSEG_APP_KEY (or pass { appKey }) — a valid LSEG Data Platform / ' +
                    'Workspace app key entitled for these fields — then re-run. The synthetic FakeLsegSession ' +
                    'needs no credential; RealLsegSession does. See mcp/README.md.',
            );
        }
    }

    /**
     * @param {string[]} universe
     * @param {string[]} fields
     * @param {{ period?: string }} [options]
     * @returns {object[]}
     */
    getData(universe, fields, { period } = {}) {
        this.requireCredential();
        return this.run({
            universe,
            fields,
            period,
            appKey: this.appKey,
            parameters: this.parameters,
            chunkSize: this.chunkSize,
            maxRetries: this.maxRetries,
            backoff: this.backoff,
        });
    }

    /**
     * The history path: pricing is a time series at its own grain (finding #6), so
     * it goes through the bridge's `get_history` mode (interval/start/end), not
     * `get_data`. Returns one row per (instrument, trading day).
     *
     * @param {string[]} universe
     * @param {string[]} fields  pricing field codes
     * @param {{ interval?: string, start?: string, end?: string }} [options]
     * @returns {object[]}
     */
    getHistory(universe, fields, { interval = 'daily', start = null, end = null } = {}) {
        this.requireCredential();
        return this.run({
            universe,
            fields,
            mode: 'history',
            interval,
            start,
            end,
            appKey: this.appKey,
            chunkSize: this.chunkSize,
            maxRetries: this.maxRetries,
            backoff: this.backoff,
        });
    }

    /**
     * Spawn the Python bridge with a JSON request on stdin and return its rows,
     * surfacing the bridge's classified error `kind` on failure. Shared by the
     * data and history paths so both honour the same credential, transport and
     * entitlement handling.
     *
     * @param {object} payload  the bridge request
     * @returns {object[]}
     */
    run(payload) {
        const res = spawnSync(this.pythonPath, [this.scriptPath], {
            input: JSON.stringify(payload),
            encoding: 'utf8',
            maxBuffer: 64 * 1024 * 1024,
        });
        if (res.error) {
            throw new Error(
                `Could not run the LSEG Python bridge (${this.pythonPath} ${this.scriptPath}): ${res.error.message}. ` +
                    'Install Python 3 + lseg-data, or set LSEG_PYTHON to the right interpreter.',
            );
        }
        let out;
        try {
            out = JSON.parse(res.stdout || '{}');
        } catch {
            throw new Error(`LSEG bridge returned non-JSON output: ${(res.stdout || res.stderr || '').slice(0, 400)}`);
        }
        if (out.error) {
            // The bridge classifies the failure so a caller can branch: a
            // permission_denied is an entitlement/provisioning problem, a
            // not_found is a bad field/instrument in the request, and transport is
            // retryable (the bridge already retried it). Surface the kind on the
            // error rather than flattening every failure into one opaque string.
            const kind = out.kind || 'unknown';
            const error = new Error(`LSEG fetch failed (${kind}): ${out.error}`);
            error.kind = kind;
            throw error;
        }
        return out.rows || [];
    }
}

/**
 * A default fixture for the FakeLsegSession: a fresh period (FY2024) for IBM.N,
 * authored so the gross-profit identity holds, so an ingest run produces data
 * that reconciles exactly like the seeded snapshot.
 */
export const DEFAULT_FIXTURE = {
    'IBM.N': {
        FY2024: {
            'TR.Revenue': 62_753_000_000,
            'TR.CostOfRevenueTotal': 28_100_000_000,
            'TR.GrossProfit': 34_653_000_000, // 62,753,000,000 − 28,100,000,000
            'TR.OperatingIncome': 9_020_000_000,
            'TR.NetIncomeAfterTaxes': 6_023_000_000,
            'TR.TotalDebtOutstanding': 54_000_000_000,
            'TR.TotalAssetsReported': 137_175_000_000,
            'TR.CompanyMarketCap': 204_000_000_000,
        },
    },
};

/**
 * A default price fixture for the FakeLsegSession's history path: a short daily
 * close series (USD cents) for IBM.N, so the pricing ingest path runs with no
 * entitlement. Shape mirrors what `get_history` yields — one row per trading day.
 */
export const DEFAULT_PRICE_FIXTURE = {
    'IBM.N': [
        { date: '2024-04-01', 'TR.PriceClose': 22_140 },
        { date: '2024-04-02', 'TR.PriceClose': 22_305 },
        { date: '2024-04-03', 'TR.PriceClose': 22_050 },
    ],
};

/**
 * Land LSEG fundamentals into the warehouse with provenance. The one write path.
 *
 * Pulls the requested fields for the requested universe/period from `session`,
 * validates every field code against the warehouse dictionary (`lseg_fields`),
 * and inserts one long-format `fundamentals` row per datapoint, stamped with the
 * retrieval date and source. Instruments are upserted (INSERT OR IGNORE) so an
 * ingest can introduce a new RIC; a field code the dictionary does not know is
 * refused with a pointer to lseg-mcp.
 *
 * @param {object} params
 * @param {LsegSession} params.session
 * @param {string[]} params.universe            RICs to pull
 * @param {string[]} params.fields              TR.* field codes to pull
 * @param {string} [params.period]
 * @param {string} [params.dbPath]
 * @param {string} [params.source]              the feed/entitlement string recorded on each row
 * @param {string} [params.retrievedAt]         ISO date; defaults to today
 * @returns {{ instruments: number, fields: number, datapoints: number, rows: object[] }}
 */
export function ingestFundamentals({
    session,
    universe,
    fields,
    period = DEFAULT_PERIOD,
    dbPath = LSEG_DB_PATH,
    source = 'LSEG Workspace (lseg-data)',
    usageClass = 'non-display',
    retentionDays = DEFAULT_RETENTION_DAYS,
    redistribution = 'internal-only (no redistribution)',
    retrievedAt = new Date().toISOString().slice(0, 10),
}) {
    if (!session || typeof session.getData !== 'function') {
        throw new Error('ingestFundamentals needs a session with a getData(universe, fields, options) method.');
    }
    if (!Array.isArray(universe) || universe.length === 0) throw new Error('ingestFundamentals needs a non-empty universe.');
    if (!Array.isArray(fields) || fields.length === 0) throw new Error('ingestFundamentals needs a non-empty fields list.');

    const wideRows = session.getData(universe, fields, { period });

    const db = new DatabaseSync(dbPath);
    try {
        db.exec('PRAGMA foreign_keys = ON');
        // Ensure the schema exists — an ingest can run against a fresh file.
        const hasTable = db
            .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='fundamentals'")
            .get();
        if (!hasTable) {
            if (!existsSync(LSEG_SCHEMA_PATH)) throw new Error(`LSEG schema not found at ${LSEG_SCHEMA_PATH}`);
            db.exec(readFileSync(LSEG_SCHEMA_PATH, 'utf8'));
        }
        // Tag the source's licensing/retention policy before landing any data.
        registerSource(db, { source, usageClass, retentionDays, redistribution });

        const fieldCategory = new Map(
            db.prepare('SELECT field_code, category FROM lseg_fields').all().map((r) => [r.field_code, r.category]),
        );
        for (const field of fields) {
            if (!fieldCategory.has(field)) {
                throw new Error(
                    `Unknown LSEG field code "${field}". Resolve and validate it via lseg-mcp ` +
                        '(search_data_dictionary / validate_lseg_formula) and add it to lseg_fields before ingesting.',
                );
            }
            // Pricing is a time series at its own grain (finding #6): it must not
            // land in `fundamentals` as a per-period value. Route it through the
            // history path (ingestPrices / RealLsegSession.getHistory) instead.
            if (fieldCategory.get(field) === 'Pricing') {
                throw new Error(
                    `"${field}" is a Pricing field — a time series, not a per-period fundamental. ` +
                        'Ingest it with ingestPrices (get_history grain), not ingestFundamentals (finding #6).',
                );
            }
        }

        // Fundamentals key on the stable Org PermID, so a RIC must resolve to its
        // organization before anything lands (finding #1). These maps are the
        // ric → (org_permid, currency) resolution the seeded warehouse provides.
        const orgOf = new Map(db.prepare('SELECT ric, org_permid FROM instruments').all().map((r) => [r.ric, r.org_permid]));
        const currencyOf = new Map(db.prepare('SELECT ric, currency FROM instruments').all().map((r) => [r.ric, r.currency]));
        const insertOrg = db.prepare('INSERT OR IGNORE INTO organizations (org_permid, name, sector) VALUES (?, ?, NULL)');
        const upsertInstrument = db.prepare(
            // A fundamentals-only ingest knows the org, not the quote — quote_permid
            // stays NULL until a pricing ingest fills it (nullable UNIQUE allows it).
            "INSERT OR IGNORE INTO instruments (ric, org_permid, quote_permid, isin, exchange, currency) VALUES (?, ?, NULL, NULL, '', 'USD')",
        );
        const insertFact = db.prepare(
            'INSERT INTO fundamentals (org_permid, field_code, period, value, currency, scale, periodicity, reporting_state, knowledge_date, retrieved_at, source) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        );

        const seenInstruments = new Set();
        let datapoints = 0;
        for (const row of wideRows) {
            const ric = row.Instrument;
            if (!ric) continue;
            if (!orgOf.has(ric)) {
                // Unknown RIC: real LSEG data carries the Org PermID (e.g. via
                // TR.OrganizationID); the synthetic seam does not, so mint a
                // clearly-marked placeholder organization to enrich later, and
                // alias the new RIC onto it.
                const placeholderOrg = `PENDING:${ric}`;
                insertOrg.run(placeholderOrg, ric);
                upsertInstrument.run(ric, placeholderOrg);
                orgOf.set(ric, placeholderOrg);
                currencyOf.set(ric, 'USD');
            }
            seenInstruments.add(ric);
            const orgPermid = orgOf.get(ric);
            const p = row.period ?? period;
            // Synthetic seam: values arrive raw (scale 0) as last reported.
            // Periodicity is read off the period; real data carries Scale/Curn/
            // ReportingState from the request, to be threaded through here. The
            // knowledge_date — when this vintage became known (finding #5) —
            // defaults to the retrieval date; a live feed would carry the
            // vendor's as-reported/restatement date to distinguish the two.
            for (const field of fields) {
                const value = row[field];
                if (value == null) continue;
                insertFact.run(orgPermid, field, p, value, currencyOf.get(ric), 0, periodicityOf(p), 'reported', retrievedAt, retrievedAt, source);
                datapoints += 1;
            }
        }

        return { instruments: seenInstruments.size, fields: fields.length, datapoints, rows: wideRows };
    } finally {
        db.close();
    }
}

/**
 * Land an LSEG price series into the warehouse (finding #6: pricing at its own
 * grain). The sibling of ingestFundamentals for time-series pricing: it pulls the
 * requested Pricing fields for the universe over [start, end] via
 * `session.getHistory`, and inserts one `prices` row per (quote, field, trading
 * day), keyed by the stable **quote** PermID rather than the org. Only real
 * Pricing-category fields may land here (the mirror of the fundamentals guard).
 * Idempotent per (quote, field, date) via INSERT OR REPLACE, so re-pulling a day
 * overwrites rather than duplicating.
 *
 * @param {object} params
 * @param {{ getHistory: Function }} params.session
 * @param {string[]} params.universe            RICs to pull
 * @param {string[]} params.fields              Pricing field codes (e.g. TR.PriceClose)
 * @param {string} [params.interval]            get_history interval (default 'daily')
 * @param {string|null} [params.start]          inclusive ISO start date
 * @param {string|null} [params.end]            inclusive ISO end date
 * @param {string} [params.dbPath]
 * @param {string} [params.source]
 * @param {string} [params.retrievedAt]
 * @returns {{ quotes: number, fields: number, datapoints: number, rows: object[] }}
 */
export function ingestPrices({
    session,
    universe,
    fields,
    interval = 'daily',
    start = null,
    end = null,
    dbPath = LSEG_DB_PATH,
    source = 'LSEG Workspace (lseg-data get_history)',
    usageClass = 'non-display',
    retentionDays = DEFAULT_RETENTION_DAYS,
    redistribution = 'internal-only (no redistribution)',
    retrievedAt = new Date().toISOString().slice(0, 10),
}) {
    if (!session || typeof session.getHistory !== 'function') {
        throw new Error('ingestPrices needs a session with a getHistory(universe, fields, options) method.');
    }
    if (!Array.isArray(universe) || universe.length === 0) throw new Error('ingestPrices needs a non-empty universe.');
    if (!Array.isArray(fields) || fields.length === 0) throw new Error('ingestPrices needs a non-empty fields list.');

    const rows = session.getHistory(universe, fields, { interval, start, end });

    const db = new DatabaseSync(dbPath);
    try {
        db.exec('PRAGMA foreign_keys = ON');
        const hasTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='prices'").get();
        if (!hasTable) {
            if (!existsSync(LSEG_SCHEMA_PATH)) throw new Error(`LSEG schema not found at ${LSEG_SCHEMA_PATH}`);
            db.exec(readFileSync(LSEG_SCHEMA_PATH, 'utf8'));
        }
        // Tag the source's licensing/retention policy before landing any data.
        registerSource(db, { source, usageClass, retentionDays, redistribution });

        const fieldCategory = new Map(
            db.prepare('SELECT field_code, category FROM lseg_fields').all().map((r) => [r.field_code, r.category]),
        );
        for (const field of fields) {
            if (!fieldCategory.has(field)) {
                throw new Error(
                    `Unknown LSEG field code "${field}". Validate via lseg-mcp and add it to lseg_fields before ingesting.`,
                );
            }
            if (fieldCategory.get(field) !== 'Pricing') {
                throw new Error(
                    `"${field}" is not a Pricing field — ingest it with ingestFundamentals, not ingestPrices (finding #6).`,
                );
            }
        }

        const quoteOf = new Map(db.prepare('SELECT ric, quote_permid FROM instruments').all().map((r) => [r.ric, r.quote_permid]));
        const currencyOf = new Map(db.prepare('SELECT ric, currency FROM instruments').all().map((r) => [r.ric, r.currency]));
        const insertOrg = db.prepare('INSERT OR IGNORE INTO organizations (org_permid, name, sector) VALUES (?, ?, NULL)');
        const insertInstrument = db.prepare(
            "INSERT OR IGNORE INTO instruments (ric, org_permid, quote_permid, isin, exchange, currency) VALUES (?, ?, ?, NULL, '', 'USD')",
        );
        const setQuote = db.prepare('UPDATE instruments SET quote_permid = ? WHERE ric = ? AND quote_permid IS NULL');
        const insertPrice = db.prepare(
            'INSERT OR REPLACE INTO prices (quote_permid, field_code, price_date, value, currency, scale, retrieved_at, source) VALUES (?,?,?,?,?,?,?,?)',
        );

        const seenQuotes = new Set();
        let datapoints = 0;
        for (const row of rows) {
            const ric = row.Instrument;
            const date = row.date;
            if (!ric || !date) continue;
            let quotePermid = quoteOf.get(ric);
            if (!quotePermid) {
                // Real get_history carries the quote/instrument PermID; the
                // synthetic seam does not, so mint a clearly-marked placeholder to
                // enrich later — same PENDING discipline as the fundamentals path.
                quotePermid = `QUOTE-PENDING:${ric}`;
                if (!currencyOf.has(ric)) {
                    insertOrg.run(`PENDING:${ric}`, ric);
                    insertInstrument.run(ric, `PENDING:${ric}`, quotePermid);
                    currencyOf.set(ric, 'USD');
                } else {
                    // Known RIC (e.g. from a prior fundamentals ingest) but no quote yet.
                    setQuote.run(quotePermid, ric);
                }
                quoteOf.set(ric, quotePermid);
            }
            seenQuotes.add(quotePermid);
            for (const field of fields) {
                const value = row[field];
                if (value == null) continue;
                insertPrice.run(quotePermid, field, date, value, currencyOf.get(ric) ?? 'USD', 0, retrievedAt, source);
                datapoints += 1;
            }
        }
        return { quotes: seenQuotes.size, fields: fields.length, datapoints, rows };
    } finally {
        db.close();
    }
}
