/**
 * Lineage — the provenance record attached to every answer.
 *
 * The point of a lineage record is that someone who does not trust the answer
 * can reproduce it. That requires three things: the exact SQL that ran, the
 * relations it read, and a fingerprint of what came back. Given those, an
 * auditor re-runs the query against the same data and compares fingerprints.
 * Same hash, same answer, question closed.
 *
 * The fingerprint is computed over a canonical serialisation rather than
 * whatever `JSON.stringify` happens to emit. Two result sets that are equal as
 * data must hash equally, or the whole mechanism is noise: key order from a
 * driver is not guaranteed stable, and `{a:1,b:2}` and `{b:2,a:1}` are the
 * same row.
 */

import { createHash } from 'node:crypto';

/**
 * Canonically serialise a value: object keys sorted, arrays in order.
 *
 * Row order is preserved rather than sorted — for a query with an ORDER BY,
 * order is part of the answer, and re-running the same SQL against the same
 * data reproduces it.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalize(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
    if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;

    const keys = Object.keys(value).sort();
    const parts = keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`);
    return `{${parts.join(',')}}`;
}

/**
 * SHA-256 of the canonical form, hex encoded.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function fingerprint(value) {
    return createHash('sha256').update(canonicalize(value)).digest('hex');
}

/**
 * Build the provenance record for one executed query.
 *
 * @param {object} params
 * @param {string}   params.question      the natural-language question asked
 * @param {string}   params.sql           the SQL that actually executed
 * @param {string[]} params.tables        relations read
 * @param {object[]} params.rows          the result set
 * @param {boolean}  params.limitInjected whether the guard added a LIMIT
 * @param {string}   [params.model]       model that generated the SQL
 * @param {string}   [params.actor]       who asked
 * @returns {object}
 */
export function buildLineage({
    question,
    sql,
    tables,
    rows,
    limitInjected,
    model = null,
    actor = 'local',
}) {
    const columns = rows.length > 0 ? Object.keys(rows[0]).sort() : [];

    return {
        question,
        sql,
        tables: [...tables].sort(),
        columns,
        rowCount: rows.length,
        resultHash: fingerprint(rows),
        limitInjected,
        model,
        actor,
        // The LLM's authority stops at SQL generation. Recording that as a
        // field, rather than as a sentence in a README, means the audit
        // export carries the claim and an auditor can filter on it.
        llmScope: 'sql_generation_only',
        dataModified: false,
        at: new Date().toISOString(),
    };
}
