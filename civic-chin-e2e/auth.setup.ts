import { test as setup } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { ACCOUNTS, Role } from './helpers/accounts';
import { login } from './helpers/login';

/**
 * Captures a reusable signed-in session (storageState) per role into .auth/.
 * Run once before the role specs:  npm run auth
 *
 * Two ways to get a session:
 *  1. Automated (this file): logs in with the env creds and saves the state.
 *  2. "You sign in, I drive": if you're already logged in elsewhere, open the
 *     app under `npx playwright open $BASE_URL`, sign in by hand, then in that
 *     window's console run  await context.storageState({ path: '.auth/<role>.json' })
 *     — or just let this setup do it. Existing .auth/<role>.json files are reused.
 */
const rolesToSeed: Role[] = ['civicAdmin', 'muniAdmin', 'acmeAdmin', 'tyrellAdmin'];

fs.mkdirSync('.auth', { recursive: true });

for (const role of rolesToSeed) {
  const account = ACCOUNTS[role];
  setup(`authenticate ${role}`, async ({ page }) => {
    if (fs.existsSync(account.storageState)) {
      setup.info().annotations.push({ type: 'reused', description: account.storageState });
      return; // already have a session for this role
    }
    await login(page, account);
    await page.context().storageState({ path: account.storageState });
    // eslint-disable-next-line no-console
    console.log(`  saved session -> ${path.resolve(account.storageState)}`);
  });
}
