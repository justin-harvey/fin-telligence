/**
 * Numeric grounding — the check that makes the central claim testable.
 *
 * The thesis is "nothing is hallucinated into the output". Scoping the model
 * to SQL generation gets most of the way there: the figures come from the
 * warehouse. But the moment you ask a model to *narrate* a result set, it can
 * introduce a number that was never in the data — a total it summed wrong, a
 * percentage it estimated, a prior-year comparison nobody queried. That
 * sentence reads exactly like the true ones around it.
 *
 * So the narration is verified rather than trusted. Every number in the prose
 * is extracted and matched against the values the query actually returned. A
 * number with no source is reported. The pipeline then decides what to do with
 * it — this module only establishes the fact.
 *
 * ── Matching rules ────────────────────────────────────────────────────────
 *
 * Prose does not quote raw database values, so a literal comparison would flag
 * everything. Three transformations are accepted, because each is something a
 * writer legitimately does to a stored value:
 *
 *   identity   1.08          -> "1.08"
 *   ÷100       56_341_200¢   -> "$563,412"     (cents to currency)
 *   ×100       0.367         -> "36.7%"        (ratio to percentage)
 *   ×10000     0.0125        -> "125 bps"      (ratio to basis points)
 *
 * Which transforms are tried is decided by the *unit the prose wrote the figure
 * in*. A number written as currency is matched by identity or cents; one
 * written as a percentage by identity or ×100; one in basis points by identity,
 * ×100 (from a percent) or ×10000 (from a ratio). This narrowing is not
 * cosmetic: applying every transform to every figure invites false positives,
 * where a dollar amount happens to equal some unrelated ratio scaled up. A
 * figure with no unit keeps the older permissive set, since a bare number is
 * genuinely ambiguous (a count, a ratio, or cents).
 *
 * Tolerance is *half a unit in the last expressed place*, which is exactly the
 * rounding rule a human follows. "36.7%" admits anything in [36.65, 36.75);
 * "$1.2M" admits [1.15M, 1.25M). This is stricter than a flat percentage for
 * precise figures and looser for deliberately rounded ones — the behaviour you
 * want in both directions.
 */

/**
 * Numbers that appear inside a date literal, which should not be treated as
 * data points. "2025-06" is a cohort label, not a claim that something equals
 * 2025.
 */
const DATE_PATTERN = /\b\d{4}-\d{2}(?:-\d{2})?\b/g;

/**
 * A number as written in prose: optional currency symbol, digit groups,
 * optional decimal, optional percent or magnitude suffix.
 *
 * Two details are load-bearing:
 *
 *   The leading lookbehind rejects digits attached to a label — the "1" in
 *   "Q1" or "H2" is a period name, not a claim that something equals one.
 *
 *   Comma groups must be exactly three digits (`1,200`), so a comma that is
 *   punctuation rather than a thousands separator is left out of the match.
 *   Without that, "in Q1, up 15%" yields a phantom figure of "1,".
 */
const NUMBER_PATTERN =
    /(?<![A-Za-z0-9.])-?\$?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\s*(?:%|[KMB]\b|bps?\b)?/g;

const MAGNITUDE = { K: 1e3, M: 1e6, B: 1e9 };

/**
 * The unit a prose figure was written in, inferred from its symbols. This
 * selects which transforms are legitimate when matching it to the data.
 *
 * @param {string} text
 * @returns {'percent'|'bps'|'currency'|'plain'}
 */
function unitOf(text) {
    if (text.includes('%')) return 'percent';
    if (/\bbps?\b/i.test(text)) return 'bps';
    if (text.includes('$')) return 'currency';
    return 'plain';
}

/**
 * Parse one prose number into its value, the precision it was written to, and
 * the unit it was expressed in.
 *
 * `ulp` is the unit in the last place — the granularity the writer expressed.
 * For "36.7" that is 0.1; for "563K" it is 1000; for "42" it is 1.
 *
 * @param {string} raw
 * @returns {{ value: number, ulp: number, unit: string, isPercent: boolean } | null}
 */
export function parseProseNumber(raw) {
    const text = raw.trim();
    const unit = unitOf(text);
    const suffixMatch = text.match(/([KMB])\b/);
    const magnitude = suffixMatch ? MAGNITUDE[suffixMatch[1]] : 1;

    const digits = text
        .replace(/[$,%\s]/g, '')
        .replace(/[KMB]\b/, '')
        .replace(/bps?/i, '');
    const value = Number.parseFloat(digits);
    if (!Number.isFinite(value)) return null;

    const decimals = digits.includes('.') ? digits.split('.')[1].length : 0;
    const ulp = Math.pow(10, -decimals) * magnitude;

    return { value: value * magnitude, ulp, unit, isPercent: unit === 'percent' };
}

