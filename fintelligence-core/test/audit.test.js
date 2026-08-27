/**
 * Audit chain tests.
 *
 * The log's value rests on one property: a past entry cannot be changed
 * without detection. These tests tamper with a written log and assert the
 * tampering is found — including the subtle cases (deleting a middle entry,
 * rewriting an entry's own hash to match its new content).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { append, verify, readLog, hashEntry, exportPackage, GENESIS } from '../src/audit.js';

function freshLog() {
    return join(mkdtempSync(join(tmpdir(), 'fintel-audit-')), 'audit.jsonl');
}

/** @param {string} path */
function writeEntries(path, entries) {
    writeFileSync(path, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
}

function seedThree(path) {
    append({ question: 'one', rowCount: 1, tables: ['customers'] }, { path });
    append({ question: 'two', rowCount: 2, tables: ['customers'] }, { path });
    append({ question: 'three', rowCount: 3, tables: ['mrr_movements'] }, { path });
}

test('first entry chains from genesis', () => {
    const path = freshLog();
    const entry = append({ question: 'first', rowCount: 0, tables: [] }, { path });
    assert.equal(entry.seq, 0);
    assert.equal(entry.prevHash, GENESIS);
    assert.ok(verify(path).ok);
});

test('entries chain to their predecessor', () => {
    const path = freshLog();
    seedThree(path);
    const entries = readLog(path);

    assert.equal(entries.length, 3);
    assert.equal(entries[1].prevHash, entries[0].hash);
    assert.equal(entries[2].prevHash, entries[1].hash);
    assert.ok(verify(path).ok);
});

test('editing a past entry breaks the chain', () => {
    const path = freshLog();
    seedThree(path);

    const entries = readLog(path);
    entries[0].rowCount = 9999; // the lie
    writeEntries(path, entries);

    const result = verify(path);
    assert.equal(result.ok, false);
    assert.equal(result.brokenAt, 0);
    assert.match(result.reason, /modified since it was written/);
});

test('recomputing the edited entry hash still breaks the chain', () => {
    const path = freshLog();
    seedThree(path);

    // A tamperer who knows the scheme fixes the entry's own hash. That makes
    // entry 0 self-consistent, but entry 1 still points at the old hash — the
    // break simply moves one position along.
    const entries = readLog(path);
    entries[0].rowCount = 9999;
    entries[0].hash = hashEntry(entries[0]);
    writeEntries(path, entries);

    const result = verify(path);
    assert.equal(result.ok, false);
    assert.equal(result.brokenAt, 1);
    assert.match(result.reason, /points at/);
});

test('deleting an entry from the middle is detected', () => {
    const path = freshLog();
    seedThree(path);

    const entries = readLog(path);
    writeEntries(path, [entries[0], entries[2]]);

    const result = verify(path);
    assert.equal(result.ok, false);
    assert.equal(result.brokenAt, 1);
});

test('truncating the newest entry is not a chain break', () => {
    // Dropping the tail leaves a valid shorter chain. This is an honest
    // limitation of a local log and the reason a real deployment anchors the
    // head hash somewhere it does not control.
    const path = freshLog();
    seedThree(path);

    const entries = readLog(path);
    writeEntries(path, entries.slice(0, 2));

    const result = verify(path);
    assert.equal(result.ok, true);
    assert.equal(result.entries, 2);
});

test('an empty log verifies as intact', () => {
    assert.deepEqual(verify(freshLog()), { ok: true, entries: 0, brokenAt: null, reason: null });
});

test('the export package carries integrity status and stated guarantees', () => {
    const path = freshLog();
    seedThree(path);

    const pkg = exportPackage(path);
    assert.equal(pkg.entryCount, 3);
    assert.equal(pkg.integrity.ok, true);
    assert.equal(pkg.guarantees.llmScope, 'sql_generation_only');
    assert.equal(pkg.guarantees.databaseAccess, 'read_only_connection');
    assert.equal(pkg.entries.length, 3);
});

test('the export package reports a broken chain rather than hiding it', () => {
    const path = freshLog();
    seedThree(path);

    const entries = readLog(path);
    entries[1].question = 'rewritten';
    writeEntries(path, entries);

    const pkg = exportPackage(path);
    assert.equal(pkg.integrity.ok, false);
    assert.equal(pkg.integrity.brokenAt, 1);
});
