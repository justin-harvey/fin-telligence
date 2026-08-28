import { test, expect } from '../helpers/fixtures';
import { watchForProblems, looksLikeErrorPage, attachProblems } from '../helpers/errors';
import { BASE_URL } from '../playwright.config';
import type { Role } from '../helpers/accounts';

const origin = new URL(BASE_URL).origin;

/**
 * Per-role smoke: the app loads while signed in, the shell renders, the landing
 * page isn't an error/blank, and nothing throws in the console.
 */
const roles: Role[] = ['civicAdmin', 'muniAdmin', 'acmeAdmin', 'tyrellAdmin'];

for (const role of roles) {
  test(`smoke: ${role} lands on a healthy page`, async ({ asRole }, testInfo) => {
    const page = await asRole(role);
    const { problems } = watchForProblems(page, origin);

    await page.goto('/');
    await page.waitForLoadState('networkidle').catch(() => {});

    const err = await looksLikeErrorPage(page);
    await attachProblems(testInfo, 'console-and-network-problems', problems);

    expect(err, `landing page unhealthy: ${err}`).toBeNull();
    expect(problems.filter((p) => p.type !== 'response'), JSON.stringify(problems, null, 2))
      .toHaveLength(0);
  });
}
