import { defineConfig, devices } from '@playwright/test';
import dotenv from 'dotenv';

dotenv.config();

export const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000';

/**
 * Roles that get a reusable signed-in storage state. `auth.setup.ts` produces
 * one `.auth/<role>.json` per role; specs consume them via the `storageState`
 * option on their project (see below) or the role fixtures in helpers/fixtures.
 */
export const ROLES = ['civicAdmin', 'muniAdmin', 'acmeAdmin', 'tyrellAdmin'] as const;

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [['html', { open: 'never' }], ['list']],
  timeout: 60_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    // The test env serves a local-only cert / self-signed setup in some modes.
    ignoreHTTPSErrors: true,
  },

  projects: [
    // Produces .auth/<role>.json. Run once (npm run auth) before role-scoped specs.
    { name: 'setup', testDir: '.', testMatch: /auth\.setup\.ts/ },

    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['setup'],
    },
  ],
});
