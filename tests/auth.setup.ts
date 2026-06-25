import { test, expect } from '@playwright/test';
import fs from 'node:fs';

/**
 * Interactive auth bootstrap.
 *
 * Run with: `npm run auth`
 *
 * Opens a real Chrome window. Log in by hand (Google SSO + approve MFA on your
 * phone). Once the app lands back on MyLS, the authenticated session is saved
 * to `.auth/state.json`, which the `myls` project reuses for automated runs.
 *
 * The saved state expires when the underlying session/tokens expire — just run
 * `npm run auth` again to refresh it.
 */
const AUTH_STATE = '.auth/state.json';

test('manual login -> save storage state', async ({ page, context }) => {
  test.setTimeout(5 * 60 * 1000);
  fs.mkdirSync('.auth', { recursive: true });

  await page.goto('/');
  console.log('\n>>> Log in by hand in the opened window (Google SSO + MFA).');
  console.log('>>> Waiting until you land back on MyLS...\n');

  // Wait until we are authenticated and stable on the MyLS origin.
  await expect(async () => {
    const url = page.url();
    expect(url).toMatch(/my\.[a-z]+\.legitscript\.(net|com)/);
    expect(url).not.toMatch(/accounts\.google\.com|\/login\//);
  }).toPass({ timeout: 5 * 60 * 1000, intervals: [2000] });

  // give the SPA a moment to persist tokens
  await page.waitForTimeout(5000);
  await context.storageState({ path: AUTH_STATE });
  console.log(`>>> Saved authenticated state to ${AUTH_STATE}`);
});
