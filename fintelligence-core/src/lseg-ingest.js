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
import { LSEG_DB_PATH, LSEG_SCHEMA_PATH, DEFAULT_PERIOD } from './lseg.js';

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
    /** @param {Record<string, Record<string, Record<string, number>>>} fixture */
    constructor(fixture = DEFAULT_FIXTURE) {
        this.fixture = fixture;
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
}

/**
 * The shape a live LSEG session takes. Not a live adapter — it pins the
 * interface and fails usefully if reached, so the seam is real and documented
 * rather than implied (the same discipline as SnowflakeWarehouse in warehouse.js).
 *
 * A real implementation would: open an authenticated `lseg-data` session against
 * a running LSEG Workspace/Eikon (a valid entitlement); execute the retrieval
 * call that lseg-mcp's `draft_api_call` produced for the requested fields; and
 * map the returned DataFrame (indexed by Instrument, with a period column from
 * the field parameters) into the wide rows this seam consumes.
 */
export class RealLsegSession {
    /** @param {object} [config] */
    constructor(config = {}) {
        this.config = config;
    }

    /** @returns {never} */
    getData() {
        throw new Error(
            'RealLsegSession is an interface shape, not a live adapter. A real implementation opens ' +
                'an authenticated lseg-data session against a running LSEG Workspace (a valid ' +
                'entitlement), runs the retrieval call drafted by lseg-mcp (draft_api_call), and maps ' +
                'the returned DataFrame into wide rows { Instrument, period, [TR.field]: value }. ' +
                'See mcp/README.md for the lseg-mcp workflow.',
        );
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
            'TR.PriceClose': 22_050,
            'TR.CompanyMarketCap': 204_000_000_000,
        },
    },
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

        const knownFields = new Set(db.prepare('SELECT field_code FROM lseg_fields').all().map((r) => r.field_code));
        for (const field of fields) {
            if (!knownFields.has(field)) {
                throw new Error(
                    `Unknown LSEG field code "${field}". Resolve and validate it via lseg-mcp ` +
                        '(search_data_dictionary / validate_lseg_formula) and add it to lseg_fields before ingesting.',
                );
            }
        }

        const currencyOf = new Map(db.prepare('SELECT ric, currency FROM instruments').all().map((r) => [r.ric, r.currency]));
        const upsertInstrument = db.prepare(
            "INSERT OR IGNORE INTO instruments (ric, name, isin, exchange, currency, sector) VALUES (?, ?, NULL, '', 'USD', NULL)",
        );
        const insertFact = db.prepare(
            'INSERT INTO fundamentals (ric, field_code, period, value, currency, retrieved_at, source) VALUES (?,?,?,?,?,?,?)',
        );

        const seenInstruments = new Set();
        let datapoints = 0;
        for (const row of wideRows) {
            const ric = row.Instrument;
            if (!ric) continue;
            if (!currencyOf.has(ric)) {
                upsertInstrument.run(ric, ric); // minimal placeholder; enrich the dictionary later
                currencyOf.set(ric, 'USD');
            }
            seenInstruments.add(ric);
            const p = row.period ?? period;
            for (const field of fields) {
                const value = row[field];
                if (value == null) continue;
                insertFact.run(ric, field, p, value, currencyOf.get(ric), retrievedAt, source);
                datapoints += 1;
            }
        }

        return { instruments: seenInstruments.size, fields: fields.length, datapoints, rows: wideRows };
    } finally {
        db.close();
    }
}
