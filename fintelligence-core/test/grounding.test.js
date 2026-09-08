/**
 * Grounding tests — the ones that make the product claim testable.
 *
 * "Nothing is hallucinated into the output" is either a property you can
 * demonstrate failing on hallucinated input, or it is marketing copy. These
 * tests feed deliberately fabricated narration through the checker and assert
 * it is caught.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { checkGrounding, extractNumbers, parseProseNumber } from '../src/grounding.js';

const ROWS = [
    { month: '2025-06', mrr_cents: 3_585_700 },
    { month: '2025-11', mrr_cents: 32_476_072 },
    { nrr: 1.087 },
];

test('accepts a figure restated from cents as currency', () => {
    const result = checkGrounding({ narration: 'MRR ended at $324,760.72.', rows: ROWS });
    assert.ok(result.ok, `unexpectedly flagged: ${JSON.stringify(result.ungrounded)}`);
    assert.equal(result.grounded[0].via, 'cents_to_units');
});

test('accepts a ratio restated as a percentage', () => {
    const result = checkGrounding({ narration: 'Net revenue retention is 108.7%.', rows: ROWS });
    assert.ok(result.ok);
    assert.equal(result.grounded[0].via, 'ratio_to_percent');
});

test('accepts a figure rounded to a magnitude suffix', () => {
    // $325K from 32,476,072 cents is correct to the precision written.
    assert.ok(checkGrounding({ narration: 'MRR closed near $325K.', rows: ROWS }).ok);
});

test('catches a fabricated total', () => {
    // $412,000 is the figure hardcoded in the original prototype. It is not
    // in this data, and the checker must not let it through.
    const result = checkGrounding({ narration: 'MRR grew to $412,000 by November.', rows: ROWS });
    assert.equal(result.ok, false);
    assert.deepEqual(result.ungrounded.map((n) => n.raw), ['$412,000']);
});

test('catches a fabricated statistic', () => {
    const result = checkGrounding({ narration: 'Churn ran at 4.2% for the quarter.', rows: ROWS });
    assert.equal(result.ok, false);
    assert.equal(result.ungrounded[0].raw, '4.2%');
});

test('isolates the invented figure in an otherwise-true sentence', () => {
    // The dangerous case: a true number lends credibility to a false one
    // sitting beside it.
    const result = checkGrounding({
        narration: 'MRR reached $324,760.72, ahead of the $250,000 industry benchmark.',
        rows: ROWS,
    });
    assert.equal(result.ok, false);
    assert.equal(result.grounded.length, 1);
    assert.deepEqual(result.ungrounded.map((n) => n.raw), ['$250,000']);
});

test('does not read date literals as figures', () => {
    // Without masking, "2025-06" contributes 2025 and 06 as ungrounded claims.
    assert.ok(checkGrounding({ narration: 'Between 2025-06 and 2025-11, MRR rose to $324,760.72.', rows: ROWS }).ok);
});

test('accepts numbers the user supplied in the question', () => {
    // Echoing the asker's own figure is not an invention.
    const result = checkGrounding({
        narration: 'Across the last 6 months MRR reached $324,760.72.',
        rows: ROWS,
        question: 'How has MRR trended over the last 6 months?',
    });
    assert.ok(result.ok, `flagged: ${JSON.stringify(result.ungrounded)}`);
});

test('accepts the row count as a quotable fact', () => {
    assert.ok(checkGrounding({ narration: 'The query returned 3 rows.', rows: ROWS }).ok);
});

test('tolerance is half a unit in the last place written', () => {
    const rows = [{ v: 36.7241 }];
    // 36.7 admits [36.65, 36.75) — 36.7241 is inside.
    assert.ok(checkGrounding({ narration: 'It is 36.7.', rows }).ok);
    // 36.72 admits [36.715, 36.725) — still inside.
    assert.ok(checkGrounding({ narration: 'It is 36.72.', rows }).ok);
    // 36.8 admits [36.75, 36.85) — outside, so flagged.
    assert.equal(checkGrounding({ narration: 'It is 36.8.', rows }).ok, false);
});

test('empty narration has nothing to flag', () => {
    const result = checkGrounding({ narration: '', rows: ROWS });
    assert.ok(result.ok);
    assert.equal(result.checked, 0);
});

test('parseProseNumber reports value, expressed precision, and unit', () => {
    assert.deepEqual(parseProseNumber('$1.2M'), { value: 1_200_000, ulp: 100_000, unit: 'currency', isPercent: false });
    assert.deepEqual(parseProseNumber('36.7%'), { value: 36.7, ulp: 0.1, unit: 'percent', isPercent: true });
    assert.deepEqual(parseProseNumber('563K'), { value: 563_000, ulp: 1_000, unit: 'plain', isPercent: false });
    assert.deepEqual(parseProseNumber('42'), { value: 42, ulp: 1, unit: 'plain', isPercent: false });
    assert.deepEqual(parseProseNumber('125 bps'), { value: 125, ulp: 1, unit: 'bps', isPercent: false });
});

test('extractNumbers finds every claim in a paragraph', () => {
    const found = extractNumbers('Revenue was $1,200 in Q1, up 15.5%, across 3 regions.');
    assert.deepEqual(found.map((n) => n.raw), ['$1,200', '15.5%', '3']);
});

test('grounds a figure written in basis points against a stored ratio', () => {
    // A take-rate stored as the ratio 0.0125 is legitimately narrated as
    // "125 bps": ratio_to_bps (x10000) is the transform that bridges them.
    const rows = [{ take_rate: 0.0125 }];
    const result = checkGrounding({ narration: 'The take rate was 125 bps.', rows });
    assert.ok(result.ok, `flagged: ${JSON.stringify(result.ungrounded)}`);
    assert.equal(result.grounded[0].via, 'ratio_to_bps');
});

test('grounds basis points quoted from a percentage', () => {
    const rows = [{ spread_pct: 1.25 }];
    const result = checkGrounding({ narration: 'The spread widened to 125 bps.', rows });
    assert.ok(result.ok);
    assert.equal(result.grounded[0].via, 'percent_to_bps');
});

test('unit-awareness stops a currency figure grounding against an unrelated ratio', () => {
    // Without unit-aware transforms, "$42" (42) would match the ratio 0.42 via
    // ratio_to_percent. A dollar amount is not a percentage, so it must not.
    const rows = [{ some_ratio: 0.42 }];
    const result = checkGrounding({ narration: 'That line item was $42.', rows });
    assert.equal(result.ok, false);
    assert.deepEqual(result.ungrounded.map((n) => n.raw), ['$42']);
});

test('grounds a computed growth figure returned as its own column', () => {
    // The compute-in-SQL contract: the growth % is a returned cell, so the
    // narration that quotes it grounds as a plain membership check.
    const rows = [{ start_cents: 3_585_700, end_cents: 32_476_072, growth_pct: 805.7 }];
    const result = checkGrounding({
        narration: 'MRR grew 805.7%, from $35,857.00 to $324,760.72.',
        rows,
    });
    assert.ok(result.ok, `flagged: ${JSON.stringify(result.ungrounded)}`);
});
