/**
 * The capital-markets warehouse and its scenarios — the flagship demo.
 *
 * The SaaS demo shows the engine works. This shows it where it matters: trade
 * surveillance and position attestation, the setting the whole "a number you
 * can hand a regulator" thesis was written for (think MAR / MiFID II market-
 * abuse surveillance, CAT / MiFIR reporting data quality, best-execution).
 *
 * Nothing here replaces the SaaS path. The guard is simply pointed at a
 * different warehouse and allow-list — the same boundary, a different domain —
 * which is exactly the parameterisation the connector work in M5 generalises.
 *
 * The data is synthetic and deterministic: a fixed seed produces byte-identical
 * rows, so every result hash in the demo is reproducible. Two accounts are
 * seeded to exhibit a rapid place-and-cancel pattern (the shape spoofing and
 * layering leave in the order book); the rest trade normally.
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { guard } from './guard.js';
import { buildLineage } from './lineage.js';
import { append } from './audit.js';
import { marketsRegistry } from './registry.js';
import { SqliteWarehouse } from './warehouse.js';
import { scopeForPrincipal } from './auth.js';

const here = dirname(fileURLToPath(import.meta.url));
export const MARKETS_SCHEMA_PATH = join(here, '..', 'db', 'markets-schema.sql');
export const MARKETS_DB_PATH = join(here, '..', 'db', 'markets.db');
export const MARKETS_LOG_PATH = join(here, '..', 'db', 'markets-audit.jsonl');

/** The single trading session the warehouse covers. */
export const TRADING_DATE = '2026-03-02';
/** 09:30 and 16:00 US/Eastern for that date, as epoch ms (EST, UTC-5). */
export const OPEN_MS = Date.UTC(2026, 2, 2, 14, 30, 0);
export const CLOSE_MS = Date.UTC(2026, 2, 2, 21, 0, 0);

/** Tables a markets query may read. */
export const MARKETS_ALLOWED_TABLES = Object.freeze([
    'accounts',
    'orders',
    'executions',
    'prices',
    'positions',
]);

/** Column-level allow-list for the markets warehouse. */
export const MARKETS_ALLOWED_COLUMNS = Object.freeze({
    accounts: ['id', 'name', 'desk', 'country'],
    orders: ['id', 'account_id', 'ticker', 'side', 'qty', 'limit_price_cents', 'placed_at_ms', 'canceled_at_ms', 'status'],
    executions: ['id', 'order_id', 'account_id', 'ticker', 'side', 'qty', 'price_cents', 'executed_at_ms'],
    prices: ['ticker', 'date', 'close_cents'],
    positions: ['account_id', 'ticker', 'date', 'net_qty', 'avg_cost_cents'],
});

/**
 * The canonical metric layer, now sourced from the first-class registry so
 * there is a single definition of each metric. These are code-controlled
 * expressions, not user input, so interpolating them into a query is safe; the
 * guard still validates the assembled statement.
 */
export const MARKETS_REGISTRY = marketsRegistry();
export const MARKETS_METRICS = Object.freeze(
    Object.fromEntries(MARKETS_REGISTRY.list().map((metric) => [metric.name, metric])),
);

/** Reference close prices (cents) for the seeded tickers. */
const TICKERS = [
    { ticker: 'ACME', ref_cents: 4_200 },
    { ticker: 'BOLT', ref_cents: 15_750 },
    { ticker: 'CRUX', ref_cents: 990 },
    { ticker: 'DYNE', ref_cents: 32_100 },
];

const ACCOUNTS = [
    { id: 1, name: 'Northwind Capital', desk: 'Equity Long/Short', country: 'US', profile: 'normal' },
    { id: 2, name: 'Cedar Fund', desk: 'Equity Long/Short', country: 'US', profile: 'normal' },
    { id: 3, name: 'Meridian HFT', desk: 'Market Making', country: 'GB', profile: 'spoofer' },
    { id: 4, name: 'Vantage Systematic', desk: 'Stat Arb', country: 'DE', profile: 'spoofer' },
    { id: 5, name: 'Harbor Pension', desk: 'Long Only', country: 'US', profile: 'normal' },
    { id: 6, name: 'Kestrel Trading', desk: 'Prop', country: 'SG', profile: 'slow_cancel' },
];

