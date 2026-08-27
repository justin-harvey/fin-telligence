/**
 * Copy the SQLite demo warehouse into PostgreSQL.
 *
 * This runs DROP TABLE, so before it touches anything it establishes that the
 * target database contains only tables it put there. That check is the whole
 * of the safety here, and getting it right is subtler than it looks.
 *
 * ## Why this reads pg_catalog and not information_schema
 *
 * The obvious implementation asks `information_schema.tables` what is in the
 * database. It is wrong in the most dangerous possible direction.
 *
 * `information_schema` is defined by the SQL standard to show only objects the
 * current role holds some privilege on. Point the mirror at a database full of
 * another team's tables, using a role with no rights to them, and the query
 * returns ZERO ROWS. The check concludes the database is empty and clears the
 * way for DROP TABLE — it is at its most permissive exactly when the role
 * knows least about what it is standing on.
 *
 * `pg_catalog.pg_class` is not privilege-filtered. It reports what is actually
 * there. A safety check must fail closed on ignorance, and the only way to do
 * that is to ask a source that does not hide things from you.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_DB_PATH } from '../db.js';
import { ALLOWED_TABLES } from '../guard.js';

const { Client } = pg;
const here = dirname(fileURLToPath(import.meta.url));
export const PG_SCHEMA_PATH = join(here, '..', '..', 'db', 'postgres', 'schema.sql');

/** Tables this mirror owns and is therefore willing to drop. */
const DEMO_TABLES = new Set(ALLOWED_TABLES);

/**
 * Every ordinary table in the public schema, regardless of privilege.
 *
 * relkind 'r' is an ordinary table and 'p' a partitioned one; views, indexes
 * and sequences are not things this mirror would drop and are not the risk
 * being screened for.
 *
 * @param {pg.Client} client
 * @returns {Promise<string[]>}
 */
export async function listAllTables(client) {
    const { rows } = await client.query(`
        SELECT c.relname AS name
          FROM pg_catalog.pg_class c
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'
           AND c.relkind IN ('r', 'p')
         ORDER BY c.relname
    `);
    return rows.map((row) => row.name);
}

/**
 * Tables present that this mirror did not create.
 *
 * @param {pg.Client} client
 * @returns {Promise<string[]>}
 */
export async function foreignTables(client) {
    const present = await listAllTables(client);
    return present.filter((name) => !DEMO_TABLES.has(name));
}

/**
 * Rebuild the Postgres demo warehouse from the SQLite one.
 *
 * @param {object} [options]
 * @param {string} [options.url]     admin connection string
 * @param {string} [options.dbPath]  SQLite source
 * @param {boolean} [options.force]  proceed despite foreign tables
 * @returns {Promise<{tables: Record<string, number>}>}
 */
export async function mirrorToPostgres({
    url = process.env.FINTEL_ADMIN_DATABASE_URL,
    dbPath = DEFAULT_DB_PATH,
    force = false,
} = {}) {
    if (!url) {
        throw new Error('No admin connection string: set FINTEL_ADMIN_DATABASE_URL or pass { url }.');
    }

    const client = new Client({ connectionString: url });
    await client.connect();

    try {
        const foreign = await foreignTables(client);
        if (foreign.length > 0 && !force) {
            throw new Error(
                `Refusing to mirror: the target database holds ${foreign.length} table(s) this tool ` +
                    `did not create (${foreign.slice(0, 5).join(', ')}${foreign.length > 5 ? ', …' : ''}). ` +
                    'This operation drops tables. Point it at a database of its own, or pass force.',
            );
        }

        const source = new DatabaseSync(dbPath, { readOnly: true });
        try {
            // Reverse dependency order: children before parents.
            for (const table of ['acquisition_spend', 'mrr_movements', 'subscriptions', 'customers']) {
                await client.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
            }
            await client.query(readFileSync(PG_SCHEMA_PATH, 'utf8'));

            const counts = {};
            for (const table of ['customers', 'subscriptions', 'mrr_movements', 'acquisition_spend']) {
                const rows = source.prepare(`SELECT * FROM ${table} ORDER BY id`).all();
                counts[table] = rows.length;
                if (rows.length === 0) continue;

                const columns = Object.keys(rows[0]);
                // One multi-row INSERT per batch. Parameterised throughout:
                // this is the one place in the codebase that writes, and it
                // writes values that came out of another database.
                const batchSize = 500;
                for (let start = 0; start < rows.length; start += batchSize) {
                    const batch = rows.slice(start, start + batchSize);
                    const values = [];
                    const tuples = batch.map((row, rowIndex) => {
                        const placeholders = columns.map((column, columnIndex) => {
                            values.push(row[column]);
                            return `$${rowIndex * columns.length + columnIndex + 1}`;
                        });
                        return `(${placeholders.join(',')})`;
                    });
                    await client.query(
                        `INSERT INTO ${table} (${columns.join(',')}) VALUES ${tuples.join(',')}`,
                        values,
                    );
                }
            }

            // Grants attach to table objects, not names. The tables above are
            // new objects, so any SELECT granted to the reader before this ran
            // no longer applies to them. Re-granting here makes the mirror and
            // the role provisioning commutative: whichever order an operator
            // runs them in, the reader ends up able to read.
            //
            // Skipped when the role does not exist yet, which is the ordinary
            // first-run case.
            const { rows: readers } = await client.query(
                "SELECT 1 FROM pg_roles WHERE rolname = 'fintel_reader'",
            );
            if (readers.length > 0) {
                await client.query('GRANT USAGE ON SCHEMA public TO fintel_reader');
                await client.query('GRANT SELECT ON ALL TABLES IN SCHEMA public TO fintel_reader');
            }

            return { tables: counts, regrantedReader: readers.length > 0 };
        } finally {
            source.close();
        }
    } finally {
        await client.end();
    }
}
