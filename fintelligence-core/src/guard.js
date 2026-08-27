/**
 * The SQL guard — the security boundary between a language model and a
 * database.
 *
 * The product claim is "the model generates SQL, the data returns the answer."
 * That claim is only worth something if the SQL a model generates cannot do
 * anything other than answer a question. Everything here exists to make the
 * set of statements that reach the database small and knowable.
 *
 * Two rules shaped this file:
 *
 * 1. Parse, never pattern-match. A regex like /^\s*SELECT/i is defeated by
 *    `SELECT 1; DROP TABLE customers`, by a leading comment, by a CTE that
 *    wraps a DELETE, and by a dozen other shapes nobody thinks of up front.
 *    This module parses the statement into an AST and inspects that. A
 *    statement that does not parse is rejected — if we cannot describe what it
 *    does, we cannot call it safe.
 *
 * 2. Defence in depth. This guard is the second line, not the only one: the
 *    connection is opened read-only (see db.js), so SQLite itself refuses a
 *    write even if something here is wrong. A guard is code and can have bugs;
 *    a read-only file handle is an operating-system fact.
 */

import sqlParser from 'node-sql-parser';

const { Parser } = sqlParser;
const parser = new Parser();

/**
 * Dialect names this guard will parse, keyed by warehouse dialect.
 *
 * The parser is dialect-sensitive in ways that matter here: Postgres syntax
 * the SQLite grammar rejects (casts with `::`, `FILTER (WHERE ...)`) would be
 * thrown out as unparseable, and a guard that rejects valid analytics SQL is
 * a guard people route around. Parsing under the wrong grammar is not a safe
 * default in either direction, so the dialect is passed in rather than
 * guessed.
 */
const PARSER_DIALECT = Object.freeze({
    sqlite: 'sqlite',
    postgresql: 'postgresql',
});

/** Tables a generated query is permitted to read. */
export const ALLOWED_TABLES = Object.freeze([
    'customers',
    'subscriptions',
    'mrr_movements',
    'acquisition_spend',
]);

/** Hard ceiling on returned rows, injected when the model omits a LIMIT. */
export const MAX_ROWS = 1000;

export class SqlRejected extends Error {
    /**
     * @param {string} reason  machine-readable reason code
     * @param {string} message human-readable explanation
     */
    constructor(reason, message) {
        super(message);
        this.name = 'SqlRejected';
        this.reason = reason;
    }
}

/**
 * Names introduced by WITH clauses.
 *
 * The parser reports CTE aliases in `tableList` alongside real tables, so
 * without this a perfectly legitimate `WITH monthly AS (...) SELECT * FROM
 * monthly` would be rejected for referencing a table called "monthly". These
 * names are defined inside the query itself and are not relations the query
 * reads from storage.
 *
 * @param {object} ast
 * @returns {Set<string>}
 */
function cteNames(ast) {
    const names = new Set();
    for (const cte of ast?.with ?? []) {
        const name = typeof cte?.name === 'string' ? cte.name : cte?.name?.value;
        if (name) names.add(String(name).toLowerCase());
    }
    return names;
}

/**
 * Validate a model-generated SQL statement and return a safe form of it.
 *
 * @param {string} sql
 * @param {object} [options]
 * @param {'sqlite'|'postgresql'} [options.dialect]
 * @returns {{ sql: string, tables: string[], limitInjected: boolean, dialect: string }}
 * @throws {SqlRejected}
 */
export function guard(sql, { dialect = 'sqlite' } = {}) {
    const grammar = PARSER_DIALECT[dialect];
    if (!grammar) {
        // An unrecognised dialect must not silently fall back to another
        // grammar: that is how a statement gets approved under rules that do
        // not describe the database it will run against.
        throw new SqlRejected('unknown_dialect', `No parser grammar for dialect: ${dialect}.`);
    }

    if (typeof sql !== 'string' || sql.trim() === '') {
        throw new SqlRejected('empty', 'No SQL was produced.');
    }

    const trimmed = sql.trim().replace(/;\s*$/, '');

    // A single trailing semicolon is normal and stripped above. One that
    // survives means a second statement follows it — the classic injection
    // shape, and the reason this check precedes parsing.
    if (trimmed.includes(';')) {
        throw new SqlRejected(
            'multiple_statements',
            'Only a single statement is allowed; found more than one.',
        );
    }

    let parsed;
    try {
        parsed = parser.parse(trimmed, { database: grammar });
    } catch (error) {
        throw new SqlRejected('unparseable', `Could not parse the statement: ${error.message}`);
    }

    // `ast` is an array when the input held several statements. The semicolon
    // check should have caught that; this covers dialect quirks.
    const statements = Array.isArray(parsed.ast) ? parsed.ast : [parsed.ast];
    if (statements.length !== 1) {
        throw new SqlRejected(
            'multiple_statements',
            `Only a single statement is allowed; found ${statements.length}.`,
        );
    }

    const statement = statements[0];
    if (statement.type !== 'select') {
        throw new SqlRejected(
            'not_a_select',
            `Only SELECT is permitted; this statement is a ${String(statement.type).toUpperCase()}.`,
        );
    }

    // tableList entries are shaped 'operation::database::table' and already
    // account for subqueries and CTE bodies, which is why this reads the flat
    // list rather than walking the AST for relation nodes by hand.
    const operations = new Set();
    const referenced = new Set();
    for (const entry of parsed.tableList) {
        const [operation, , table] = entry.split('::');
        operations.add(operation.toLowerCase());
        if (table && table !== 'null') referenced.add(table.toLowerCase());
    }

    // Every relation must be reached by a read. A CTE wrapping a DELETE parses
    // as a select at the top level but still reports the write here.
    const writes = [...operations].filter((operation) => operation !== 'select');
    if (writes.length > 0) {
        throw new SqlRejected(
            'write_operation',
            `Statement performs a non-read operation: ${writes.sort().join(', ')}.`,
        );
    }

    const locallyDefined = cteNames(statement);
    const realTables = [...referenced].filter((table) => !locallyDefined.has(table));

    const forbidden = realTables.filter((table) => !ALLOWED_TABLES.includes(table));
    if (forbidden.length > 0) {
        throw new SqlRejected(
            'table_not_allowed',
            `Query references table(s) outside the allow-list: ${forbidden.sort().join(', ')}. ` +
                `Allowed: ${ALLOWED_TABLES.join(', ')}.`,
        );
    }

    if (realTables.length === 0) {
        throw new SqlRejected(
            'no_tables',
            'Query reads no allow-listed table, so it cannot be answering a question about the data.',
        );
    }

    // A missing LIMIT is not a security problem but it is an availability one:
    // an unbounded cross join will happily try to return millions of rows.
    const hasLimit = Array.isArray(statement.limit?.value) && statement.limit.value.length > 0;
    const safeSql = hasLimit ? trimmed : `${trimmed}\nLIMIT ${MAX_ROWS}`;

    return { sql: safeSql, tables: realTables.sort(), limitInjected: !hasLimit, dialect };
}
