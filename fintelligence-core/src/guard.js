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

/** Tables a generated query is permitted to read. */
export const ALLOWED_TABLES = Object.freeze([
    'customers',
    'subscriptions',
    'mrr_movements',
    'acquisition_spend',
]);

/** Hard ceiling on returned rows, injected when the model omits a LIMIT. */
export const MAX_ROWS = 1000;

/**
 * Blank out the contents of string literals and comments, preserving length
 * and layout, so a character that is only structurally meaningful outside a
 * literal (notably `;`) can be scanned for without tripping on one that lives
 * inside quoted text. SQLite escapes a quote inside a single-quoted string by
 * doubling it (`''`), which this handles.
 *
 * @param {string} sql
 * @returns {string}
 */
function maskLiteralsAndComments(sql) {
    let out = '';
    let i = 0;
    const n = sql.length;
    while (i < n) {
        const ch = sql[i];
        if (ch === "'") {
            out += "'";
            i += 1;
            while (i < n) {
                if (sql[i] === "'") {
                    if (sql[i + 1] === "'") {
                        out += '  '; // an escaped quote inside the literal
                        i += 2;
                        continue;
                    }
                    out += "'";
                    i += 1;
                    break;
                }
                out += ' ';
                i += 1;
            }
            continue;
        }
        if (ch === '-' && sql[i + 1] === '-') {
            while (i < n && sql[i] !== '\n') {
                out += ' ';
                i += 1;
            }
            continue;
        }
        if (ch === '/' && sql[i + 1] === '*') {
            out += '  ';
            i += 2;
            while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) {
                out += ' ';
                i += 1;
            }
            if (i < n) {
                out += '  ';
                i += 2;
            }
            continue;
        }
        out += ch;
        i += 1;
    }
    return out;
}

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
 * The optional second argument lets a caller narrow the boundary further than
 * the defaults. All of it is opt-in: with no options the behaviour is exactly
 * the historical one, which is what keeps the SaaS demo and its tests unchanged
 * while the markets demo and the auth layer can tighten the same guard.
 *
 * @param {string} sql
 * @param {object} [options]
 * @param {string[]} [options.allowedTables] tables a query may read (default: the SaaS allow-list)
 * @param {Record<string,string[]>} [options.allowedColumns] when set, only these
 *   columns may be referenced, per table; `SELECT *` is refused because it names
 *   no columns to check
 * @param {{ column: string, value: string|number }} [options.scope] a mandatory
 *   predicate injected into the top-level WHERE, bound as a parameter (never
 *   inlined). The foundation the auth/RLS layer builds on.
 * @param {{ column: string, value: string|number }} [options.asOf] an as-of
 *   cutoff: `column <= value` injected into the top-level WHERE and bound as a
 *   parameter, so a figure can be reproduced as it stood at a point in time.
 * @returns {{ sql: string, tables: string[], columns: string[], limitInjected: boolean, params: Array<string|number> }}
 * @throws {SqlRejected}
 */
