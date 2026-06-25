import { chromium } from '@playwright/test';
import fs from 'node:fs';

/**
 * Interaction A/B: drives PrimeNG overlays (filter dropdowns, menus, dialogs)
 * on the Merchant Monitoring list — where runtime inline styles (positioning/
 * size) actually matter — and records per interaction the style-src violations
 * fired and the opened overlay geometry. UI-driven navigation (click the card)
 * because direct hash nav bounces to home on a cold load.
 *
 *   LABEL=unsafe node scripts/interact-shot.mjs
 *   LABEL=strict node scripts/interact-shot.mjs
 */
const BASE = process.env.MYLS_BASE_URL || 'https://my.development.legitscript.net';
const LABEL = process.env.LABEL || 'shot';
const outDir = `output/interact/${LABEL}`;
fs.mkdirSync(outDir, { recursive: true });

const PANEL_SEL =
  '.p-dropdown-panel, .p-multiselect-panel, .p-overlaypanel, .p-menu, .p-tieredmenu, .p-datepicker, .p-autocomplete-panel, .p-dialog, .p-confirm-popup, .p-overlay, [class*="overlay-panel"]';

const browser = await chromium.launch({ channel: 'chrome' });
const ctx = await browser.newContext({
  storageState: '.auth/state.json',
  ignoreHTTPSErrors: true,
  viewport: { width: 1280, height: 900 },
});
const page = await ctx.newPage();

let styleViol = 0;
const violMsgs = [];
page.on('console', (m) => {
  const t = m.text();
  if (/content security|refused to apply/i.test(t) && /style/i.test(t)) {
    styleViol++;
    if (violMsgs.length < 40) violMsgs.push(t.slice(0, 140));
  }
});

const results = [];

async function measureOverlays() {
  return page.evaluate((sel) => {
    return [...document.querySelectorAll(sel)]
      .filter((e) => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      })
      .map((e) => {
        const r = e.getBoundingClientRect();
        const styleAttr = e.getAttribute('style');
        return {
          cls: String(e.className).slice(0, 60),
          x: Math.round(r.x),
          y: Math.round(r.y),
          w: Math.round(r.width),
          h: Math.round(r.height),
          topLeftish: r.x < 40 && r.y < 80,
          inlineStyle: styleAttr ? styleAttr.slice(0, 90) : null,
        };
      });
  }, PANEL_SEL);
}

async function step(name, clickFn) {
  styleViol = 0;
  try {
    await clickFn();
  } catch (e) {
    console.log(`[${LABEL}] ${name}: click FAILED (${e.message.split('\n')[0].slice(0, 60)})`);
    results.push({ name, clicked: false });
    return;
  }
  await page.waitForTimeout(1600);
  const overlays = await measureOverlays();
  await page.screenshot({ path: `${outDir}/${name}.png` });
  results.push({ name, clicked: true, styleViol, overlays });
  console.log(`[${LABEL}] ${name}: violations=${styleViol} overlays=${overlays.length} ${JSON.stringify(overlays.slice(0, 1))}`);
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(400);
}

// 1) Warm up on home, then navigate via the UI (reliable).
await page.goto(`${BASE}/#/account/home`, { waitUntil: 'domcontentloaded' }).catch(() => {});
await page.waitForTimeout(8000);
try {
  // Merchant Monitoring card -> "Open"
  await page.getByRole('button', { name: /open/i }).first().click({ timeout: 8000 });
} catch {
  await page.goto(`${BASE}/#/merchant-monitoring/merchant-list`, { waitUntil: 'domcontentloaded' }).catch(() => {});
}
await page.waitForTimeout(12000);

const heading = await page.evaluate(() => (document.body.innerText.match(/Merchant Monitoring/i) ? true : false));
console.log(`[${LABEL}] on Merchant Monitoring page: ${heading}  url=${page.url()}`);
await page.screenshot({ path: `${outDir}/00-initial.png` });

// 2) Interactions. Filter pills are clickable text; menus/buttons by name.
await step('01-mid-filter', async () => {
  await page.getByText(/^MID$/i).first().click({ timeout: 6000 });
});
await step('02-status-filter', async () => {
  await page.getByText(/Status/i).first().click({ timeout: 6000 });
});
await step('03-add-filter', async () => {
  await page.getByText(/Add filter/i).first().click({ timeout: 6000 });
});
await step('04-more-menu', async () => {
  await page.getByText(/^More$/i).first().click({ timeout: 6000 });
});
await step('05-add-merchants', async () => {
  await page.getByText(/Add Merchants/i).first().click({ timeout: 6000 });
});
await step('06-any-dropdown', async () => {
  await page.locator('p-dropdown, .p-dropdown, p-multiselect, .p-multiselect').first().click({ timeout: 6000 });
});

const metrics = { label: LABEL, base: BASE, capturedAt: new Date().toISOString(), onMmPage: heading, results, sampleViolations: violMsgs };
fs.writeFileSync(`output/interact/${LABEL}.json`, JSON.stringify(metrics, null, 2));
console.log(`\nmetrics: output/interact/${LABEL}.json`);

await browser.close();
