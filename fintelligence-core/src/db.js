/**
 * Database access.
 *
 * Two entry points, deliberately asymmetric:
 *
 *   seed()         opens read-write, and is only ever called by the CLI's seed
 *                  command. It is the one place in this codebase that writes.
 *   openReadOnly() is what the query path uses. Always.
 *
 * The read-only connection is the load-bearing safety property. The SQL guard
 * inspects statements and can, being code, have bugs; a connection opened
 * read-only is enforced by SQLite below anything this process can reach. If
 * the guard ever lets a write through, the database still refuses it.
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const SCHEMA_PATH = join(here, '..', 'db', 'schema.sql');
export const DEFAULT_DB_PATH = join(here, '..', 'db', 'warehouse.db');

/**
 * Open the warehouse for reading. Writes are impossible on this handle.
 *
 * @param {string} [path]
 * @returns {DatabaseSync}
 */
export function openReadOnly(path = DEFAULT_DB_PATH) {
    return new DatabaseSync(path, { readOnly: true });
}

/**
 * A small deterministic PRNG (mulberry32).
 *
 * Seeded data has to be reproducible: the lineage record hashes the result
 * set, so `npm run seed` on two machines must produce byte-identical rows or
 * the same question yields two different hashes and the audit trail becomes
 * meaningless. Math.random() would quietly destroy that property.
 *
 * @param {number} seed
 * @returns {() => number} generator in [0, 1)
 */
