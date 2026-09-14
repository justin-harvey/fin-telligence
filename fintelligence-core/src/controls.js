/**
 * The control catalog — the layer that turns a query into a SOC 2 control.
 *
 * A scenario answers a question and returns a figure. A *control* asserts
 * something about that figure and reports PASS or EXCEPTION, then hands back
 * everything an evidence packet needs. The catalog is where each button in the
 * SOC 2 panel is defined: a stable id, the Trust Services criterion it evidences,
 * the warehouse it reads, and a `run()` that executes the blessed query and
 * evaluates the result the one agreed way.
 *
 * This is the first-class object the M9 buttons resolve against — a sibling to
 * the metric registry, but for controls. It is deliberately small and additive:
 * each control reuses the existing, guarded, grounded, audited query functions;
 * nothing here reaches the database except through them.
 *
 * Claim discipline: a PASS means "this figure was computed one blessed way, its
 * assertion held, and its provenance verifies," never "this control is
 * certified." The catalog produces evidence; certification is a CPA firm's job.
 */

import { CONTROL_STATUS, controlResult } from './evidence.js';
import { verify } from './audit.js';
import { reconcileReportedDebt, reconcileReportedRevenue } from './enron.js';
import { reconcileMrr } from './saas.js';
import { netPositionAtClose, reconcileNetPosition, MARKETS_LOG_PATH } from './markets.js';

/**
 * Shared shape for a reconciliation control: run a query that returns two
 * figures that must be equal, and turn the comparison into a control result.
 * Keeps every reconciliation control asserting the same way.
 *
 * @param {object} params
 * @param {string} params.controlId
 * @param {string} params.criterion
 * @param {string} params.description
 * @param {{ rows: object[], entry: object, lineage: object }} params.run  the executed query
 * @param {string} params.leftKey   column holding the first figure
 * @param {string} params.rightKey  column holding the second figure
 * @param {string} params.leftLabel
 * @param {string} params.rightLabel
 * @param {string} params.unit
 * @param {(v: number) => string} [params.fmt]  how to render a figure in the exception text
 * @returns {{ control: object, entry: object, rows: object[], lineage: object }}
 */
function reconciliation({
    controlId,
    criterion,
    description,
    run,
    leftKey,
    rightKey,
    leftLabel,
    rightLabel,
    unit,
    fmt = (v) => String(v),
}) {
    const { rows, entry, lineage } = run;
    const r = rows[0] ?? {};
    const left = Number(r[leftKey]);
    const right = Number(r[rightKey]);
    const variance = left - right;
    const status = variance === 0 ? CONTROL_STATUS.PASS : CONTROL_STATUS.EXCEPTION;

    const control = controlResult({
        controlId,
        criterion,
        description,
        status,
        exception:
            status === CONTROL_STATUS.EXCEPTION
                ? `${leftLabel} (${fmt(left)}) does not tie to ${rightLabel} (${fmt(right)}); variance ${fmt(variance)}`
                : null,
        figures: [
            { label: leftLabel, value: left, unit },
            { label: rightLabel, value: right, unit },
            { label: 'Variance', value: variance, unit },
        ],
    });
    return { control, entry, rows, lineage };
}

/**
 * @typedef {object} ControlDefinition
 * @property {string} id          stable identifier (the button id)
 * @property {string} criterion   the Trust Services criterion evidenced
 * @property {string} warehouse   which warehouse the control reads
 * @property {string} description one line, plain enough for a button tooltip
 * @property {(options?: object) => { control: object, entry: object, rows: object[], lineage: object }} run
 */

/**
 * Build the control catalog. Functions, not data, because each control carries
 * its own assertion logic.
 *
 * @returns {ControlDefinition[]}
 */
