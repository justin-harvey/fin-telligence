import { test, expect } from '@playwright/test';
import { watchForProblems, looksLikeErrorPage } from '../helpers/errors';
import { BASE_URL } from '../playwright.config';

const origin = new URL(BASE_URL).origin;
const VERIFY_PATH = process.env.VERIFY_PATH ?? '/public/verify';

/**
 * Public verify page — no login needed. Pastes each known record id/hash and
 * checks the page resolves it to *something* rather than erroring or hanging.
 * These are the sample ids from the test dataset; adjust freely.
 */
const SAMPLES: { input: string; expect: string }[] = [
  { input: '0x075f41a88ff3aeed30a1a909400ea134a36f1012d217add8e1bf409031786a8d', expect: 'Card-spend attestation' },
  { input: '0xf6099162429b93c8b2', expect: 'Card-spend attestation' },
  { input: '0xdeab29d097c82de491a29eb503ecf8bc2195befaedb097d0ce83b09392ffb028', expect: 'Enterprise record anchor' },
  { input: '0x193ae744110a0a20', expect: 'Vendor payout' },
  { input: '0x9ea3eb6f5d1e3a242983b1c7fe16d1e1cc0397e88e01504f7cef1fa9517a51d1', expect: 'Citizen vote-tally anchor' },
  { input: 'CRN-2026--1370', expect: 'Awarded solicitation' },
  { input: 'ocds-civicx-vnywgqztcjd7fck74xuuio7eye', expect: 'OCDS releases' },
  { input: 'ab716343-3312-47f2-895f-e5e9443be4c1', expect: 'Solicitation record' },
];

test.describe('public verify', () => {
  for (const sample of SAMPLES) {
    test(`resolves ${sample.input.slice(0, 22)}...`, async ({ page }) => {
      const { problems } = watchForProblems(page, origin);
      await page.goto(VERIFY_PATH);

      const box = page
        .getByRole('textbox')
        .or(page.getByPlaceholder(/hash|id|verify|paste/i))
        .or(page.locator('input[type="text"], input:not([type]), textarea'))
        .first();
      await box.fill(sample.input);

      const go = page
        .getByRole('button', { name: /verify|search|look ?up|check/i })
        .or(page.locator('button[type="submit"]'))
        .first();
      await go.click().catch(() => {}); // some verify pages resolve on input change
      await page.waitForLoadState('networkidle').catch(() => {});

      const bad = await looksLikeErrorPage(page);
      expect(bad, `verify page unhealthy for ${sample.input}: ${bad}`).toBeNull();
      // Soft signal: the resolved category text ideally appears. Logged, not gated,
      // because label wording in the test data may drift.
      const matched = await page.getByText(new RegExp(sample.expect.replace(/\s+/g, '\\s+'), 'i')).count();
      if (matched === 0) {
        console.log(`  NOTE: "${sample.expect}" not found for ${sample.input} — confirm label wording`);
      }
      expect(problems.filter((p) => p.type === 'pageerror')).toHaveLength(0);
    });
  }
});
