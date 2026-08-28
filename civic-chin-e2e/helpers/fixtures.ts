import { test as base, expect, Page } from '@playwright/test';
import { ACCOUNTS, Role } from './accounts';
import { login } from './login';

/**
 * Role fixtures. In a spec:
 *
 *     import { test, expect } from '../helpers/fixtures';
 *     test('...', async ({ asMuniAdmin }) => { const page = await asMuniAdmin(); });
 *
 * Each fixture returns a Page already signed in as that role. It reuses the
 * cached storageState from `npm run auth` when present; otherwise it logs in
 * fresh via the UI. This is what makes "you sign in, I drive" work — export your
 * session once (see auth.setup.ts) and every spec picks it up.
 */
type RoleFactory = () => Promise<Page>;

export const test = base.extend<{
  asRole: (role: Role) => Promise<Page>;
  asCivicAdmin: RoleFactory;
  asMuniAdmin: RoleFactory;
  asAcmeAdmin: RoleFactory;
  asTyrellAdmin: RoleFactory;
}>({
  asRole: async ({ browser }, use) => {
    const pages: Page[] = [];
    const factory = async (role: Role): Promise<Page> => {
      const account = ACCOUNTS[role];
      let context;
      try {
        // Reuse a previously captured signed-in session if we have one.
        context = await browser.newContext({ storageState: account.storageState });
      } catch {
        context = await browser.newContext();
      }
      const page = await context.newPage();
      pages.push(page);

      await page.goto('/');
      const onLogin = /login|sign-?in/i.test(page.url());
      if (onLogin) await login(page, account);
      return page;
    };
    await use(factory);
    for (const p of pages) await p.context().close();
  },

  asCivicAdmin: async ({ asRole }, use) => { await use(() => asRole('civicAdmin')); },
  asMuniAdmin: async ({ asRole }, use) => { await use(() => asRole('muniAdmin')); },
  asAcmeAdmin: async ({ asRole }, use) => { await use(() => asRole('acmeAdmin')); },
  asTyrellAdmin: async ({ asRole }, use) => { await use(() => asRole('tyrellAdmin')); },
});

export { expect };
