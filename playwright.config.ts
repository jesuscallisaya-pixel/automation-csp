import { defineConfig, devices } from '@playwright/test';

/**
 * CSP validation suite for MyLS (portal-ui).
 *
 * Auth model: MyLS logs in via Google SSO + MFA, which cannot be scripted
 * non-interactively. We therefore use Playwright's storageState pattern:
 *   1. `npm run auth` opens a real browser, you log in by hand ONCE, and the
 *      authenticated session is saved to `.auth/state.json`.
 *   2. The `myls` project reuses that state to run all flows automatically.
 *
 * We use the installed Google Chrome (channel: 'chrome') so no Chromium
 * download is required.
 */
const BASE_URL = process.env.MYLS_BASE_URL || 'https://my.development.legitscript.net';
const AUTH_STATE = '.auth/state.json';

export default defineConfig({
  testDir: './tests',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: BASE_URL,
    channel: 'chrome',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    ignoreHTTPSErrors: true,
    // SLOWMO (ms) delays each action so a headed run is watchable.
    // Set automatically by `npm run test:headed`.
    launchOptions: { slowMo: Number(process.env.SLOWMO) || 0 },
  },
  projects: [
    {
      // Run manually: `npm run auth`. Opens headed, you log in, saves state.
      name: 'setup',
      testMatch: /auth\.setup\.ts/,
      use: { ...devices['Desktop Chrome'], channel: 'chrome', headless: false },
    },
    {
      // The actual CSP validation. Reuses the saved auth state.
      name: 'myls',
      testMatch: /csp\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], channel: 'chrome', storageState: AUTH_STATE },
      // Note: not declared as `dependencies: ['setup']` so CI/headless runs
      // don't trigger an interactive login. Run `npm run auth` first.
    },
  ],
});
