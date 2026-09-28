/**
 * LSEG retention + licensing-tag governance tests (finding #7 / P8): every
 * persisted source is tagged with usage class + TTL, staleness is measured against
 * the retrieved date, purge brings the cache back inside its window, and the
 * data-retention control turns all of that into a PASS/EXCEPTION with evidence.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { seedLseg } from '../src/lseg.js';
import { retentionReport, purgeExpired } from '../src/lseg-retention.js';
import { getControl } from '../src/controls.js';

function freshDb() {
    const db = join(mkdtempSync(join(tmpdir(), 'fintel-lsegret-')), 'lseg.db');
    seedLseg(db, { retrievedAt: '2024-03-31' });
    return db;
}

// freshDb pins retrieved_at = 2024-03-31 (the seed's default is today) with a
// 90-day TTL, so an as-of within the window is fresh and one well past it is stale.
const WITHIN_TTL = '2024-04-15';
const PAST_TTL = '2030-01-01';

test('every persisted source is tagged (usage class + TTL), nothing untagged', () => {
    const report = retentionReport({ dbPath: freshDb(), asOf: WITHIN_TTL });
    assert.equal(report.untagged.length, 0);
    assert.equal(report.missingTtl.length, 0);
    assert.equal(report.sources.length, 1);
    assert.equal(report.sources[0].usageClass, 'non-display');
    assert.equal(report.sources[0].retentionDays, 90);
    assert.equal(report.sources[0].rows, 59, '50 fundamentals + 9 prices, one source');
});

test('within the TTL the cache is compliant; past it every row is stale', () => {
    const db = freshDb();
    const fresh = retentionReport({ dbPath: db, asOf: WITHIN_TTL });
    assert.equal(fresh.staleTotal, 0);
    assert.equal(fresh.ok, true);

    const stale = retentionReport({ dbPath: db, asOf: PAST_TTL });
    assert.equal(stale.staleTotal, 59, 'all rows are past a 90-day TTL by 2030');
    assert.equal(stale.ok, false);
});

test('an untagged source is flagged, not silently allowed', () => {
    const db = freshDb();
    // Land a row from a source with no data_sources policy row.
    const w = new DatabaseSync(db);
    w.exec(
        "INSERT INTO prices (quote_permid, field_code, price_date, value, currency, scale, retrieved_at, source) " +
        "VALUES ('QUOTE-PENDING:IBM.N', 'TR.PriceClose', '2024-05-01', 16000, 'USD', 0, '2024-05-01', 'ROGUE FEED (untagged)')",
    );
    w.close();
    const report = retentionReport({ dbPath: db, asOf: WITHIN_TTL });
    assert.ok(report.untagged.includes('ROGUE FEED (untagged)'), 'the policy-less source is flagged');
    assert.equal(report.ok, false);
});

test('purgeExpired dry-run counts without deleting; a real purge clears stale rows', () => {
    const db = freshDb();
    const dry = purgeExpired({ dbPath: db, asOf: PAST_TTL, dryRun: true });
    assert.equal(dry.total, 59);
    assert.equal(retentionReport({ dbPath: db, asOf: PAST_TTL }).sources[0].rows, 59, 'dry run deleted nothing');

    const real = purgeExpired({ dbPath: db, asOf: PAST_TTL });
    assert.equal(real.total, 59);
    assert.equal(real.purged.fundamentals, 50);
    assert.equal(real.purged.prices, 9);
    assert.equal(retentionReport({ dbPath: db, asOf: PAST_TTL }).staleTotal, 0, 'nothing left past the TTL');
});

test('the data-retention control PASSes inside the window and EXCEPTIONs past it', () => {
    const db = freshDb();
    const control = getControl('C1.1-lseg-data-retention');
    assert.equal(control.run({ dbPath: db, asOf: WITHIN_TTL }).control.status, 'PASS');
    const exc = control.run({ dbPath: db, asOf: PAST_TTL }).control;
    assert.equal(exc.status, 'EXCEPTION');
    assert.match(exc.exception, /past retention TTL/);
});
