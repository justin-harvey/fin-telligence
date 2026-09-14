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
import { reconcileReportedDebt } from './enron.js';

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
    return [
        {
            id: 'PI1.2-enron-debt-reconciliation',
            criterion: 'Processing Integrity (PI1.2) — reported figures reconcile to source records',
            warehouse: 'enron',
            description:
                'Reported debt computed from the ledger ties out to the figure as filed in the 10-K.',
            run(options = {}) {
                const { rows, lineage, entry } = reconcileReportedDebt(options);
                const r = rows[0] ?? {};
                const ledger = Number(r.ledger_reported_usd_millions);
                const filed = Number(r.filed_reported_usd_millions);
                const variance = ledger - filed;
                const status = variance === 0 ? CONTROL_STATUS.PASS : CONTROL_STATUS.EXCEPTION;

                const control = controlResult({
                    controlId: 'PI1.2',
                    criterion: this.criterion,
                    description: this.description,
                    status,
                    exception:
                        status === CONTROL_STATUS.EXCEPTION
                            ? `ledger-computed reported debt $${ledger}m does not tie to the filed $${filed}m ` +
                              `(variance $${variance}m)`
                            : null,
                    figures: [
                        { label: 'Reported debt (from ledger)', value: ledger, unit: 'usd_millions' },
                        { label: 'Reported debt (as filed, 10-K)', value: filed, unit: 'usd_millions' },
                        { label: 'Variance', value: variance, unit: 'usd_millions' },
                    ],
                });
                return { control, entry, rows, lineage };
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
