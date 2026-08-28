import { Page, expect } from '@playwright/test';
import type { Account } from './accounts';

/**
 * UI login flow.
 *
 * Selectors here are BEST-EFFORT and resilient (they try label, placeholder,
 * role, and common name attributes). If your login page differs, the fastest
 * way to lock exact selectors is:
 *
 *     npm run codegen            # opens the app, records clicks into code
 *
 * and paste the recorded locators over the fallbacks below.
 */
export async function login(page: Page, account: Account, loginPath = '/login') {
  await page.goto(loginPath);

  const email = page
    .getByLabel(/email/i)
    .or(page.getByPlaceholder(/email/i))
    .or(page.locator('input[type="email"], input[name="email"], input[name="username"]'))
    .first();

  const password = page
    .getByLabel(/password/i)
    .or(page.getByPlaceholder(/password/i))
    .or(page.locator('input[type="password"], input[name="password"]'))
    .first();

  await email.fill(account.email);
  await password.fill(account.password);

  const submit = page
    .getByRole('button', { name: /sign in|log ?in|continue/i })
    .or(page.locator('button[type="submit"]'))
    .first();

  await Promise.all([
    page.waitForLoadState('networkidle').catch(() => {}),
    submit.click(),
  ]);

  // Consider login successful when we've left the login page and no error shows.
  await expect(page).not.toHaveURL(new RegExp(escapeRe(loginPath) + '\\b'));
  await expect(
    page.getByText(/invalid|incorrect|wrong|failed|denied/i)
  ).toHaveCount(0);
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
