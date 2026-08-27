/**
 * The narrator — result set in, prose out, every figure verified.
 *
 * This is the risky step, and the one the thesis is really about. Turning rows
 * into a sentence is where a model can quietly introduce a number that was
 * never in the data. So narration here is a loop, not a call:
 *
 *   1. Ask for prose.
 *   2. Check every number in it against the result set (see grounding.js).
 *   3. If something is ungrounded, say precisely which figure and ask again.
 *   4. If it fails again, stop asking and emit a deterministic summary built
 *      from the rows directly.
 *
 * Step 4 is the part that makes the guarantee unconditional. A system that
 * retries and then gives up returns something unverified at the end; this one
 * degrades to prose that is dull but provably true, and labels it as such. The
 * caller always receives a `grounded: true` answer or an explicit refusal —
 * never an unverified paragraph presented as fact.
 */

import Anthropic from '@anthropic-ai/sdk';
import { checkGrounding } from './grounding.js';
import { MODEL } from './planner.js';

const SYSTEM_PROMPT = `
You describe the result of a database query for a finance audience.

Absolute rule: every number you write must appear in the result rows you were given, or be
a direct restatement of one (cents shown as currency, a ratio shown as a percentage). You
may round, and you should — write "36.7%", not "36.7241%".

Never introduce: totals you computed yourself, comparisons to periods not in the data,
industry benchmarks, growth rates that are not in the rows, or any figure you cannot point
at. If something interesting would require a number you do not have, describe it
qualitatively or say what additional query would answer it.

Two to four sentences. Lead with the answer. No preamble, no bullet lists, no restating the
question.
`.trim();

/**
 * A summary that requires no model and therefore cannot hallucinate.
 *
 * Used when narration fails verification twice. It is deliberately mechanical:
 * shape of the result and the range of the first numeric column. Boring beats
 * wrong.
 *
 * @param {object[]} rows
 * @returns {string}
 */
export function deterministicSummary(rows) {
    if (rows.length === 0) return 'The query returned no rows.';

    const columns = Object.keys(rows[0]);
    const parts = [
        `The query returned ${rows.length} row${rows.length === 1 ? '' : 's'} ` +
            `with column${columns.length === 1 ? '' : 's'} ${columns.join(', ')}.`,
    ];

    const numericColumn = columns.find((column) => typeof rows[0][column] === 'number');
    if (numericColumn) {
        const values = rows.map((row) => row[numericColumn]).filter((v) => typeof v === 'number');
        if (values.length > 0) {
            const min = Math.min(...values);
            const max = Math.max(...values);
            parts.push(`Values of ${numericColumn} range from ${min} to ${max}.`);
        }
    }

    parts.push('Automated narration could not be verified against the data, so this summary is mechanical.');
    return parts.join(' ');
}

/**
 * Narrate a result set, verifying every figure before returning it.
 *
 * @param {object} params
 * @param {string}   params.question
 * @param {object[]} params.rows
 * @param {string}   [params.sql]
 * @param {Anthropic} [params.client]
 * @param {string}   [params.model]
 * @param {number}   [params.maxAttempts]
 * @returns {Promise<{ text: string, grounded: boolean, attempts: number, verification: object, fellBack: boolean }>}
 */
export async function narrate({
    question,
    rows,
    sql = '',
    client = new Anthropic(),
    model = MODEL,
    maxAttempts = 2,
}) {
    if (rows.length === 0) {
        const text = 'The query returned no rows, so there is nothing to report for this question.';
        return {
            text,
            grounded: true,
            attempts: 0,
            verification: checkGrounding({ narration: text, rows, question }),
            fellBack: false,
        };
    }

    const messages = [
        {
            role: 'user',
            content:
                `Question: ${question}\n\n` +
                (sql ? `SQL that ran:\n${sql}\n\n` : '') +
                `Result rows (JSON):\n${JSON.stringify(rows, null, 2)}`,
        },
    ];

    let verification = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const response = await client.messages.create({
            model,
            max_tokens: 16000,
            system: SYSTEM_PROMPT,
            thinking: { type: 'adaptive' },
            messages,
        });

        if (response.stop_reason === 'refusal') {
            break;
        }

        const text = response.content
            .filter((block) => block.type === 'text')
            .map((block) => block.text)
            .join('')
            .trim();

        verification = checkGrounding({ narration: text, rows, question });
        if (verification.ok) {
            return { text, grounded: true, attempts: attempt, verification, fellBack: false };
        }

        // Tell the model exactly which figures failed. A generic "try again"
        // tends to produce a differently-wrong paragraph.
        const offending = verification.ungrounded.map((n) => `"${n.raw}"`).join(', ');
        messages.push({ role: 'assistant', content: text });
        messages.push({
            role: 'user',
            content:
                `These figures do not appear in the result rows: ${offending}. ` +
                'Rewrite using only numbers present in the data above. If you cannot make the ' +
                'point without that figure, drop the point.',
        });
    }

    const text = deterministicSummary(rows);
    return {
        text,
        grounded: true,
        attempts: maxAttempts,
        verification: verification ?? checkGrounding({ narration: text, rows, question }),
        fellBack: true,
    };
}
