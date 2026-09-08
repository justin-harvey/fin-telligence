/**
 * Capital-markets flagship tests: the surveillance and position-attestation
 * scenarios, their reproducibility, and the tamper test on a surveillance alert.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openReadOnly, runQuery } from '../src/db.js';
import { fingerprint } from '../src/lineage.js';
import { verify, readLog } from '../src/audit.js';
import {
    seedMarkets,
    netPositionAtClose,
    surveillanceRapidCancels,
    OPEN_MS,
    CLOSE_MS,
    TRADING_DATE,
} from '../src/markets.js';

const DIR = mkdtempSync(join(tmpdir(), 'fintel-markets-'));
const DB_PATH = join(DIR, 'markets.db');
seedMarkets(DB_PATH);

function freshLog() {
    return join(mkdtempSync(join(tmpdir(), 'fintel-mktlog-')), 'audit.jsonl');
}

function writeEntries(path, entries) {
    writeFileSync(path, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
}

test('the markets seed is deterministic in shape', () => {
    const result = seedMarkets(join(mkdtempSync(join(tmpdir(), 'fintel-mkt2-')), 'w.db'));
    assert.equal(result.accounts, 6);
    assert.equal(result.orders, 36);
    assert.equal(result.executions, 19);
});

test('surveillance flags exactly the two seeded spoofers', () => {
    const { rows } = surveillanceRapidCancels({ dbPath: DB_PATH, logPath: freshLog() });
    assert.deepEqual(
        rows,
        [
            { account_id: 3, rapid_cancels: 6 },
            { account_id: 4, rapid_cancels: 6 },
        ],
        'only the two place-and-cancel accounts should be flagged',
    );
});

test('surveillance does not flag ordinary slow cancels', () => {
    // Tightening the window below the spoofers\' 300ms floor clears the board:
    // the normal accounts\' cancels are tens of seconds out and never counted.
    const { rows } = surveillanceRapidCancels({
        windowMs: 100,
        dbPath: DB_PATH,
        logPath: freshLog(),
    });
    assert.equal(rows.length, 0);
});

test('a surveillance alert is recorded with provenance and a compliance tag', () => {
    const logPath = freshLog();
    const { entry } = surveillanceRapidCancels({ dbPath: DB_PATH, logPath });
    assert.equal(entry.scenario, 'surveillance_rapid_cancels');
    assert.equal(entry.alertCount, 2);
    assert.ok(entry.complianceTags.includes('MAR: market abuse'));
    assert.match(entry.resultHash, /^[0-9a-f]{64}$/);
    assert.ok(verify(logPath).ok);
});

test('net position as of the open is empty; as of the close it is not', () => {
    const atOpen = netPositionAtClose({ ticker: 'ACME', asOfMs: OPEN_MS, dbPath: DB_PATH, logPath: freshLog() });
    const atClose = netPositionAtClose({ ticker: 'ACME', asOfMs: CLOSE_MS, dbPath: DB_PATH, logPath: freshLog() });
    assert.equal(atOpen.rows.length, 0);
    assert.ok(atClose.rows.length > 0);
    assert.notEqual(fingerprint(atOpen.rows), fingerprint(atClose.rows));
});

test('net position at close reproduces the same result hash', () => {
    const first = netPositionAtClose({ ticker: 'BOLT', dbPath: DB_PATH, logPath: freshLog() });
    const second = netPositionAtClose({ ticker: 'BOLT', dbPath: DB_PATH, logPath: freshLog() });
    assert.equal(first.lineage.resultHash, second.lineage.resultHash);
});

test('the derived net position reconciles with the positions snapshot', () => {
    // The whole point of the demo: a figure computed from the ledger matches an
    // independently stored one. If these diverged, the attestation would be
    // attesting to a number nobody can reproduce.
    const { rows } = netPositionAtClose({ ticker: 'ACME', dbPath: DB_PATH, logPath: freshLog() });
    const db = openReadOnly(DB_PATH);
    try {
        for (const row of rows) {
            const snapshot = runQuery(
                db,
                'SELECT net_qty FROM positions WHERE account_id = ? AND ticker = ? AND date = ?',
                { params: [row.account_id, 'ACME', TRADING_DATE] },
            );
            assert.equal(snapshot.length, 1);
            assert.equal(snapshot[0].net_qty, row.net_qty);
        }
    } finally {
        db.close();
    }
});

test('tampering with a historical surveillance alert is detected', () => {
    const logPath = freshLog();
    surveillanceRapidCancels({ dbPath: DB_PATH, logPath });

    // An analyst quietly downgrades a flagged account\'s cancel count after the
    // fact. The alert was hashed into the chain, so the edit cannot hide.
    const entries = readLog(logPath);
    entries[0].alertCount = 0;
    writeEntries(logPath, entries);

    const result = verify(logPath);
    assert.equal(result.ok, false);
    assert.equal(result.brokenAt, 0);
    assert.match(result.reason, /modified since it was written/);
});
