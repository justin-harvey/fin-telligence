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
