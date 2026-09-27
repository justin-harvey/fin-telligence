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
import { reconcileGrossProfit, reconcileStandardizedVsAsReported } from './lseg.js';
import { retentionReport } from './lseg-retention.js';

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
 * @param {{ label: string, key: string }[]} [params.requiredPresence]  components
 *   whose presence-count column must be exactly 1 — one datapoint (one vintage)
 *   per component. 0 means absent: the control is N/A, never a false PASS. More
 *   than 1 means duplicated rows (finding #8): the control is an EXCEPTION, because
 *   doubled components can still tie (2·Revenue − 2·Cost = 2·Gross).
 * @param {{ label: string, key: string }[]} [params.consistencyKeys]  columns
 *   holding a DISTINCT-value count that must equal 1 (currency, scale,
 *   periodicity); >1 means the figures are incomparable and the control fails
 *   loudly rather than subtracting across e.g. currencies (FX guard, finding #2).
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
    requiredPresence = null,
    consistencyKeys = null,
}) {
    const { rows, entry, lineage } = run;
    const r = rows[0] ?? {};

    // Integrity gate (finding #8). Each component is one datapoint — one vintage
    // of one field. A count above 1 means duplicated rows (a double-ingest, or a
    // writer that bypassed the vintage key), and the comparison cannot see it:
    // doubling every component keeps Revenue − Cost = Gross, so the figures still
    // tie. Fail loudly rather than PASS on doubled numbers.
    const duplicated = (requiredPresence ?? [])
        .filter(({ key }) => Number(r[key]) > 1)
        .map(({ label, key }) => `${label} ×${Number(r[key])}`);
    if (duplicated.length > 0) {
        const control = controlResult({
            controlId,
            criterion,
            description,
            status: CONTROL_STATUS.EXCEPTION,
            exception:
                `duplicate datapoints: ${duplicated.join(', ')} — expected exactly one row per component; ` +
                'summed duplicates can still tie, so these figures are not evidence until the duplicates are removed',
            figures: [
                { label: leftLabel, value: r[leftKey] ?? null, unit },
                { label: rightLabel, value: r[rightKey] ?? null, unit },
                { label: 'Integrity', value: `duplicated ${duplicated.join(', ')}` },
            ],
        });
        return { control, entry, rows, lineage };
    }

    // Coverage gate. A missing component surfaces as an explicit presence count
    // of 0, or as a NULL figure (a field-keyed sum over an absent row is NULL,
    // not 0). Either way the identity is not computable, so the honest result is
    // N/A — reporting PASS on a `0 − 0 = 0` that only means "we have no data"
    // would be a false assurance, the dangerous failure mode for regulated use.
    const missing = (requiredPresence ?? []).filter(({ key }) => !Number(r[key])).map(({ label }) => label);
    const figureAbsent = r[leftKey] == null || r[rightKey] == null;
    if (missing.length > 0 || figureAbsent) {
        const detail = missing.length > 0
            ? `required component(s) absent: ${missing.join(', ')}`
            : 'a required figure is absent for this instrument/period';
        const control = controlResult({
            controlId,
            criterion,
            description,
            status: CONTROL_STATUS.NA,
            figures: [
                { label: leftLabel, value: r[leftKey] ?? null, unit },
                { label: rightLabel, value: r[rightKey] ?? null, unit },
                { label: 'Coverage', value: `N/A — ${detail}` },
            ],
        });
        return { control, entry, rows, lineage };
    }

    // FX / basis gate. Subtracting or comparing figures is only valid when they
    // share a currency, scale and periodicity. A mix is not a variance to measure
    // — it is incomparable data, so fail loudly rather than return a bogus number
    // (the silent-wrong-answer-on-multi-currency-data failure mode, finding #2).
    const mixed = (consistencyKeys ?? []).filter(({ key }) => Number(r[key]) > 1).map(({ label }) => label);
    if (mixed.length > 0) {
        const control = controlResult({
            controlId,
            criterion,
            description,
            status: CONTROL_STATUS.EXCEPTION,
            exception:
                `cannot reconcile across mixed ${mixed.join(', ')} — figures must share currency, scale and ` +
                'periodicity; normalise (e.g. convert to one currency at one FX basis) before reconciling',
            figures: [
                { label: leftLabel, value: r[leftKey] ?? null, unit },
                { label: rightLabel, value: r[rightKey] ?? null, unit },
                { label: 'Basis', value: `mixed ${mixed.join(', ')}` },
            ],
        });
        return { control, entry, rows, lineage };
    }

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
    const usd0 = (v) => `$${Number(v).toLocaleString('en-US')}`;
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
            id: 'PI1.1-lseg-gross-profit-reconciliation',
            criterion: 'Processing Integrity (PI1.1) — the standardized model is internally consistent and untampered',
            warehouse: 'lseg',
            description:
                'On LSEG\'s standardized basis Gross Profit is defined as Revenue − Cost of Revenue, so this identity ' +
                'holds by construction on clean vendor data; the control is a pipeline-integrity check that fails on ' +
                'ingest corruption or a value altered after landing.',
            run(options = {}) {
                return reconciliation({
                    controlId: 'PI1.1',
                    criterion: this.criterion,
                    description: this.description,
                    run: reconcileGrossProfit(options),
                    leftKey: 'identity_gross_usd',
                    rightKey: 'reported_gross_usd',
                    leftLabel: 'Gross profit (Revenue − Cost of Revenue)',
                    rightLabel: 'Gross profit (reported, TR.GrossProfit)',
                    unit: 'usd',
                    fmt: usd0,
                    requiredPresence: [
                        { label: 'Revenue', key: 'revenue_present' },
                        { label: 'Cost of Revenue', key: 'cost_present' },
                        { label: 'reported Gross Profit', key: 'gross_present' },
                    ],
                    consistencyKeys: [
                        { label: 'currency', key: 'currency_variants' },
                        { label: 'scale', key: 'scale_variants' },
                        { label: 'periodicity', key: 'periodicity_variants' },
                    ],
                });
            },
        },
        {
            id: 'PI1.1-lseg-standardized-vs-as-reported',
            criterion: 'Processing Integrity (PI1.1) — the vendor-standardized figure reconciles to the company\'s own filing',
            warehouse: 'lseg',
            description:
                'LSEG standardized (COA) gross profit ties out to as-reported gross profit; a variance is a real ' +
                'classification difference (LSEG normalisation vs the filing) to investigate, not a data error.',
            run(options = {}) {
                return reconciliation({
                    controlId: 'PI1.1',
                    criterion: this.criterion,
                    description: this.description,
                    run: reconcileStandardizedVsAsReported(options),
                    leftKey: 'standardized_gross_usd',
                    rightKey: 'as_reported_gross_usd',
                    leftLabel: 'Gross profit (standardized, COA)',
                    rightLabel: 'Gross profit (as reported)',
                    unit: 'usd',
                    fmt: usd0,
                    requiredPresence: [
                        { label: 'standardized Gross Profit', key: 'standardized_present' },
                        { label: 'as-reported Gross Profit', key: 'as_reported_present' },
                    ],
                    consistencyKeys: [
                        { label: 'currency', key: 'currency_variants' },
                        { label: 'scale', key: 'scale_variants' },
                        { label: 'periodicity', key: 'periodicity_variants' },
                    ],
                });
            },
        },
        {
            id: 'C1.1-lseg-data-retention',
            criterion: 'Confidentiality (C1.1) — cached vendor data is tagged with its licensing terms and retained only within its licensed window',
            warehouse: 'lseg',
            description:
                'Every persisted LSEG source carries a usage class + retention TTL (finding #7), and no cached ' +
                'value is held past its TTL; an untagged source, a missing TTL, or a stale row is an EXCEPTION.',
            run(options = {}) {
                const report = retentionReport(options);
                const issues = [];
                if (report.untagged.length > 0) issues.push(`${report.untagged.length} untagged source(s)`);
                if (report.missingTtl.length > 0) issues.push(`${report.missingTtl.length} source(s) with no TTL`);
                if (report.staleTotal > 0) issues.push(`${report.staleTotal} row(s) past retention TTL`);
                const control = controlResult({
                    controlId: 'C1.1',
                    criterion: this.criterion,
                    description: this.description,
                    status: report.ok ? CONTROL_STATUS.PASS : CONTROL_STATUS.EXCEPTION,
                    exception: report.ok ? null : `data-governance gap(s): ${issues.join('; ')}`,
                    figures: [
                        { label: 'Sources tagged', value: `${report.sources.filter((s) => s.tagged).length}/${report.sources.length}` },
                        { label: 'Rows past retention TTL', value: report.staleTotal, unit: 'rows' },
                        { label: 'As of', value: report.asOf },
                    ],
                });
                // A governance check reads policy + row metadata rather than
                // producing a new attested query, so there is no query entry to
                // package (same shape as the audit-chain-integrity control).
                return { control, entry: null, rows: [], report };
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
