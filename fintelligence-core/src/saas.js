/**
 * Canonical, credential-free queries over the SaaS-finance warehouse.
 *
 * The SaaS path is normally model-driven (`ask.js` has the planner write the
 * SQL). A control, though, needs a *blessed* query it can attest without an API
 * call and reproduce byte-for-byte — the same pattern markets.js and enron.js
 * already follow for their scenarios. This module is where those canonical SaaS
 * queries live, starting with the MRR reconciliation the PI control resolves to.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { guard } from './guard.js';
import { buildLineage } from './lineage.js';
import { append } from './audit.js';
import { SqliteWarehouse } from './warehouse.js';
import { DEFAULT_DB_PATH } from './db.js';

const here = dirname(fileURLToPath(import.meta.url));
export const SAAS_DB_PATH = DEFAULT_DB_PATH;
export const SAAS_LOG_PATH = join(here, '..', 'db', 'saas-audit.jsonl');

/**
 * Reconcile current MRR two independent ways, in one attested statement:
 *
 *   - the movements *ledger*: SUM over mrr_movements (the append-only record);
 *   - the current-state *subscriptions* table (active base MRR) plus the
 *     expansion/contraction adjustments the ledger records.
 *
 * On clean data these tie out exactly. Editing a subscription's MRR, or an
 * expansion movement, without its counterpart breaks the tie — which is the
 * whole point of a reconciliation control: the two sources are meant to be
 * derivable from each other, and a divergence is an exception a single figure
 * would never reveal.
 *
 * (There is no SaaS "filed" anchor to reconcile against the way the Enron
 * warehouse has a 10-K — so the two independent internal representations are the
 * honest thing to check here.)
 *
 * @param {object} [params]
 * @param {string} [params.dbPath]
 * @param {string} [params.logPath]
 * @param {object|null} [params.signer]
 * @param {{ query: Function }} [params.warehouse]
 * @returns {{ rows: object[], lineage: object, entry: object }}
 */
export function reconcileMrr({
    dbPath = SAAS_DB_PATH,
    logPath = SAAS_LOG_PATH,
    signer = null,
    warehouse = new SqliteWarehouse(dbPath),
} = {}) {
    const sql =
        'SELECT ' +
        '(SELECT SUM(amount_cents) FROM mrr_movements) AS ledger_mrr_cents, ' +
        '(SELECT SUM(mrr_cents) FROM subscriptions WHERE canceled_at IS NULL) ' +
        "+ (SELECT SUM(amount_cents) FROM mrr_movements WHERE movement IN ('expansion', 'contraction')) " +
        'AS reconstructed_mrr_cents';
    const guarded = guard(sql); // no options → SaaS allow-list, no column list
    const rows = warehouse.query(guarded.sql, { params: [] });

    const lineage = buildLineage({
        question: 'Current MRR reconciled: movements ledger versus active subscriptions plus recorded adjustments',
        sql: guarded.sql,
        tables: guarded.tables,
        rows,
        limitInjected: guarded.limitInjected,
    });
    const entry = append({ ...lineage, scenario: 'mrr_reconciliation' }, {
        path: logPath,
        complianceTags: ['reconciliation', 'processing-integrity', 'reproducible'],
        signer,
    });
    return { rows, lineage, entry };
}
