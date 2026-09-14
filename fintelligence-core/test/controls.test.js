/**
 * Control-catalog tests: a query becomes a control that asserts PASS/EXCEPTION,
 * and its result flows into a verifiable evidence packet. The EXCEPTION path is
 * proved by tampering with the ledger so it no longer ties to the filed figure —
 * the thing a plain query would never catch, and the reason a control exists.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { seedEnron } from '../src/enron.js';
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
    assert.ok(controlCatalog().length >= 1);
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
