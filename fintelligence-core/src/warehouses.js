/**
 * Warehouse descriptors — the single place that knows, for each warehouse, where
 * it lives, what the guard allow-lists, which audit log it appends to, its metric
 * registry, and a plain-language description.
 *
 * Two consumers read these. The MCP server injects a warehouse's schema into a
 * host AI's context from here, so the model discovers the real table/column shape
 * instead of a hardcoded copy. And the future warehouse router (M9 backlog) will
 * read the same descriptors to infer a warehouse from a question. Deliberately
 * data, not behaviour.
 */

import { openReadOnly, DEFAULT_DB_PATH } from './db.js';
import { ALLOWED_TABLES } from './guard.js';
import { SAAS_LOG_PATH } from './saas.js';
import {
    MARKETS_DB_PATH,
    MARKETS_LOG_PATH,
    MARKETS_ALLOWED_TABLES,
    MARKETS_ALLOWED_COLUMNS,
    MARKETS_REGISTRY,
} from './markets.js';
import {
    ENRON_DB_PATH,
    ENRON_LOG_PATH,
    ENRON_ALLOWED_TABLES,
    ENRON_ALLOWED_COLUMNS,
    ENRON_REGISTRY,
} from './enron.js';
import {
    LSEG_DB_PATH,
    LSEG_LOG_PATH,
    LSEG_ALLOWED_TABLES,
    LSEG_ALLOWED_COLUMNS,
    LSEG_REGISTRY,
} from './lseg.js';

/**
 * @returns {Record<string, {
 *   name: string, description: string, dbPath: string, logPath: string,
 *   allowedTables: readonly string[], allowedColumns: object|null,
 *   freeText: boolean, metrics: object[]
 * }>}
 */
export function warehouseDescriptors() {
    return {
        saas: {
            name: 'saas',
            description:
                'SaaS finance: MRR, retention, LTV:CAC and cohort questions. Free-text questions are supported here (the planner writes the SQL).',
            dbPath: DEFAULT_DB_PATH,
            logPath: SAAS_LOG_PATH,
            allowedTables: ALLOWED_TABLES,
            allowedColumns: null,
            freeText: true,
            metrics: [],
        },
        markets: {
            name: 'markets',
            description:
                'Capital-markets surveillance: orders, executions, positions, prices. Canonical queries only.',
            dbPath: MARKETS_DB_PATH,
            logPath: MARKETS_LOG_PATH,
            allowedTables: MARKETS_ALLOWED_TABLES,
            allowedColumns: MARKETS_ALLOWED_COLUMNS,
            freeText: false,
            metrics: MARKETS_REGISTRY.list(),
        },
        enron: {
            name: 'enron',
            description:
                'Synthetic Enron reporting-gap POC: entities, revenue, debt, and the filed 10-K figures (USD millions). Canonical queries only.',
            dbPath: ENRON_DB_PATH,
            logPath: ENRON_LOG_PATH,
            allowedTables: ENRON_ALLOWED_TABLES,
            allowedColumns: ENRON_ALLOWED_COLUMNS,
            freeText: false,
            metrics: ENRON_REGISTRY.list(),
        },
        lseg: {
            name: 'lseg',
            description:
                'LSEG company fundamentals by TR.* field code (instruments, field dictionary, fundamentals). ' +
                'Real RICs and field codes, synthetic values; snapshot landed via the ingest seam. Canonical queries only.',
            dbPath: LSEG_DB_PATH,
            logPath: LSEG_LOG_PATH,
            allowedTables: LSEG_ALLOWED_TABLES,
            allowedColumns: LSEG_ALLOWED_COLUMNS,
            freeText: false,
            metrics: LSEG_REGISTRY.list(),
        },
    };
}

/**
 * Resolve a warehouse descriptor by name, or throw.
 * @param {string} name
 */
export function getWarehouse(name) {
    const descriptor = warehouseDescriptors()[name];
    if (!descriptor) {
        throw new Error(
            `Unknown warehouse "${name}". Known: ${Object.keys(warehouseDescriptors()).join(', ')}.`,
        );
    }
    return descriptor;
}

/**
 * The live schema for a warehouse: for each allow-listed table, its columns and
 * declared types, read from the database with PRAGMA and filtered to the columns
 * the guard permits — so an AI sees the real, permitted shape, never more.
 *
 * @param {string} name
 * @param {object} [options]
 * @param {string} [options.dbPath] override the descriptor's path (for tests)
 * @returns {object}
 */
export function warehouseSchema(name, { dbPath } = {}) {
    const descriptor = getWarehouse(name);
    const db = openReadOnly(dbPath ?? descriptor.dbPath);
    try {
        const tables = descriptor.allowedTables.map((table) => {
            const info = db.prepare(`PRAGMA table_info(${table})`).all();
            const allowed = descriptor.allowedColumns ? new Set(descriptor.allowedColumns[table] ?? []) : null;
            const columns = info
                .filter((c) => !allowed || allowed.has(c.name))
                .map((c) => ({ name: c.name, type: c.type || 'ANY' }));
            return { table, columns };
        });
        return {
            warehouse: descriptor.name,
            description: descriptor.description,
            freeText: descriptor.freeText,
            tables,
            allowlist: { tables: [...descriptor.allowedTables], columns: descriptor.allowedColumns },
            metrics: descriptor.metrics.map((m) => ({ name: m.name, description: m.description, unit: m.unit })),
        };
    } finally {
        db.close();
    }
}
