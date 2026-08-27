/**
 * Warehouse adapter tests.
 *
 * The Postgres tests skip when DATABASE_URL is unset, so `npm test` still runs
 * offline. They are not decorative: a connector nobody has pointed at a live
 * server is a connector that does not work yet, and the interesting failures
 * in this file were all found by running it rather than reading it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

import { openWarehouse } from '../src/warehouse/index.js';
import { parseExactNumeric } from '../src/warehouse/postgres.js';
import { listAllTables, foreignTables } from '../src/warehouse/mirror.js';
import { fingerprint } from '../src/lineage.js';
import { guard, SqlRejected } from '../src/guard.js';
import { ask } from '../src/ask.js';

const READER_URL = process.env.DATABASE_URL;
const WRITER_URL = process.env.DATABASE_URL_WRITABLE;
const ADMIN_URL = process.env.FINTEL_ADMIN_DATABASE_URL;

const needsPg = { skip: READER_URL ? false : 'set DATABASE_URL to run against a live PostgreSQL' };
const needsAdmin = { skip: ADMIN_URL ? false : 'set FINTEL_ADMIN_DATABASE_URL to run the mirror checks' };

// The writable role is a test fixture: it exists only to prove the read-only
// check can fail. It needs the admin connection too, because its grants have
// to be re-established before each use — see ensureWriterCanWrite().
const needsWriter = {
    skip: WRITER_URL && ADMIN_URL ? false : 'set DATABASE_URL_WRITABLE and FINTEL_ADMIN_DATABASE_URL',
};

/**
 * Re-grant write access to the fixture role.
 *
 * This exists because of the bug the suite documents. Any test that re-runs
 * the mirror recreates every table, and grants attach to objects rather than
 * names — so the writable fixture silently stops being writable, and the
 * negative tests start passing for the wrong reason: they would see a role
 * that cannot write and conclude the read-only check works.
 *
 * That is the failure mode this whole file is about, so the fix is to make
 * each test establish its own precondition rather than to inherit whatever
 * state ran before it.
 */
async function ensureWriterCanWrite() {
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    try {
        await admin.query('GRANT USAGE ON SCHEMA public TO fintel_writer');
        await admin.query('GRANT ALL ON ALL TABLES IN SCHEMA public TO fintel_writer');
    } finally {
        await admin.end();
    }
}

// A query whose result depends on the two types pg returns as strings:
// SUM() over BIGINT yields NUMERIC, and COUNT(*) yields BIGINT.
const AGGREGATE_SQL = `SELECT month, SUM(amount_cents) AS net_cents, COUNT(*) AS n
                       FROM mrr_movements GROUP BY month ORDER BY month`;

// --- numeric parsing -------------------------------------------------------

test('numeric parsing converts only when the value round-trips exactly', () => {
    assert.equal(parseExactNumeric('3585700'), 3585700);
    assert.equal(parseExactNumeric('0'), 0);
    assert.equal(parseExactNumeric('-42'), -42);

    // 2^53 + 1 is the first integer float64 cannot represent. Converting it
    // would return 9007199254740992 — off by one, silently, in a money column.
    assert.equal(parseExactNumeric('9007199254740993'), '9007199254740993');

    // Scaled decimals keep their trailing zeros in Postgres and must not be
    // normalised away: '1.50' and '1.5' are the same number but not the same
    // text, and the hash is taken over what we return.
    assert.equal(parseExactNumeric('1.50'), '1.50');
    assert.equal(parseExactNumeric('1.5'), 1.5);
    assert.equal(parseExactNumeric(null), null);
});

// --- the guard is dialect-aware -------------------------------------------

test('the guard parses under the dialect it is told, not a default', () => {
    // A Postgres cast is not SQLite syntax. Parsed under the wrong grammar it
    // is rejected as unparseable — a guard that refuses valid analytics SQL
    // gets routed around, which is its own kind of security failure.
    const pgCast = 'SELECT SUM(mrr_cents)::numeric AS total FROM subscriptions';
    assert.throws(() => guard(pgCast, { dialect: 'sqlite' }), (e) => e.reason === 'unparseable');
    assert.equal(guard(pgCast, { dialect: 'postgresql' }).tables[0], 'subscriptions');
});

test('an unrecognised dialect is refused rather than falling back to a grammar', () => {
    // Falling back would approve a statement under rules that do not describe
    // the database it is about to run against.
    assert.throws(
        () => guard('SELECT id FROM customers', { dialect: 'mysql' }),
        (error) => error instanceof SqlRejected && error.reason === 'unknown_dialect',
    );
});