/**
 * Pull every numeric claim out of a block of prose.
 *
 * @param {string} text
 * @returns {{ raw: string, value: number, ulp: number, isPercent: boolean }[]}
 */
export function extractNumbers(text) {
    if (typeof text !== 'string' || text === '') return [];

    // Blank out date literals first so their components are not read as
    // figures, preserving offsets so nothing else shifts.
    const masked = text.replace(DATE_PATTERN, (match) => ' '.repeat(match.length));

    const found = [];
    for (const match of masked.matchAll(NUMBER_PATTERN)) {
        const parsed = parseProseNumber(match[0]);
        if (parsed) found.push({ raw: match[0].trim(), ...parsed });
    }
    return found;
}

/**
 * Every numeric value the result set contains, including values nested one
 * level inside row objects.
 *
 * @param {object[]} rows
 * @returns {number[]}
 */
export function resultValues(rows) {
    const values = [];
    for (const row of rows) {
        for (const value of Object.values(row)) {
            if (typeof value === 'number' && Number.isFinite(value)) {
                values.push(value);
            } else if (typeof value === 'bigint') {
                values.push(Number(value));
            } else if (typeof value === 'string') {
                // SQLite returns some aggregates as strings; a purely numeric
                // string is still a figure the query produced.
                const parsed = Number(value);
                if (value.trim() !== '' && Number.isFinite(parsed)) values.push(parsed);
            }
        }
    }
    return values;
}

const IDENTITY = ['identity', (v) => v];
const CENTS_TO_UNITS = ['cents_to_units', (v) => v / 100];
const RATIO_TO_PERCENT = ['ratio_to_percent', (v) => v * 100];
const RATIO_TO_BPS = ['ratio_to_bps', (v) => v * 10000];
const PERCENT_TO_BPS = ['percent_to_bps', (v) => v * 100];

/**
 * The transforms worth trying for a figure written in a given unit. Narrower
 * than "all of them" on purpose — see the module header on false positives.
 *
 * @param {string} unit
 * @returns {Array<[string, (v: number) => number]>}
 */
function transformsFor(unit) {
    switch (unit) {
        case 'percent':
            return [IDENTITY, RATIO_TO_PERCENT];
        case 'bps':
            return [IDENTITY, PERCENT_TO_BPS, RATIO_TO_BPS];
        case 'currency':
            return [IDENTITY, CENTS_TO_UNITS];
        default:
            // A bare number is ambiguous: a count, a ratio, or a cents amount.
            return [IDENTITY, CENTS_TO_UNITS, RATIO_TO_PERCENT];
    }
}

/**
 * Does a prose number correspond to some value the query returned?
 *
 * @param {{ value: number, ulp: number, unit?: string }} prose
 * @param {number[]} candidates
 * @returns {{ grounded: boolean, source: number|null, via: string|null }}
 */
function locate(prose, candidates) {
    const tolerance = prose.ulp / 2;
    const transforms = transformsFor(prose.unit ?? 'plain');

    for (const candidate of candidates) {
        for (const [via, transform] of transforms) {
            const transformed = transform(candidate);
            // `<=` rather than `<`: a value exactly on the boundary rounds to
            // the written figure under round-half-away-from-zero, so treating
            // it as ungrounded would flag correct narration.
            if (Math.abs(transformed - prose.value) <= tolerance) {
                return { grounded: true, source: candidate, via };
            }
        }
    }
    return { grounded: false, source: null, via: null };
}

/**
 * Check a narration against the data it claims to describe.
 *
 * @param {object} params
 * @param {string}   params.narration the prose to verify
 * @param {object[]} params.rows      the result set it should be describing
 * @param {string}   [params.question] the original question; numbers the user
 *                                     supplied are not the model's invention
 * @returns {{ ok: boolean, checked: number, grounded: object[], ungrounded: object[] }}
 */
export function checkGrounding({ narration, rows, question = '' }) {
    const candidates = resultValues(rows);

    // A count of returned rows is a fact about the result set, and the row
    // count itself is legitimately quotable ("across all six cohorts").
    candidates.push(rows.length);

    // Numbers the user wrote in the question are theirs, not the model's.
    for (const asked of extractNumbers(question)) candidates.push(asked.value);

    const grounded = [];
    const ungrounded = [];

    for (const prose of extractNumbers(narration)) {
        const located = locate(prose, candidates);
        if (located.grounded) {
            grounded.push({ ...prose, ...located });
        } else {
            ungrounded.push(prose);
        }
    }

    return {
        ok: ungrounded.length === 0,
        checked: grounded.length + ungrounded.length,
        grounded,
        ungrounded,
    };
}