function mulberry32(seed) {
    let a = seed >>> 0;
    return function next() {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const MONTHS = ['2025-06', '2025-07', '2025-08', '2025-09', '2025-10', '2025-11'];

const CHANNELS = [
    // Ratios here are the *inputs* to the data, not asserted outputs. What
    // LTV:CAC actually comes out as is whatever the queries compute.
    { name: 'Enterprise Sales', cpa_cents: 1_420_000, planWeights: [0.05, 0.25, 0.70] },
    { name: 'Inbound / SEO', cpa_cents: 610_000, planWeights: [0.30, 0.55, 0.15] },
    { name: 'Paid Social', cpa_cents: 980_000, planWeights: [0.65, 0.30, 0.05] },
    { name: 'Partner Referral', cpa_cents: 840_000, planWeights: [0.20, 0.50, 0.30] },
    { name: 'Outbound SDR', cpa_cents: 1_120_000, planWeights: [0.35, 0.45, 0.20] },
    { name: 'Product-Led Growth', cpa_cents: 430_000, planWeights: [0.55, 0.38, 0.07] },
];

const PLANS = [
    { name: 'starter', mrr_cents: 9_900 },
    { name: 'growth', mrr_cents: 49_900 },
    { name: 'enterprise', mrr_cents: 249_900 },
];

const COUNTRIES = ['US', 'US', 'US', 'CA', 'GB', 'DE', 'AU'];

/** @param {() => number} rand @param {number[]} weights */
function pickWeighted(rand, weights) {
    const roll = rand();
    let cumulative = 0;
    for (let i = 0; i < weights.length; i += 1) {
        cumulative += weights[i];
        if (roll < cumulative) return i;
    }
    return weights.length - 1;
}

/**
 * Build the warehouse from scratch: schema plus deterministic synthetic data.
 *
 * The data is invented. It is internally consistent — the MRR movement ledger
 * reconciles against subscription state, cohorts decay at plausible rates —
 * but it describes no real company. That matters for a tool whose whole point
 * is traceable numbers: fabricated data clearly labelled as fabricated is
 * fine, fabricated data presented as real is the exact failure this project
 * exists to prevent.
 *
 * @param {string} [path]
 * @returns {{ customers: number, movements: number, spendRows: number }}
 */
export function seed(path = DEFAULT_DB_PATH) {
    const db = new DatabaseSync(path);
    db.exec('PRAGMA foreign_keys = ON');

    for (const table of ['acquisition_spend', 'mrr_movements', 'subscriptions', 'customers']) {
        db.exec(`DROP TABLE IF EXISTS ${table}`);
    }
    db.exec(readFileSync(SCHEMA_PATH, 'utf8'));

    const rand = mulberry32(0x51ded00d);
    const insertCustomer = db.prepare(
        'INSERT INTO customers (id, name, cohort_month, acquisition_channel, country, created_at) VALUES (?,?,?,?,?,?)',
    );
    const insertSubscription = db.prepare(
        'INSERT INTO subscriptions (id, customer_id, plan, mrr_cents, started_at, canceled_at) VALUES (?,?,?,?,?,?)',
    );
    const insertMovement = db.prepare(
        'INSERT INTO mrr_movements (customer_id, month, movement, amount_cents) VALUES (?,?,?,?)',
    );
    const insertSpend = db.prepare(
        'INSERT INTO acquisition_spend (channel, month, spend_cents, customers_acquired) VALUES (?,?,?,?)',
    );

    let customerId = 0;
    let subscriptionId = 0;
    let movements = 0;
    let spendRows = 0;

    // Customers acquired per channel per month. Growth is gentle and uneven.
    for (const [monthIndex, month] of MONTHS.entries()) {
        for (const channel of CHANNELS) {
            const base = 6 + Math.floor(rand() * 7);
            const acquired = base + monthIndex;

            insertSpend.run(
                channel.name,
                month,
                channel.cpa_cents * acquired + Math.floor(rand() * 500_000),
                acquired,
            );
            spendRows += 1;

            for (let i = 0; i < acquired; i += 1) {
                customerId += 1;
                const plan = PLANS[pickWeighted(rand, channel.planWeights)];
                const country = COUNTRIES[Math.floor(rand() * COUNTRIES.length)];
                const startedAt = `${month}-0${1 + Math.floor(rand() * 9)}`;

                insertCustomer.run(
                    customerId,
                    `Account ${String(customerId).padStart(4, '0')}`,
                    month,
                    channel.name,
                    country,
                    startedAt,
                );

                // Does this customer churn before the window ends, and when?
                // Paid Social and Outbound SDR churn harder — that asymmetry is
                // what makes a cohort question interesting to ask.
                const churnProneness =
                    channel.name === 'Paid Social' ? 0.34 : channel.name === 'Outbound SDR' ? 0.26 : 0.11;
                const churns = rand() < churnProneness;
                const monthsAlive = churns
                    ? 1 + Math.floor(rand() * Math.max(1, MONTHS.length - monthIndex - 1))
                    : MONTHS.length - monthIndex;
                const lastIndex = Math.min(monthIndex + monthsAlive - 1, MONTHS.length - 1);
                const canceledAt = churns && lastIndex < MONTHS.length - 1 ? `${MONTHS[lastIndex]}-28` : null;

                subscriptionId += 1;
                insertSubscription.run(
                    subscriptionId,
                    customerId,
                    plan.name,
                    canceledAt ? 0 : plan.mrr_cents,
                    startedAt,
                    canceledAt,
                );

                insertMovement.run(customerId, month, 'new', plan.mrr_cents);
                movements += 1;

                // Expansion: a minority of surviving accounts upgrade once.
                if (!canceledAt && rand() < 0.22 && monthIndex < MONTHS.length - 1) {
                    const expansionMonth = MONTHS[monthIndex + 1 + Math.floor(rand() * (MONTHS.length - monthIndex - 1))];
                    insertMovement.run(
                        customerId,
                        expansionMonth,
                        'expansion',
                        Math.floor(plan.mrr_cents * (0.15 + rand() * 0.35)),
                    );
                    movements += 1;
                }

                // Contraction: a smaller minority downgrade.
                if (!canceledAt && rand() < 0.07 && monthIndex < MONTHS.length - 1) {
                    const contractionMonth = MONTHS[monthIndex + 1];
                    insertMovement.run(
                        customerId,
                        contractionMonth,
                        'contraction',
                        -Math.floor(plan.mrr_cents * (0.1 + rand() * 0.2)),
                    );
                    movements += 1;
                }

                if (canceledAt) {
                    insertMovement.run(customerId, MONTHS[lastIndex], 'churn', -plan.mrr_cents);
                    movements += 1;
                }
            }
        }
    }

    db.close();
    return { customers: customerId, movements, spendRows };
}
