/**
 * LSEG cache retention + licensing-tag governance (finding #7).
 *
 * The warehouse PERSISTS vendor data, so two questions have to have answers before
 * a live LSEG key: is each source TAGGED with its licensing terms (display vs
 * non-display, redistribution), and is any cached value being HELD past its licensed
 * cache window (TTL)? The policy lives in `data_sources` (see lseg-schema.sql); this
 * module reads it against the persisted rows to answer both.
 *
 * - `retentionReport` — per-source: its usage class / TTL / redistribution terms,
 *   how many rows it backs, how many are stale (retained past the TTL), and its
 *   oldest row. It also flags any source that appears in the data with NO policy row
 *   ("untagged") and any policy with no TTL set — the governance gaps.
 * - `purgeExpired` — deletes (or, in a dry run, just counts) rows retained past
 *   their source's TTL, so the cache can be brought back inside its licensed window.
 *
 * These are operational/admin functions: like seed and ingest, they touch the
 * database directly rather than through the model-facing read guard. Nothing here
 * grants a right — it encodes and enforces a policy whose terms must be signed off
 * against the actual LSEG agreement (see db/lseg-licensing.md).
 */

import { DatabaseSync } from 'node:sqlite';
import { LSEG_DB_PATH } from './lseg.js';

/** The tables that persist vendor values and carry a `source` + `retrieved_at`. */
const PERSISTED_TABLES = ['fundamentals', 'prices'];

/** Today as an ISO date — the default "now" staleness is measured against. */
function today() {
    return new Date().toISOString().slice(0, 10);
}

/**
 * A per-source retention + licensing report over the persisted vendor data.
 *
 * @param {object} [params]
 * @param {string} [params.dbPath]
 * @param {string} [params.asOf]   ISO date to measure staleness against (default: today)
 * @returns {{
 *   asOf: string,
 *   sources: Array<{ source: string, usageClass: string|null, retentionDays: number|null,
 *     redistribution: string|null, rows: number, stale: number, oldest: string|null,
 *     tagged: boolean, ttlSet: boolean }>,
 *   untagged: string[], missingTtl: string[], staleTotal: number, ok: boolean,
 * }}
 */
export function retentionReport({ dbPath = LSEG_DB_PATH, asOf = today() } = {}) {
    const db = new DatabaseSync(dbPath);
    try {
        const policy = new Map(
            db.prepare('SELECT source, usage_class, retention_days, redistribution FROM data_sources').all()
                .map((r) => [r.source, r]),
        );

        // Every source that actually appears in the persisted data, across tables.
        const present = new Set();
        const rowCount = new Map();
        const oldest = new Map();
        for (const table of PERSISTED_TABLES) {
            for (const r of db.prepare(`SELECT source, COUNT(*) n, MIN(retrieved_at) oldest FROM ${table} GROUP BY source`).all()) {
                present.add(r.source);
                rowCount.set(r.source, (rowCount.get(r.source) ?? 0) + r.n);
                const prev = oldest.get(r.source);
                if (!prev || r.oldest < prev) oldest.set(r.source, r.oldest);
            }
        }

        const sources = [];
        const untagged = [];
        const missingTtl = [];
        let staleTotal = 0;
        for (const source of [...present].sort()) {
            const p = policy.get(source) ?? null;
            const retentionDays = p?.retention_days ?? null;
            // Stale = retained past the TTL. Only computable when a TTL is set;
            // date(asOf, '-<n> days') is the cutoff, rows older than it are stale.
            let stale = 0;
            if (retentionDays != null) {
                const modifier = `-${retentionDays} days`;
                for (const table of PERSISTED_TABLES) {
                    stale += db.prepare(
                        `SELECT COUNT(*) n FROM ${table} WHERE source = ? AND retrieved_at < date(?, ?)`,
                    ).get(source, asOf, modifier).n;
                }
            }
            staleTotal += stale;
            const tagged = p != null;
            const ttlSet = retentionDays != null;
            if (!tagged) untagged.push(source);
            if (tagged && !ttlSet) missingTtl.push(source);
            sources.push({
                source,
                usageClass: p?.usage_class ?? null,
                retentionDays,
                redistribution: p?.redistribution ?? null,
                rows: rowCount.get(source) ?? 0,
                stale,
                oldest: oldest.get(source) ?? null,
                tagged,
                ttlSet,
            });
        }

        // Governance is OK when every persisted source is tagged, has a TTL, and no
        // row is being held past it.
        const ok = untagged.length === 0 && missingTtl.length === 0 && staleTotal === 0;
        return { asOf, sources, untagged, missingTtl, staleTotal, ok };
    } finally {
        db.close();
    }
}

/**
 * Purge vendor rows retained past their source's TTL, bringing the cache back
 * inside its licensed window. A source with no TTL set is left untouched (its
 * window is unknown — a gap the report flags, not something to silently delete).
 *
 * @param {object} [params]
 * @param {string} [params.dbPath]
 * @param {string} [params.asOf]     ISO date to measure staleness against (default: today)
 * @param {boolean} [params.dryRun]  when true, count what would be purged without deleting
 * @returns {{ asOf: string, dryRun: boolean, purged: { fundamentals: number, prices: number }, total: number }}
 */
export function purgeExpired({ dbPath = LSEG_DB_PATH, asOf = today(), dryRun = false } = {}) {
    const db = new DatabaseSync(dbPath);
    try {
        db.exec('PRAGMA foreign_keys = ON');
        const ttlBySource = new Map(
            db.prepare('SELECT source, retention_days FROM data_sources WHERE retention_days IS NOT NULL').all()
                .map((r) => [r.source, r.retention_days]),
        );
        const purged = { fundamentals: 0, prices: 0 };
        for (const [source, retentionDays] of ttlBySource) {
            const modifier = `-${retentionDays} days`;
            for (const table of PERSISTED_TABLES) {
                const stale = db.prepare(
                    `SELECT COUNT(*) n FROM ${table} WHERE source = ? AND retrieved_at < date(?, ?)`,
                ).get(source, asOf, modifier).n;
                if (stale > 0 && !dryRun) {
                    db.prepare(`DELETE FROM ${table} WHERE source = ? AND retrieved_at < date(?, ?)`).run(source, asOf, modifier);
                }
                purged[table] += stale;
            }
        }
        return { asOf, dryRun, purged, total: purged.fundamentals + purged.prices };
    } finally {
        db.close();
    }
}
