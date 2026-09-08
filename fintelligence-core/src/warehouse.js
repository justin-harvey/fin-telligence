/**
 * The warehouse connector abstraction.
 *
 * Everything above this line — the guard, grounding, lineage, the audit chain —
 * is independent of where the data actually lives. Today it lives in a local
 * `node:sqlite` file; in a real deployment it lives in Snowflake or BigQuery.
 * This interface is the seam that lets the engine target either without the
 * safety machinery changing.
 *
 * The contract every adapter must honour is small and non-negotiable:
 *
 *   1. Read-only. A connector must not expose a way to mutate the warehouse.
 *   2. Bounded. Every query runs under a wall-clock budget and aborts if it
 *      exceeds it — LIMIT bounds rows, not work.
 *
 * A connector exposes one method:
 *
 *   query(sql, { params, timeoutMs }) -> rows
 *
 * The SQLite adapter below is the reference implementation and the one the demo
 * runs on. The Snowflake adapter defines the shape a real adapter takes; it is
 * intentionally not a live integration (no network dependency ships in the
 * core), and calling it explains exactly what a real implementation must do.
 */

import { openReadOnly, runQuery, DEFAULT_QUERY_TIMEOUT_MS } from './db.js';

/**
 * Reference adapter over the local read-only SQLite warehouse. Opens a fresh
 * read-only handle per query and runs it under the wall-clock budget, so the
 * two contract guarantees are the operating system's and db.js's to keep, not
 * this class's to remember.
 */
export class SqliteWarehouse {
    /** @param {string} [dbPath] */
    constructor(dbPath) {
        this.dbPath = dbPath;
        this.dialect = 'sqlite';
    }

    /**
     * @param {string} sql
     * @param {object} [options]
     * @param {Array<string|number>} [options.params]
     * @param {number} [options.timeoutMs]
     * @returns {object[]}
     */
    query(sql, { params = [], timeoutMs = DEFAULT_QUERY_TIMEOUT_MS } = {}) {
        const db = openReadOnly(this.dbPath);
        try {
            return runQuery(db, sql, { params, timeoutMs });
        } finally {
            db.close();
        }
    }
}

/**
 * The shape a cloud-warehouse adapter takes. Not a live integration — it exists
 * to pin the interface and to fail loudly and usefully if reached, so the seam
 * is real and documented rather than implied.
 *
 * A real implementation would open a read-only connection (a role with SELECT
 * and nothing else), translate `?` placeholders to the driver's binding style,
 * apply a statement timeout on the session, and map result rows to plain
 * objects — preserving the read-only and bounded contract above.
 */
export class SnowflakeWarehouse {
    /** @param {object} [config] */
    constructor(config = {}) {
        this.config = config;
        this.dialect = 'snowflake';
    }

    /**
     * @param {string} _sql
     * @param {object} [_options]
     * @returns {never}
     */
    query(_sql, _options) {
        throw new Error(
            'SnowflakeWarehouse is an interface shape, not a live adapter. A real implementation ' +
                'opens a read-only (SELECT-only role) connection, binds parameters in the driver\'s ' +
                'style, sets STATEMENT_TIMEOUT_IN_SECONDS on the session, and returns plain-object ' +
                'rows — honouring the read-only and bounded contract in warehouse.js.',
        );
    }
}