export function controlCatalog() {
    const usdM = (v) => `$${Number(v).toLocaleString('en-US')}m`;
    const usd = (v) => `$${(Number(v) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
    return [
        {
            id: 'PI1.2-enron-debt-reconciliation',
            criterion: 'Processing Integrity (PI1.2) — reported figures reconcile to source records',
            warehouse: 'enron',
            description: 'Reported debt computed from the ledger ties out to the figure as filed in the 10-K.',
            run(options = {}) {
                return reconciliation({
                    controlId: 'PI1.2',
                    criterion: this.criterion,
                    description: this.description,
                    run: reconcileReportedDebt(options),
                    leftKey: 'ledger_reported_usd_millions',
                    rightKey: 'filed_reported_usd_millions',
                    leftLabel: 'Reported debt (from ledger)',
                    rightLabel: 'Reported debt (as filed, 10-K)',
                    unit: 'usd_millions',
                    fmt: usdM,
                });
            },
        },
        {
            id: 'PI1.1-enron-revenue-reconciliation',
            criterion: 'Processing Integrity (PI1.1) — revenue recognised on the correct basis',
            warehouse: 'enron',
            description: 'Gross revenue booked in the deal ledger ties out to total revenues as filed in the 10-K.',
            run(options = {}) {
                return reconciliation({
                    controlId: 'PI1.1',
                    criterion: this.criterion,
                    description: this.description,
                    run: reconcileReportedRevenue(options),
                    leftKey: 'ledger_gross_usd_millions',
                    rightKey: 'filed_revenue_usd_millions',
                    leftLabel: 'Gross revenue (from ledger)',
                    rightLabel: 'Total revenues (as filed, 10-K)',
                    unit: 'usd_millions',
                    fmt: usdM,
                });
            },
        },
        {
            id: 'PI1.2-saas-mrr-reconciliation',
            criterion: 'Processing Integrity (PI1.2) — MRR reconciles across independent sources',
            warehouse: 'saas',
            description: 'Current MRR from the movements ledger ties out to active subscriptions plus recorded adjustments.',
            run(options = {}) {
                return reconciliation({
                    controlId: 'PI1.2',
                    criterion: this.criterion,
                    description: this.description,
                    run: reconcileMrr(options),
                    leftKey: 'ledger_mrr_cents',
                    rightKey: 'reconstructed_mrr_cents',
                    leftLabel: 'Current MRR (from ledger)',
                    rightLabel: 'Current MRR (subscriptions + adjustments)',
                    unit: 'cents',
                    fmt: usd,
                });
            },
        },
        {
            id: 'PI1.2-markets-position-reconciliation',
            criterion: 'Processing Integrity (PI1.2) — derived positions reconcile to the recorded book',
            warehouse: 'markets',
            description: 'Net position derived from the execution ledger ties out to the end-of-day positions snapshot.',
            run(options = {}) {
                return reconciliation({
                    controlId: 'PI1.2',
                    criterion: this.criterion,
                    description: this.description,
                    run: reconcileNetPosition(options),
                    leftKey: 'derived_net_qty',
                    rightKey: 'snapshot_net_qty',
                    leftLabel: 'Net position (derived from executions)',
                    rightLabel: 'Net position (recorded snapshot)',
                    unit: 'shares',
                    fmt: (v) => `${Number(v).toLocaleString('en-US')} sh`,
                });
            },
        },
        {
            id: 'CC7.3-figure-reproducibility',
            criterion: 'Common Criteria (CC7.3) — a past figure reproduces exactly',
            warehouse: 'markets',
            description: 'Re-running an as-of query reproduces the identical result hash, so an auditor can recompute and compare.',
            run(options = {}) {
                const first = netPositionAtClose({ ticker: 'ACME', ...options });
                const second = netPositionAtClose({ ticker: 'ACME', ...options });
                const same = first.lineage.resultHash === second.lineage.resultHash;
                const control = controlResult({
                    controlId: 'CC7.3',
                    criterion: this.criterion,
                    description: this.description,
                    status: same ? CONTROL_STATUS.PASS : CONTROL_STATUS.EXCEPTION,
                    exception: same
                        ? null
                        : `two runs produced different result hashes (${first.lineage.resultHash.slice(0, 12)}… vs ${second.lineage.resultHash.slice(0, 12)}…)`,
                    figures: [
                        { label: 'Result hash (run 1)', value: first.lineage.resultHash, unit: 'sha256' },
                        { label: 'Result hash (run 2)', value: second.lineage.resultHash, unit: 'sha256' },
                    ],
                });
                return { control, entry: first.entry, rows: first.rows, lineage: first.lineage };
            },
        },
        {
            id: 'CC7.2-audit-chain-integrity',
            criterion: 'Common Criteria (CC7.2) — the audit trail is tamper-evident and intact',
            warehouse: 'audit',
            description: 'The hash-chained audit log verifies end to end; any altered or dropped entry is detected.',
            run(options = {}) {
                const logPath = options.logPath ?? MARKETS_LOG_PATH;
                const integrity = verify(logPath);
                const control = controlResult({
                    controlId: 'CC7.2',
                    criterion: this.criterion,
                    description: this.description,
                    status: integrity.ok ? CONTROL_STATUS.PASS : CONTROL_STATUS.EXCEPTION,
                    exception: integrity.ok ? null : `chain broke at entry ${integrity.brokenAt}: ${integrity.reason}`,
                    figures: [
                        { label: 'Entries in chain', value: integrity.entries, unit: 'count' },
                        { label: 'Chain state', value: integrity.ok ? 'INTACT' : 'BROKEN' },
                    ],
                });
                // A verification control checks an existing chain rather than
                // producing a new attested query, so there is no query entry to
                // package; the chain it verified is itself the evidence.
                return { control, entry: null, rows: [], verification: integrity };
            },
        },
    ];
}

/**
 * Resolve a control by id, or throw — an unknown control is a bug to surface,
 * not a query to invent.
 *
 * @param {string} id
 * @returns {ControlDefinition}
 */
export function getControl(id) {
    const control = controlCatalog().find((c) => c.id === id);
    if (!control) {
        throw new Error(
            `No control registered with id "${id}". Known: ${controlCatalog().map((c) => c.id).join(', ')}.`,
        );
    }
    return control;
}
