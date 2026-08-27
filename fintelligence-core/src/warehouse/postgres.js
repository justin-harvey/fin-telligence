/**
 * The PostgreSQL warehouse adapter.
 *
 * Two things here are less obvious than they look, and both were found by
 * running this against a live server rather than by reading the driver docs.
 *
 * ## 1. Numbers come back as strings, and that breaks the lineage hash
 *
 * `pg` returns BIGINT (oid 20) and NUMERIC (oid 1700) as JavaScript strings.
 * It is right to: both can hold values a float64 cannot represent, so parsing
 * them eagerly would silently corrupt exactly the figures a finance tool
 * exists to get right.
 *
 * But the lineage hash is taken over the returned rows. SQLite hands back
 * `4128000` and Postgres hands back `"4128000"`, those canonicalise
 * differently, and the same question against the same data produces two
 * different hashes — which makes the provenance chain worthless precisely
 * when you try to reconcile two warehouses.
 *
 * Registering a parser for int8 alone is not enough, and this is the trap:
 * `SUM()` over a BIGINT column returns NUMERIC, not BIGINT. The sum of a money
 * column is the single most likely thing an analytics query selects, so the
 * unhandled type is the one that matters most.
 *
 * So both are parsed, under a rule that refuses to lose precision: convert to
 * a JS number only when the decimal text round-trips through Number exactly.
 * Anything else — a value beyond 2^53, a scaled decimal — stays a string, and
 * hashes as a string on every warehouse because SQLite has no such value to
 * disagree about. Correctness first, consistency second, never the reverse.
 *
 * ## 2. A read-only claim has to be evidence, not configuration
 *
 * Connecting with a role someone *intended* to be read-only proves nothing.
 * `assertReadOnly()` asks the server what the role can actually do, and then
 * tries a write to confirm the answer matches reality. See the method.
 */

import pg from 'pg';
import { ALLOWED_TABLES } from '../guard.js';

const { Pool, types } = pg;

const OID_INT8 = 20;
const OID_NUMERIC = 1700;

/**
 * Parse a Postgres numeric string to a JS number, but only when doing so
 * loses nothing.
 *
 * The round-trip test is the whole point: `String(Number(text)) === text`
 * holds exactly when float64 represents the value without loss. `"4128000"`
 * passes. `"9007199254740993"` (2^53 + 1) does not, and stays a string rather
 * than becoming a number that is quietly off by one.
 *
 * @param {string} text
 * @returns {number|string}
 */
export function parseExactNumeric(text) {
    if (text === null) return null;
    const asNumber = Number(text);
    if (!Number.isFinite(asNumber)) return text;
    return String(asNumber) === text ? asNumber : text;
}

types.setTypeParser(OID_INT8, parseExactNumeric);
types.setTypeParser(OID_NUMERIC, parseExactNumeric);

/**
 * @param {object} [options]
 * @param {string} [options.url] connection string; defaults to DATABASE_URL
 * @returns {import('./index.js').Warehouse}
 */
export function openPostgres({ url = process.env.DATABASE_URL } = {}) {
    if (!url) {
        throw new Error('No Postgres connection string: set DATABASE_URL or pass { url }.');
    }

    const pool = new Pool({ connectionString: url, max: 4 });
    // Redact the password before this string reaches a log, an error message
    // or an audit entry.
    const describe = url.replace(/\/\/([^:]+):[^@]*@/, '//$1:***@');

    return {
        dialect: 'postgresql',
        describe,

        async query(sql) {
            const result = await pool.query(sql);
            return result.rows;
        },

        /**
         * Prove the connected role cannot write.
         *
         * Two independent checks, because either alone can mislead:
         *
         *   - What the catalog says. `has_table_privilege` over every
         *     allow-listed table for INSERT/UPDATE/DELETE, plus superuser and
         *     schema-CREATE. This is the declarative answer.
         *   - What the server does. An actual INSERT, inside a transaction
         *     that is always rolled back. This catches the case where the
         *     catalog and reality disagree — a superuser bypass, a default
         *     privilege nobody remembered granting.
         *
         * A superuser passes the privilege check trivially (superusers bypass
         * privilege checks entirely, so `has_table_privilege` returns true for
         * everything), which is why the superuser test is separate and why the
         * write probe exists at all.
         */
        async assertReadOnly() {
            const checks = [];
            const client = await pool.connect();
            try {
                const { rows: [role] } = await client.query(
                    'SELECT current_user AS name, usesuper AS is_super FROM pg_user WHERE usename = current_user',
                );
                checks.push({
                    check: 'not_superuser',
                    passed: role ? !role.is_super : false,
                    detail: role
                        ? `current_user=${role.name} superuser=${role.is_super}`
                        : 'current_user not found in pg_user',
                });

                const { rows: [schema] } = await client.query(
                    "SELECT has_schema_privilege(current_user, 'public', 'CREATE') AS can_create",
                );
                checks.push({
                    check: 'no_schema_create',
                    passed: !schema.can_create,
                    detail: `has CREATE on schema public: ${schema.can_create}`,
                });

                for (const table of ALLOWED_TABLES) {
                    const { rows: [priv] } = await client.query(
                        `SELECT has_table_privilege(current_user, $1, 'INSERT') AS ins,
                                has_table_privilege(current_user, $1, 'UPDATE') AS upd,
                                has_table_privilege(current_user, $1, 'DELETE') AS del`,
                        [table],
                    );
                    const writable = priv.ins || priv.upd || priv.del;
                    checks.push({
                        check: `no_write_privilege:${table}`,
                        passed: !writable,
                        detail: `insert=${priv.ins} update=${priv.upd} delete=${priv.del}`,
                    });
                }

                // The live probe. Always rolled back, including on the path
                // where it unexpectedly succeeds — this must never be the
                // thing that modifies the warehouse.
                await client.query('BEGIN');
                try {
                    await client.query(
                        `INSERT INTO ${ALLOWED_TABLES[0]} (id, name, cohort_month, acquisition_channel, country, created_at)
                         VALUES (-1, '__fintel_write_probe', '1970-01', 'probe', 'ZZ', '1970-01-01')`,
                    );
                    checks.push({
                        check: 'write_probe',
                        passed: false,
                        detail: 'INSERT succeeded; the connection can write. Rolled back.',
                    });
                } catch (error) {
                    checks.push({ check: 'write_probe', passed: true, detail: error.message });
                } finally {
                    await client.query('ROLLBACK');
                }
            } finally {
                client.release();
            }

            return {
                readOnly: checks.every((c) => c.passed),
                connection: describe,
                checks,
            };
        },

        async close() {
            await pool.end();
        },
    };
}