export function guard(sql, options = {}) {
    const allowedTables = options.allowedTables ?? ALLOWED_TABLES;
    const allowedColumns = options.allowedColumns ?? null;
    const scope = options.scope ?? null;
    const asOf = options.asOf ?? null;

    if (typeof sql !== 'string' || sql.trim() === '') {
        throw new SqlRejected('empty', 'No SQL was produced.');
    }

    const trimmed = sql.trim().replace(/;\s*$/, '');

    // A single trailing semicolon is normal and stripped above. One that
    // survives means a second statement follows it — the classic injection
    // shape, and the reason this check precedes parsing. The scan runs on a
    // copy with string literals and comments blanked out, so a semicolon inside
    // a value like `WHERE ticker = 'BRK;A'` is not mistaken for a separator.
    // The AST statement-count check below is the authoritative backstop.
    if (maskLiteralsAndComments(trimmed).includes(';')) {
        throw new SqlRejected(
            'multiple_statements',
            'Only a single statement is allowed; found more than one.',
        );
    }

    let parsed;
    try {
        parsed = parser.parse(trimmed, { database: 'sqlite' });
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

    const forbidden = realTables.filter((table) => !allowedTables.includes(table));
    if (forbidden.length > 0) {
        throw new SqlRejected(
            'table_not_allowed',
            `Query references table(s) outside the allow-list: ${forbidden.sort().join(', ')}. ` +
                `Allowed: ${allowedTables.join(', ')}.`,
        );
    }

    if (realTables.length === 0) {
        throw new SqlRejected(
            'no_tables',
            'Query reads no allow-listed table, so it cannot be answering a question about the data.',
        );
    }

    // Column-level allow-list. Off unless the caller supplies one, so the SaaS
    // demo is unaffected; a warehouse with sensitive columns (PII, a book it
    // must not cross) turns it on to keep a generated query away from them.
    // columnList entries are shaped 'operation::table::column' and cover columns
    // in SELECT, JOIN, WHERE, GROUP BY and ORDER BY alike — so a forbidden
    // column cannot be reached by filtering on it either.
    const columnsReferenced = [];
    if (allowedColumns) {
        const lowered = {};
        const union = new Set();
        for (const [table, cols] of Object.entries(allowedColumns)) {
            lowered[table.toLowerCase()] = new Set(cols.map((c) => c.toLowerCase()));
            for (const c of cols) union.add(c.toLowerCase());
        }
        // Output aliases (SELECT ... AS x) are names the query defines, not
        // stored columns; a HAVING or ORDER BY that refers to one must not be
        // read as touching a forbidden column — the same treatment CTE names get.
        const aliases = new Set();
        for (const column of statement.columns ?? []) {
            if (column && typeof column.as === 'string' && column.as) aliases.add(column.as.toLowerCase());
        }
        for (const entry of parsed.columnList) {
            const [, rawTable, rawColumn] = entry.split('::');
            const column = String(rawColumn).toLowerCase();
            if (column === '(.*)') {
                throw new SqlRejected(
                    'wildcard_not_allowed',
                    'A column allow-list is in force, so SELECT * is refused — name the columns explicitly.',
                );
            }
            const table = rawTable && rawTable !== 'null' ? rawTable.toLowerCase() : null;
            if (!table && aliases.has(column)) continue;
            const permitted = table ? lowered[table]?.has(column) ?? false : union.has(column);
            if (!permitted) {
                throw new SqlRejected(
                    'column_not_allowed',
                    `Query references a column outside the allow-list: ${table ? `${table}.` : ''}${column}.`,
                );
            }
            columnsReferenced.push(table ? `${table}.${column}` : column);
        }
    }

    // A missing LIMIT is not a security problem but it is an availability one:
    // an unbounded cross join will happily try to return millions of rows.
    const hasLimit = Array.isArray(statement.limit?.value) && statement.limit.value.length > 0;

    // Injected predicates. A principal's scope (`column = value`) and an as-of
    // cutoff (`column <= value`) are AND-ed into the top-level WHERE, each value
    // bound as a parameter — sqlify does not escape string literals, so a value
    // must never be inlined. Injected after column extraction, so an injected
    // column is not itself subject to the column allow-list. With neither, the
    // original text is returned untouched, preserving lineage fidelity. The
    // parameter array follows placeholder order: scope first, then as-of.
    const params = [];
    const injections = [];
    if (scope) injections.push({ label: 'scope', column: scope.column, operator: '=', value: scope.value });
    if (asOf) injections.push({ label: 'as-of', column: asOf.column, operator: '<=', value: asOf.value });

    let safeSql;
    if (injections.length > 0) {
        for (const injection of injections) {
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(injection.column)) {
                throw new SqlRejected(
                    'bad_scope',
                    `The ${injection.label} column is not a plain identifier: ${injection.column}.`,
                );
            }
            const predicate = {
                type: 'binary_expr',
                operator: injection.operator,
                left: { type: 'column_ref', table: null, column: injection.column },
                right: { type: 'origin', value: '?' },
            };
            statement.where = statement.where
                ? { type: 'binary_expr', operator: 'AND', left: statement.where, right: predicate }
                : predicate;
            params.push(injection.value);
        }
        safeSql = parser.sqlify(statement, { database: 'sqlite' });
        if (!hasLimit) safeSql += `\nLIMIT ${MAX_ROWS}`;
    } else {
        safeSql = hasLimit ? trimmed : `${trimmed}\nLIMIT ${MAX_ROWS}`;
    }

    return {
        sql: safeSql,
        tables: realTables.sort(),
        columns: columnsReferenced.sort(),
        limitInjected: !hasLimit,
        params,
    };
}
