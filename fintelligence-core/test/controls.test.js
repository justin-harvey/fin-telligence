/**
 * Control-catalog tests: a query becomes a control that asserts PASS/EXCEPTION,
 * and its result flows into a verifiable evidence packet. The EXCEPTION path is
 * proved by tampering with the ledger so it no longer ties to the filed figure —
 * the thing a plain query would never catch, and the reason a control exists.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { seedEnron } from '../src/enron.js';
import { seedMarkets } from '../src/markets.js';
import { seedLseg } from '../src/lseg.js';
import { seed as seedSaas } from '../src/db.js';
import { readLog } from '../src/audit.js';
import { controlCatalog, getControl } from '../src/controls.js';
import { generateCompliancePacket, verifyPacket, CONTROL_STATUS } from '../src/evidence.js';

function freshDb(tag) {
    return join(mkdtempSync(join(tmpdir(), `fintel-ctl-${tag}-`)), 'enron.db');
}
function freshLog() {
    return join(mkdtempSync(join(tmpdir(), 'fintel-ctllog-')), 'audit.jsonl');
}

const CONTROL_ID = 'PI1.2-enron-debt-reconciliation';

test('the catalog resolves controls by id and rejects unknown ones', () => {
    assert.ok(controlCatalog().length >= 6, 'the full PI/CC7 button set should be present');
    assert.equal(getControl(CONTROL_ID).id, CONTROL_ID);
    assert.throws(() => getControl('no-such-control'));
});

test('the reconciliation control PASSES when the ledger ties to the filed figure', () => {
    const db = freshDb('pass');
    seedEnron(db);
    const { control, rows } = getControl(CONTROL_ID).run({ dbPath: db, logPath: freshLog() });

    assert.equal(control.status, CONTROL_STATUS.PASS);
    assert.equal(control.exception, null);
    assert.equal(rows[0].ledger_reported_usd_millions, 10_229);
    assert.equal(rows[0].filed_reported_usd_millions, 10_229);
    const variance = control.figures.find((f) => f.label === 'Variance');
    assert.equal(variance.value, 0);
});

test('the control raises an EXCEPTION when the ledger no longer reconciles', () => {
    const db = freshDb('exc');
    seedEnron(db);

    // Someone quietly trims $500m off an on-balance-sheet instrument, so the
    // ledger no longer ties to the filed 10-K figure.
    const w = new DatabaseSync(db);
    w.exec(
        "UPDATE debt_instruments SET principal_usd_millions = principal_usd_millions - 500 " +
            "WHERE on_balance_sheet = 1 AND instrument = 'Commercial paper & short-term notes'",
    );
    w.close();

    const { control, rows } = getControl(CONTROL_ID).run({ dbPath: db, logPath: freshLog() });
    assert.equal(control.status, CONTROL_STATUS.EXCEPTION);
    assert.match(control.exception, /variance \$-500m/);
    assert.equal(rows[0].ledger_reported_usd_millions, 9_729);
    assert.equal(rows[0].filed_reported_usd_millions, 10_229);
});

test('a control result flows into an evidence packet that verifies offline', () => {
    const db = freshDb('pkt');
    seedEnron(db);
    const { control, entry, rows } = getControl(CONTROL_ID).run({ dbPath: db, logPath: freshLog() });
    const packet = generateCompliancePacket({ control, entry, rows, generatedAt: '2026-09-14T00:00:00.000Z' });

    assert.equal(packet.control.status, CONTROL_STATUS.PASS);
    assert.equal(verifyPacket(packet).ok, true);
});

test('the Enron revenue reconciliation PASSES on clean data and flags a trimmed deal', () => {
    const db = freshDb('rev');
    seedEnron(db);
    const control = getControl('PI1.1-enron-revenue-reconciliation');

    const clean = control.run({ dbPath: db, logPath: freshLog() });
    assert.equal(clean.control.status, CONTROL_STATUS.PASS);
    assert.equal(clean.rows[0].ledger_gross_usd_millions, 100_789);
    assert.equal(clean.rows[0].filed_revenue_usd_millions, 100_789);

    const w = new DatabaseSync(db);
    w.exec("UPDATE revenue_transactions SET gross_notional_usd_millions = gross_notional_usd_millions - 1000 WHERE segment = 'metals'");
    w.close();

    const tampered = control.run({ dbPath: db, logPath: freshLog() });
    assert.equal(tampered.control.status, CONTROL_STATUS.EXCEPTION);
    assert.equal(tampered.rows[0].ledger_gross_usd_millions, 99_789);
});

test('the SaaS MRR reconciliation PASSES on clean data and flags an altered subscription', () => {
    const db = freshDb('mrr');
    seedSaas(db);
    const control = getControl('PI1.2-saas-mrr-reconciliation');

    const clean = control.run({ dbPath: db, logPath: freshLog() });
    assert.equal(clean.control.status, CONTROL_STATUS.PASS);
    assert.equal(clean.rows[0].ledger_mrr_cents, clean.rows[0].reconstructed_mrr_cents);

    // Bump one active subscription's MRR without a matching ledger movement.
    const w = new DatabaseSync(db);
    w.exec('UPDATE subscriptions SET mrr_cents = mrr_cents + 100000 WHERE canceled_at IS NULL AND id = (SELECT id FROM subscriptions WHERE canceled_at IS NULL LIMIT 1)');
    w.close();

    const tampered = control.run({ dbPath: db, logPath: freshLog() });
    assert.equal(tampered.control.status, CONTROL_STATUS.EXCEPTION);
    assert.match(tampered.control.exception, /does not tie to/);
});

test('the markets position reconciliation PASSES: derived ties to the recorded snapshot', () => {
    const db = freshDb('pos');
    seedMarkets(db);
    const { control, rows } = getControl('PI1.2-markets-position-reconciliation').run({ dbPath: db, logPath: freshLog() });
    assert.equal(control.status, CONTROL_STATUS.PASS);
    assert.equal(rows[0].derived_net_qty, rows[0].snapshot_net_qty);
});

test('the LSEG gross-profit reconciliation PASSES on complete data', () => {
    const db = join(mkdtempSync(join(tmpdir(), 'fintel-ctl-lseg-')), 'lseg.db');
    seedLseg(db);
    const { control, rows } = getControl('PI1.1-lseg-gross-profit-reconciliation').run({ dbPath: db, logPath: freshLog() });
    assert.equal(control.status, CONTROL_STATUS.PASS);
    assert.equal(rows[0].identity_gross_usd, rows[0].reported_gross_usd);
    assert.equal(rows[0].revenue_present, 1);
});

test('the LSEG reconciliation is N/A (not a false PASS) when a required component is absent', () => {
    const db = join(mkdtempSync(join(tmpdir(), 'fintel-ctl-lsegna-')), 'lseg.db');
    seedLseg(db);

    // A coverage gap: the Revenue row for IBM.N FY2023 is missing (LSEG <NA>,
    // unentitled, or simply not delivered). A field-keyed sum over the absent
    // row is NULL, so `NULL − cost = NULL` — the identity is not computable.
    const w = new DatabaseSync(db);
    // Fundamentals key on Org PermID now (IBM = 4295904307), not RIC.
    w.exec("DELETE FROM fundamentals WHERE org_permid = '4295904307' AND period = 'FY2023' AND field_code = 'TR.Revenue'");
    w.close();

    const { control, rows } = getControl('PI1.1-lseg-gross-profit-reconciliation').run({ dbPath: db, logPath: freshLog() });

    // The dangerous failure mode would be PASS on a 0 that only means "no data".
    assert.notEqual(control.status, CONTROL_STATUS.PASS);
    assert.equal(control.status, CONTROL_STATUS.NA);
    assert.equal(rows[0].revenue_present, 0);
    assert.equal(rows[0].identity_gross_usd, null);
    const coverage = control.figures.find((f) => f.label === 'Coverage');
    assert.match(coverage.value, /Revenue/);
});

test('the LSEG reconciliation refuses to reconcile across mixed currencies (FX guard)', () => {
    const db = join(mkdtempSync(join(tmpdir(), 'fintel-ctl-fx-')), 'lseg.db');
    seedLseg(db);
    // IBM (4295904307): Cost of Revenue comes back in GBP while Revenue is USD.
    const w = new DatabaseSync(db);
    w.exec("UPDATE fundamentals SET currency = 'GBP' WHERE org_permid = '4295904307' AND period = 'FY2023' AND field_code = 'TR.CostOfRevenueTotal'");
    w.close();
    const { control } = getControl('PI1.1-lseg-gross-profit-reconciliation').run({ ric: 'IBM.N', period: 'FY2023', dbPath: db, logPath: freshLog() });
    // Not a false PASS on a bogus cross-currency subtraction, and not a numeric
    // variance either — an explicit refusal to reconcile incomparable figures.
    assert.equal(control.status, CONTROL_STATUS.EXCEPTION);
    assert.match(control.exception, /mixed currency/);
    assert.match(control.exception, /normalise/);
});

test('the LSEG reconciliation flags duplicated datapoints instead of passing a doubled tie (P9)', () => {
    const db = join(mkdtempSync(join(tmpdir(), 'fintel-ctl-dup-')), 'lseg.db');
    seedLseg(db);
    // A warehouse without the vintage key (built before P9, or written by
    // something that bypassed it): every IBM.N FY2023 standardized row lands twice.
    const w = new DatabaseSync(db);
    w.exec('DROP INDEX idx_fund_bitemporal');
    w.exec(
        'INSERT INTO fundamentals (org_permid, field_code, period, value, currency, basis, scale, periodicity, reporting_state, knowledge_date, retrieved_at, source) ' +
            'SELECT org_permid, field_code, period, value, currency, basis, scale, periodicity, reporting_state, knowledge_date, retrieved_at, source ' +
            "FROM fundamentals WHERE org_permid = '4295904307' AND period = 'FY2023' AND basis = 'standardized'",
    );
    w.close();

    const { control, rows } = getControl('PI1.1-lseg-gross-profit-reconciliation').run({ ric: 'IBM.N', period: 'FY2023', dbPath: db, logPath: freshLog() });
    // Doubling every component keeps Revenue − Cost = Gross, so the figures still tie…
    assert.equal(rows[0].identity_gross_usd, rows[0].reported_gross_usd);
    assert.equal(rows[0].revenue_present, 2);
    // …which is exactly why a tie alone must not PASS.
    assert.equal(control.status, CONTROL_STATUS.EXCEPTION);
    assert.match(control.exception, /duplicate datapoints/);
    assert.match(control.exception, /Revenue ×2/);
});

test('the standardized-vs-as-reported control PASSES when LSEG agrees with the filing', () => {
    const db = join(mkdtempSync(join(tmpdir(), 'fintel-ctl-basis-')), 'lseg.db');
    seedLseg(db);
    const { control, rows } = getControl('PI1.1-lseg-standardized-vs-as-reported').run({ ric: 'IBM.N', period: 'FY2023', dbPath: db, logPath: freshLog() });
    assert.equal(control.status, CONTROL_STATUS.PASS);
    assert.equal(rows[0].standardized_gross_usd, rows[0].as_reported_gross_usd);
});

test('the standardized-vs-as-reported control raises an EXCEPTION on a classification difference', () => {
    const db = join(mkdtempSync(join(tmpdir(), 'fintel-ctl-basisx-')), 'lseg.db');
    seedLseg(db);
    // IBM.N FY2022 carries a modelled $500m reclassification between the two bases.
    const { control } = getControl('PI1.1-lseg-standardized-vs-as-reported').run({ ric: 'IBM.N', period: 'FY2022', dbPath: db, logPath: freshLog() });
    assert.equal(control.status, CONTROL_STATUS.EXCEPTION);
    assert.match(control.exception, /does not tie to/);
    const variance = control.figures.find((f) => f.label === 'Variance');
    assert.equal(variance.value, -500_000_000);
});

test('the reproducibility control PASSES: two runs share a result hash', () => {
    const db = freshDb('repro');
    seedMarkets(db);
    const { control } = getControl('CC7.3-figure-reproducibility').run({ dbPath: db, logPath: freshLog() });
    assert.equal(control.status, CONTROL_STATUS.PASS);
    assert.equal(control.figures[0].value, control.figures[1].value);
});

test('the audit-chain integrity control PASSES on a good chain and FLAGS a tampered one', () => {
    const db = freshDb('int');
    seedEnron(db);
    const logPath = freshLog();
    // Build a chain by running a control into this log.
    getControl('PI1.2-enron-debt-reconciliation').run({ dbPath: db, logPath });

    const intact = getControl('CC7.2-audit-chain-integrity').run({ logPath });
    assert.equal(intact.control.status, CONTROL_STATUS.PASS);
    assert.equal(intact.entry, null, 'a verification control produces no query entry');

    // Alter a recorded entry; the chain must no longer verify.
    const entries = readLog(logPath);
    entries[0].question = 'a different question';
    writeFileSync(logPath, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');

    const broken = getControl('CC7.2-audit-chain-integrity').run({ logPath });
    assert.equal(broken.control.status, CONTROL_STATUS.EXCEPTION);
});