test('the guard still refuses writes and unlisted tables under the postgres grammar', () => {
    const cases = [
        ['SELECT id FROM pg_catalog.pg_user', 'table_not_allowed'],
        ['SELECT 1 FROM customers; DROP TABLE customers', 'multiple_statements'],
        ["WITH x AS (UPDATE customers SET name='a' RETURNING id) SELECT * FROM x", 'write_operation'],
        ['WITH x AS (INSERT INTO customers (id) VALUES (1) RETURNING id) SELECT * FROM x', 'write_operation'],
    ];
    for (const [sql, reason] of cases) {
        assert.throws(
            () => guard(sql, { dialect: 'postgresql' }),
            (error) => error.reason === reason,
            `expected ${reason} for: ${sql}`,
        );
    }
});

test('a data-modifying DELETE inside a CTE is refused', () => {
    // Postgres permits DELETE inside a WITH clause, so this is a real attack
    // shape rather than a hypothetical one, and it is refused.
    //
    // It is refused for a weaker reason than its INSERT and UPDATE siblings,
    // which is worth stating rather than hiding behind a passing test: the
    // parser does not support DELETE ... RETURNING inside a CTE, so this
    // trips 'unparseable' before the write-detection logic ever sees it.
    //
    // Both outcomes fail closed, which is why this is documented rather than
    // treated as a defect. But the guarantee here currently rests on a gap in
    // the parser's grammar coverage, not on the check that is supposed to
    // provide it — so if a future parser version learns this syntax, this test
    // will start reporting 'write_operation' instead. That is a pass too, and
    // deliberately allowed for below.
    const sql = 'WITH x AS (DELETE FROM customers RETURNING id) SELECT * FROM x';
    assert.throws(
        () => guard(sql, { dialect: 'postgresql' }),
        (error) =>
            error instanceof SqlRejected &&
            ['unparseable', 'write_operation'].includes(error.reason),
    );
});

// --- read-only proof -------------------------------------------------------

test('the sqlite handle refuses writes', async () => {
    const db = openWarehouse({ kind: 'sqlite' });
    try {
        const proof = await db.assertReadOnly();
        assert.equal(proof.readOnly, true);
        assert.ok(proof.checks.some((c) => c.check === 'write_probe' && c.passed));
    } finally {
        await db.close();
    }
});

test('the reader role is provably read-only', needsPg, async () => {
    const db = openWarehouse({ kind: 'postgresql', url: READER_URL });
    try {
        const proof = await db.assertReadOnly();
        assert.equal(proof.readOnly, true, JSON.stringify(proof.checks, null, 2));
        // The password must never reach a log or an audit entry.
        assert.match(proof.connection, /:\*\*\*@/);
    } finally {
        await db.close();
    }
});

test('the read-only check detects a writable credential', needsWriter, async () => {
    await ensureWriterCanWrite();
    // Without this the check could be passing vacuously — always returning
    // true regardless of the credential — and nobody would notice until it
    // mattered. A safety check that cannot fail is not a safety check.
    const db = openWarehouse({ kind: 'postgresql', url: WRITER_URL });
    try {
        const proof = await db.assertReadOnly();
        assert.equal(proof.readOnly, false);
        assert.ok(proof.checks.some((c) => c.check === 'write_probe' && !c.passed));
    } finally {
        await db.close();
    }
});

test('the write probe leaves no trace of itself', needsWriter, async () => {
    await ensureWriterCanWrite();
    // The probe writes on a writable connection by design. It must always roll
    // back — a check that verifies read-only-ness by modifying the warehouse
    // would be self-defeating.
    const db = openWarehouse({ kind: 'postgresql', url: WRITER_URL });
    try {
        await db.assertReadOnly();
        const rows = await db.query('SELECT COUNT(*) AS n FROM customers WHERE id = -1');
        assert.equal(rows[0].n, 0);
    } finally {
        await db.close();
    }
});

test('ask() refuses at the verify stage on a writable connection', needsWriter, async () => {
    await ensureWriterCanWrite();
    const db = openWarehouse({ kind: 'postgresql', url: WRITER_URL });
    try {
        const result = await ask('anything', {
            warehouse: db,
            // No client stub needed: verify runs before the model is called,
            // which is the point — a writable connection is refused before a
            // question is ever planned.
            client: { messages: { create: async () => assert.fail('planner must not be reached') } },
        });
        assert.equal(result.ok, false);
        assert.equal(result.stage, 'verify');
        assert.equal(result.reason, 'connection_not_read_only');
    } finally {
        await db.close();
    }
});

// --- cross-warehouse consistency ------------------------------------------

