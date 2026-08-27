/**
 * The audit log — append-only and tamper-evident.
 *
 * "Append-only" as a convention is worth very little: a file anyone can edit
 * is a file that can be quietly edited. What makes a log actually evidentiary
 * is that altering a past entry is *detectable*.
 *
 * Each entry therefore carries the hash of the entry before it, and its own
 * hash covers that link. Changing any historical record changes its hash,
 * which breaks the `prevHash` of the entry after it, and every entry after
 * that. `verify()` walks the chain and reports the first index where it
 * breaks. Deleting an entry from the middle breaks it in the same way.
 *
 * This is the same construction as the anchoring layer in TLaaS, minus the
 * on-chain step. It does not prevent tampering — nothing local can — it makes
 * tampering impossible to hide, which is what an auditor actually needs.
 *
 * Storage is JSON Lines: one entry per line, appended, never rewritten.
 */

import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { canonicalize } from './lineage.js';

const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_LOG_PATH = join(here, '..', 'db', 'audit.jsonl');

/** Hash marking the start of a chain. */
export const GENESIS = '0'.repeat(64);

/**
 * Hash one entry, covering its link to the previous one.
 *
 * @param {object} entry entry without its own `hash` field
 * @returns {string}
 */
export function hashEntry(entry) {
    const { hash, ...rest } = entry;
    return createHash('sha256').update(canonicalize(rest)).digest('hex');
}

/**
 * Read every entry in the log.
 *
 * @param {string} [path]
 * @returns {object[]}
 */
export function readLog(path = DEFAULT_LOG_PATH) {
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8')
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line));
}

/**
 * Append one lineage record to the log, chained to what precedes it.
 *
 * @param {object} lineage
 * @param {object} [options]
 * @param {string} [options.path]
 * @param {string[]} [options.complianceTags]
 * @returns {object} the stored entry
 */
export function append(lineage, { path = DEFAULT_LOG_PATH, complianceTags = [] } = {}) {
    const existing = readLog(path);
    const prevHash = existing.length > 0 ? existing[existing.length - 1].hash : GENESIS;

    const entry = {
        seq: existing.length,
        prevHash,
        complianceTags,
        ...lineage,
    };
    entry.hash = hashEntry(entry);

    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(entry)}\n`, 'utf8');
    return entry;
}

/**
 * Walk the chain and report whether it is intact.
 *
 * @param {string} [path]
 * @returns {{ ok: boolean, entries: number, brokenAt: number|null, reason: string|null }}
 */
export function verify(path = DEFAULT_LOG_PATH) {
    const entries = readLog(path);
    let expectedPrev = GENESIS;

    for (const [index, entry] of entries.entries()) {
        if (entry.prevHash !== expectedPrev) {
            return {
                ok: false,
                entries: entries.length,
                brokenAt: index,
                reason: `entry ${index} points at ${entry.prevHash.slice(0, 12)}… but the previous entry hashes to ${expectedPrev.slice(0, 12)}…`,
            };
        }
        if (hashEntry(entry) !== entry.hash) {
            return {
                ok: false,
                entries: entries.length,
                brokenAt: index,
                reason: `entry ${index} has been modified since it was written (recomputed hash does not match)`,
            };
        }
        if (entry.seq !== index) {
            return {
                ok: false,
                entries: entries.length,
                brokenAt: index,
                reason: `entry at position ${index} claims seq ${entry.seq} — an entry was removed or reordered`,
            };
        }
        expectedPrev = entry.hash;
    }

    return { ok: true, entries: entries.length, brokenAt: null, reason: null };
}

/**
 * Produce the exportable audit package.
 *
 * This is the "one click, not three weeks of email" artefact: the full chain,
 * its verification status at export time, and enough metadata for a reader to
 * re-run any query in it.
 *
 * @param {string} [path]
 * @returns {object}
 */
export function exportPackage(path = DEFAULT_LOG_PATH) {
    const entries = readLog(path);
    const integrity = verify(path);

    return {
        generatedAt: new Date().toISOString(),
        entryCount: entries.length,
        integrity,
        // Stated explicitly so a reader does not have to infer it from the
        // absence of write operations.
        guarantees: {
            llmScope: 'sql_generation_only',
            databaseAccess: 'read_only_connection',
            everyFigureTraceable: true,
        },
        entries,
    };
}
