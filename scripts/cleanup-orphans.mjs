// One-off: delete leftover "csp-test-*" filter sets created by the CSP sweep's
// "save filter set as" flow, from Merchant Monitoring and Merchant Onboarding on
// the targeted MyLS environment. Reuses the saved auth session (.auth/state.json).
//
// Usage:
//   node scripts/cleanup-orphans.mjs                 # development (default), headless
//   HEADED=1 node scripts/cleanup-orphans.mjs        # watch it
//   ORPHAN_PREFIX=csp-test- node scripts/cleanup-orphans.mjs
//   MYLS_BASE_URL=https://my.staging.legitscript.com node scripts/cleanup-orphans.mjs
//
// If the saved session is stale (e.g. the sweep signed out), refresh it first
// with `npm run auth`.
import { chromium } from '@playwright/test';

const BASE = process.env.MYLS_BASE_URL || 'https://my.development.legitscript.net';
const PREFIX = process.env.ORPHAN_PREFIX || 'csp-test-';
const ROUTES = ['#/merchant-monitoring/merchant-list', '#/merchant-onboarding'];

const browser = await chromium.launch({ channel: 'chrome', headless: !process.env.HEADED });
const context = await browser.newContext({
  storageState: '.auth/state.json',
  ignoreHTTPSErrors: true,
});
const page = await context.newPage();
page.setDefaultTimeout(8000);

let deleted = 0;
try {
  for (const route of ROUTES) {
    await page.goto(BASE + '/' + route, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(4000); // let the SPA render the filter bar before opening the menu

    if (/accounts\.google\.com|\/login\//.test(page.url())) {
      console.error('Session looks stale (bounced to login). Run `npm run auth` and retry.');
      process.exitCode = 1;
      break;
    }

    // Collect the exact names of all matching sets first, then delete each by
    // name with verification (deletion is async, so matching ".first()" in a
    // loop can re-hit a stale node — delete-by-name avoids that).
    if (!(await openMenu(page))) continue;
    await page.waitForTimeout(900);
    const allNames = await page.locator('.filter-item-name').allInnerTexts().catch(() => []);
    await page.keyboard.press('Escape').catch(() => {});
    // Only the EXACT shape the automation creates: `<prefix><timestamp digits>`.
    // This guards real filter sets even if one happens to share the prefix word.
    const targetRe = new RegExp(`^${PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\d+$`);
    const targets = [...new Set(allNames.map((s) => s.trim()).filter((n) => targetRe.test(n)))];
    if (!targets.length) {
      console.log(`no "${PREFIX}*" sets on ${route}`);
      continue;
    }
    console.log(`${route}: ${targets.length} target(s) -> ${targets.join(', ')}`);
    for (const name of targets) {
      const ok = await deleteByName(page, name);
      if (ok) {
        deleted++;
        console.log(`  deleted "${name}"`);
      } else {
        console.log(`  could NOT delete "${name}" (still present after confirm)`);
      }
    }
  }
} finally {
  console.log(`\nDone. Deleted ${deleted} orphan filter set(s) matching "${PREFIX}" on ${BASE}.`);
  await browser.close();
}

// Delete a filter set by exact name, then verify it is gone (retry once).
async function deleteByName(page, name) {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!(await openMenu(page))) return false;
    await page.waitForTimeout(800);
    const item = page
      .locator('.filter-menu-item', { has: page.locator('.filter-item-name', { hasText: name }) })
      .first();
    if (!(await item.isVisible({ timeout: 2000 }).catch(() => false))) {
      await page.keyboard.press('Escape').catch(() => {});
      return true; // already gone
    }
    await item.hover().catch(() => {});
    await page.waitForTimeout(200);
    await item.locator('i.pi-trash.action-item').first().click().catch(() => {});
    await page.waitForTimeout(500);
    await clickText(page, /delete filter/i); // confirm dialog
    await page.waitForTimeout(1500); // let the async delete + menu refresh settle
    // verify
    if (!(await openMenu(page))) return true;
    await page.waitForTimeout(700);
    const stillThere = await page
      .locator('.filter-menu-item', { has: page.locator('.filter-item-name', { hasText: name }) })
      .first()
      .isVisible({ timeout: 1500 })
      .catch(() => false);
    await page.keyboard.press('Escape').catch(() => {});
    if (!stillThere) return true;
  }
  return false;
}

async function openMenu(page) {
  const btn = page.locator('.filter-drop-down button, button.filter-drop-down').first();
  if (await btn.isVisible({ timeout: 2500 }).catch(() => false)) {
    await btn.click().catch(() => {});
    return true;
  }
  return false;
}

async function clickText(page, re) {
  for (const loc of [page.getByRole('button', { name: re }), page.getByText(re)]) {
    const el = loc.first();
    if (await el.isVisible({ timeout: 1500 }).catch(() => false)) {
      await el.click().catch(() => {});
      return true;
    }
  }
  return false;
}