test('the same query hashes identically on sqlite and postgres', needsPg, async () => {
    // This is the property that makes lineage worth anything across two
    // warehouses: if the hashes disagree, an auditor reconciling the same
    // question against two systems sees a mismatch that means nothing.
    //
    // They disagree by default. pg returns BIGINT and NUMERIC as strings, so
    // SQLite's 3585700 meets Postgres's "3585700" and the canonical forms
    // differ. Registering a parser for int8 alone does not fix it: SUM() over
    // a BIGINT column returns NUMERIC, and the sum of a money column is
    // exactly what an analytics query selects.
    const lite = openWarehouse({ kind: 'sqlite' });
    const post = openWarehouse({ kind: 'postgresql', url: READER_URL });
    try {
        const a = await lite.query(AGGREGATE_SQL);
        const b = await post.query(AGGREGATE_SQL);

        assert.ok(a.length > 0, 'seed the warehouse first');
        assert.equal(typeof a[0].net_cents, 'number');
        assert.equal(typeof b[0].net_cents, 'number', 'NUMERIC came back unparsed');
        assert.equal(typeof b[0].n, 'number', 'BIGINT came back unparsed');
        assert.equal(fingerprint(a), fingerprint(b));
    } finally {
        await lite.close();
        await post.close();
    }
});

// --- the mirror's safety check --------------------------------------------

test('the table census is not filtered by privilege', needsAdmin, async () => {
    // The regression this pins down: information_schema.tables is defined to
    // show only what the current role holds a privilege on. A mirror that
    // screened the target database with it would see zero rows in a database
    // full of tables it has no rights to, conclude the database was empty, and
    // proceed to DROP TABLE. It fails open exactly when the role knows least.
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    try {
        await admin.query('DROP TABLE IF EXISTS someone_elses_ledger');
        await admin.query('CREATE TABLE someone_elses_ledger (id BIGINT)');
        // Deny the reader everything on it, which is the situation that makes
        // information_schema lie.
        await admin.query('REVOKE ALL ON someone_elses_ledger FROM PUBLIC');
        if (READER_URL) {
            await admin.query('REVOKE ALL ON someone_elses_ledger FROM fintel_reader');
        }

        assert.ok(
            (await listAllTables(admin)).includes('someone_elses_ledger'),
            'pg_catalog must report the table',
        );
        assert.deepEqual(await foreignTables(admin), ['someone_elses_ledger']);

        if (READER_URL) {
            const reader = new pg.Client({ connectionString: READER_URL });
            await reader.connect();
            try {
                const { rows: viaInfoSchema } = await reader.query(
                    "SELECT table_name FROM information_schema.tables WHERE table_name = 'someone_elses_ledger'",
                );
                assert.equal(
                    viaInfoSchema.length,
                    0,
                    'information_schema is expected to hide it — this is the trap',
                );
                assert.ok(
                    (await listAllTables(reader)).includes('someone_elses_ledger'),
                    'pg_catalog must still report it to an unprivileged role',
                );
            } finally {
                await reader.end();
            }
        }
    } finally {
        await admin.query('DROP TABLE IF EXISTS someone_elses_ledger');
        await admin.end();
    }
});

test('re-running the mirror does not revoke the reader', { skip: READER_URL && ADMIN_URL ? false : 'needs DATABASE_URL and FINTEL_ADMIN_DATABASE_URL' }, async () => {
    // Grants attach to table objects, not to names. The mirror drops and
    // recreates every table, so each run produces new objects that happen to
    // share a name with the ones the reader was granted SELECT on — and the
    // reader silently loses access.
    //
    // The failure surfaces far from its cause: the next query returns
    // "permission denied for table customers", which reads like a broken
    // adapter or a bad password rather than a setup step that ran in the wrong
    // order. Re-granting inside the mirror makes the two setup steps commute,
    // so no ordering can produce it.
    const { mirrorToPostgres } = await import('../src/warehouse/mirror.js');
    await mirrorToPostgres({ url: ADMIN_URL });

    const reader = openWarehouse({ kind: 'postgresql', url: READER_URL });
    try {
        const rows = await reader.query('SELECT COUNT(*) AS n FROM customers');
        assert.ok(rows[0].n > 0, 'reader lost SELECT after the mirror re-ran');
    } finally {
        await reader.close();
    }
});

test('the mirror refuses a database holding tables it did not create', needsAdmin, async () => {
    const { mirrorToPostgres } = await import('../src/warehouse/mirror.js');
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    try {
        await admin.query('DROP TABLE IF EXISTS someone_elses_ledger');
        await admin.query('CREATE TABLE someone_elses_ledger (id BIGINT)');
        await assert.rejects(
            () => mirrorToPostgres({ url: ADMIN_URL }),
            /Refusing to mirror/,
        );
    } finally {
        await admin.query('DROP TABLE IF EXISTS someone_elses_ledger');
        await admin.end();
    }
});
