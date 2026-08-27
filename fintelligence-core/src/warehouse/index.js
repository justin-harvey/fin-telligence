/**
 * Warehouse adapters.
 *
 * The pipeline talks to a warehouse through this interface and nothing else,
 * so the guarantees the product claims have to hold on every implementation of
 * it rather than on SQLite specifically. Two adapters exist: SQLite (the demo)
 * and PostgreSQL (a real networked warehouse).
 *
 * @typedef {object} Warehouse
 * @property {'sqlite'|'postgresql'} dialect  which SQL dialect the guard parses
 * @property {string} describe                connection description, password redacted
 * @property {(sql: string) => Promise<object[]>} query
 * @property {() => Promise<ReadOnlyProof>} assertReadOnly
 * @property {() => Promise<void>} close
 *
 * @typedef {object} ReadOnlyProof
 * @property {boolean} readOnly
 * @property {string} connection
 * @property {{check: string, passed: boolean, detail: string}[]} checks
 */

import { openSqlite } from './sqlite.js';
import { openPostgres } from './postgres.js';

/**
 * Open the configured warehouse.
 *
 * Selection is explicit where given and otherwise follows DATABASE_URL, so the
 * same code path serves the offline demo and a networked warehouse without a
 * branch anywhere upstream.
 *
 * @param {object} [options]
 * @param {'sqlite'|'postgresql'} [options.kind]
 * @param {string} [options.dbPath] SQLite file
 * @param {string} [options.url]    Postgres connection string
 * @returns {Warehouse}
 */
export function openWarehouse({ kind, dbPath, url } = {}) {
    // Precedence matters. An explicit dbPath has to win over an ambient
    // DATABASE_URL: otherwise a caller that named a specific SQLite file
    // silently gets a different database because of an environment variable
    // set for something else, and the tests that pin a fixture warehouse would
    // quietly run against production-shaped config.
    const resolved =
        kind ??
        (dbPath ? 'sqlite' : url || process.env.DATABASE_URL ? 'postgresql' : 'sqlite');

    switch (resolved) {
        case 'postgresql':
            return openPostgres({ url });
        case 'sqlite':
            return openSqlite({ path: dbPath });
        default:
            throw new Error(`Unknown warehouse kind: ${resolved}`);
    }
}