/** mulberry32 — the same deterministic PRNG the SaaS seed uses. */
function mulberry32(seed) {
    let a = seed >>> 0;
    return function next() {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * Build the markets warehouse: schema plus deterministic synthetic activity.
 *
 * @param {string} [path]
 * @returns {{ accounts: number, orders: number, executions: number }}
 */
export function seedMarkets(path = MARKETS_DB_PATH) {
    const db = new DatabaseSync(path);
    db.exec('PRAGMA foreign_keys = ON');
    for (const table of ['positions', 'prices', 'executions', 'orders', 'accounts']) {
        db.exec(`DROP TABLE IF EXISTS ${table}`);
    }
    db.exec(readFileSync(MARKETS_SCHEMA_PATH, 'utf8'));

    const rand = mulberry32(0x0ff1ce);
    const jitter = (span) => Math.floor(rand() * span);
    const qty = () => (1 + Math.floor(rand() * 10)) * 100; // 100..1000 shares

    const insertAccount = db.prepare('INSERT INTO accounts (id, name, desk, country) VALUES (?,?,?,?)');
    const insertOrder = db.prepare(
        'INSERT INTO orders (id, account_id, ticker, side, qty, limit_price_cents, placed_at_ms, canceled_at_ms, status) VALUES (?,?,?,?,?,?,?,?,?)',
    );
    const insertExec = db.prepare(
        'INSERT INTO executions (id, order_id, account_id, ticker, side, qty, price_cents, executed_at_ms) VALUES (?,?,?,?,?,?,?,?)',
    );
    const insertPrice = db.prepare('INSERT INTO prices (ticker, date, close_cents) VALUES (?,?,?)');
    const insertPosition = db.prepare(
        'INSERT INTO positions (account_id, ticker, date, net_qty, avg_cost_cents) VALUES (?,?,?,?,?)',
    );

    for (const account of ACCOUNTS) insertAccount.run(account.id, account.name, account.desk, account.country);
    for (const [i, t] of TICKERS.entries()) insertPrice.run(t.ticker, TRADING_DATE, t.ref_cents + (i + 1) * 5);

    // Fixed activity counts per profile, so the flagged set is exact and the
    // demo tells the same story on every machine.
    const FILLS = { normal: 4, spoofer: 2, slow_cancel: 3 };
    const RAPID_CANCELS = { normal: 0, spoofer: 6, slow_cancel: 0 };
    const SLOW_CANCELS = { normal: 1, spoofer: 0, slow_cancel: 2 };

    let orderId = 0;
    let execId = 0;
    let tickerCursor = 0;
    // Running signed position and cost, per account+ticker, to seed `positions`
    // so it reconciles with the executions exactly.
    const book = new Map();

    for (const account of ACCOUNTS) {
        // Genuine fills.
        for (let f = 0; f < FILLS[account.profile]; f += 1) {
            const t = TICKERS[tickerCursor % TICKERS.length];
            tickerCursor += 1;
            const side = f % 2 === 0 ? 'buy' : 'sell';
            const shares = qty();
            const price = t.ref_cents - 25 + jitter(50);
            const placed = OPEN_MS + jitter(CLOSE_MS - OPEN_MS - 60_000);
            const executed = placed + 200 + jitter(3_000);

            orderId += 1;
            insertOrder.run(orderId, account.id, t.ticker, side, shares, price, placed, null, 'filled');
            execId += 1;
            insertExec.run(execId, orderId, account.id, t.ticker, side, shares, price, executed);

            const key = `${account.id}:${t.ticker}`;
            const prior = book.get(key) ?? { net: 0, costNumer: 0, costDenom: 0 };
            prior.net += side === 'buy' ? shares : -shares;
            prior.costNumer += shares * price;
            prior.costDenom += shares;
            book.set(key, prior);
        }

        // Rapid place-and-cancel: the spoofing / layering signature. Large
        // resting orders pulled within a second or so of being placed.
        for (let c = 0; c < RAPID_CANCELS[account.profile]; c += 1) {
            const t = TICKERS[tickerCursor % TICKERS.length];
            tickerCursor += 1;
            const side = c % 2 === 0 ? 'sell' : 'buy';
            const placed = OPEN_MS + jitter(CLOSE_MS - OPEN_MS - 60_000);
            const canceled = placed + 300 + jitter(1_200); // 300..1500ms, well under 2s
            orderId += 1;
            insertOrder.run(orderId, account.id, t.ticker, side, qty() * 8, t.ref_cents, placed, canceled, 'canceled');
        }

        // Slow, ordinary cancels — a changed mind, not abuse. Far outside the
        // surveillance window, so they must not be flagged.
        for (let s = 0; s < SLOW_CANCELS[account.profile]; s += 1) {
            const t = TICKERS[tickerCursor % TICKERS.length];
            tickerCursor += 1;
            const placed = OPEN_MS + jitter(CLOSE_MS - OPEN_MS - 120_000);
            const canceled = placed + 20_000 + jitter(40_000); // 20..60s
            orderId += 1;
            insertOrder.run(orderId, account.id, t.ticker, 'buy', qty(), t.ref_cents, placed, canceled, 'canceled');
        }
    }

    for (const [key, agg] of book.entries()) {
        const [accountId, ticker] = key.split(':');
        const avgCost = agg.costDenom === 0 ? 0 : Math.round(agg.costNumer / agg.costDenom);
        insertPosition.run(Number(accountId), ticker, TRADING_DATE, agg.net, avgCost);
    }

    db.close();
    return { accounts: ACCOUNTS.length, orders: orderId, executions: execId };
}

/** Options common to the scenario runners. */
const guardOptions = { allowedTables: MARKETS_ALLOWED_TABLES, allowedColumns: MARKETS_ALLOWED_COLUMNS };

/**
 * Scenario 1 — net position in a ticker as of market close.
 *
 * Uses the as-of hook (executed_at_ms <= close) so the figure is pinned to a
 * point in time, and the canonical net_position metric so it is computed one
 * way. Records lineage and appends a (optionally signed) audit entry.
 *
 * A principal, when supplied, confines the result to that principal's book via
 * the guard's scope hook: a trader sees only their own account, a supervisor
 * (null scope) sees the whole book.
 *
 * @param {object} params
 * @param {string} params.ticker
 * @param {number} [params.asOfMs]
 * @param {string} [params.dbPath]
 * @param {string} [params.logPath]
 * @param {object|null} [params.signer]
 * @param {import('./auth.js').Principal|null} [params.principal]
 * @param {{ query: Function }} [params.warehouse]
 * @returns {{ rows: object[], lineage: object, entry: object }}
 */
export function netPositionAtClose({
    ticker,
    asOfMs = CLOSE_MS,
    dbPath = MARKETS_DB_PATH,
    logPath = MARKETS_LOG_PATH,
    signer = null,
    principal = null,
    warehouse = new SqliteWarehouse(dbPath),
}) {
    const scope = principal ? scopeForPrincipal(principal) : null;
    const baseSql =
        `SELECT account_id, ticker, ${MARKETS_REGISTRY.resolve('net_position').sql} AS net_qty ` +
        'FROM executions WHERE ticker = ? GROUP BY account_id, ticker ORDER BY account_id';
    const guarded = guard(baseSql, {
        ...guardOptions,
        scope,
        asOf: { column: 'executed_at_ms', value: asOfMs },
    });

    // The query's own ticker parameter comes first in the text; the guard's
    // injected parameters (scope, then as-of) follow in that order.
    const rows = warehouse.query(guarded.sql, { params: [ticker, ...guarded.params] });

    const lineage = buildLineage({
        question: `Net position in ${ticker} as of ${new Date(asOfMs).toISOString()}`,
        sql: guarded.sql,
        tables: guarded.tables,
        rows,
        limitInjected: guarded.limitInjected,
        asOf: { column: 'executed_at_ms', value: asOfMs },
    });
    const entry = append({ ...lineage, scenario: 'net_position_at_close' }, {
        path: logPath,
        complianceTags: ['MiFID II: position', 'reproducible'],
        signer,
    });
    return { rows, lineage, entry };
}

/**
 * Scenario 2 — market-abuse surveillance: accounts that cancel at least
 * `minCancels` orders within `windowMs` of placing them. Produces an alert set,
 * its provenance, and an immutable log entry.
 *
 * @param {object} [params]
 * @param {number} [params.windowMs]
 * @param {number} [params.minCancels]
 * @param {string} [params.dbPath]
 * @param {string} [params.logPath]
 * @param {object|null} [params.signer]
 * @param {import('./auth.js').Principal|null} [params.principal]
 * @param {{ query: Function }} [params.warehouse]
 * @returns {{ rows: object[], lineage: object, entry: object }}
 */
export function surveillanceRapidCancels({
    windowMs = 2_000,
    minCancels = 3,
    dbPath = MARKETS_DB_PATH,
    logPath = MARKETS_LOG_PATH,
    signer = null,
    principal = null,
    warehouse = new SqliteWarehouse(dbPath),
} = {}) {
    const scope = principal ? scopeForPrincipal(principal) : null;

    // The window and threshold are code-controlled integers, so they are
    // inlined rather than bound. This keeps the only bound parameter the
    // guard-injected scope: mixing the query's own placeholders with an
    // injected one whose position falls between them (the WHERE predicate lands
    // before the HAVING threshold) would break positional binding.
    const window = Number(windowMs);
    const threshold = Number(minCancels);
    if (!Number.isInteger(window) || !Number.isInteger(threshold)) {
        throw new Error('surveillance thresholds must be integers');
    }
    const sql =
        'SELECT account_id, COUNT(*) AS rapid_cancels ' +
        'FROM orders ' +
        `WHERE canceled_at_ms IS NOT NULL AND (canceled_at_ms - placed_at_ms) <= ${window} ` +
        `GROUP BY account_id HAVING COUNT(*) >= ${threshold} ORDER BY rapid_cancels DESC, account_id`;
    const guarded = guard(sql, { ...guardOptions, scope });

    const rows = warehouse.query(guarded.sql, { params: guarded.params });

    const lineage = buildLineage({
        question: `Accounts with >= ${minCancels} cancellations within ${windowMs}ms of placement`,
        sql: guarded.sql,
        tables: guarded.tables,
        rows,
        limitInjected: guarded.limitInjected,
    });
    const entry = append({ ...lineage, scenario: 'surveillance_rapid_cancels', alertCount: rows.length }, {
        path: logPath,
        complianceTags: ['MAR: market abuse', 'surveillance'],
        signer,
    });
    return { rows, lineage, entry };
}

/**
 * Reconciliation query — the net position in a ticker derived from the execution
 * ledger versus the independently stored end-of-day positions snapshot, in one
 * attested statement. A processing-integrity control passes only when the two
 * tie out; a divergence means the derived book and the recorded book disagree.
 *
 * @param {object} [params]
 * @param {string} [params.ticker]
 * @param {string} [params.tradingDate]
 * @param {string} [params.dbPath]
 * @param {string} [params.logPath]
 * @param {object|null} [params.signer]
 * @param {{ query: Function }} [params.warehouse]
 * @returns {{ rows: object[], lineage: object, entry: object }}
 */
export function reconcileNetPosition({
    ticker = 'ACME',
    tradingDate = TRADING_DATE,
    dbPath = MARKETS_DB_PATH,
    logPath = MARKETS_LOG_PATH,
    signer = null,
    warehouse = new SqliteWarehouse(dbPath),
} = {}) {
    const t = String(ticker).toUpperCase();
    const sql =
        'SELECT ' +
        `(SELECT ${MARKETS_REGISTRY.resolve('net_position').sql} FROM executions WHERE ticker = ?) AS derived_net_qty, ` +
        '(SELECT SUM(net_qty) FROM positions WHERE ticker = ? AND date = ?) AS snapshot_net_qty';
    const guarded = guard(sql, guardOptions);
    const rows = warehouse.query(guarded.sql, { params: [t, t, tradingDate] });

    const lineage = buildLineage({
        question: `Net position in ${t} at ${tradingDate}: derived from executions reconciled to the positions snapshot`,
        sql: guarded.sql,
        tables: guarded.tables,
        rows,
        limitInjected: guarded.limitInjected,
    });
    const entry = append({ ...lineage, scenario: 'position_reconciliation', ticker: t }, {
        path: logPath,
        complianceTags: ['reconciliation', 'MiFID II: position', 'reproducible'],
        signer,
    });
    return { rows, lineage, entry };
}
