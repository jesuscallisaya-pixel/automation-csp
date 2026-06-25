// One-off helper: attach to an ALREADY-RUNNING Chrome (started with a remote
// debugging port) that is already logged into MyLS, and export its
// authenticated storageState to .auth/state.json.
//
// Usage:
//   node scripts/grab-state.mjs <debugPort>
//
// This is a convenience for bootstrapping the auth state from an existing
// session. The normal way to (re)create the state is `npm run auth`.
import { chromium } from '@playwright/test';
import fs from 'node:fs';

const port = process.argv[2] || '9222';
const endpoint = `http://localhost:${port}`;

const browser = await chromium.connectOverCDP(endpoint);
const contexts = browser.contexts();
if (!contexts.length) {
  console.error('No browser contexts found on', endpoint);
  process.exit(1);
}
const context = contexts[0];
fs.mkdirSync('.auth', { recursive: true });
await context.storageState({ path: '.auth/state.json' });
console.log('Saved authenticated state to .auth/state.json');
await browser.close();
