import { chromium } from '@playwright/test';
import fs from 'node:fs';

/**
 * Captures a fixed set of views with identical settings so STRICT vs
 * UNSAFE-INLINE style-src can be compared side-by-side.
 *
 *   LABEL=strict  node scripts/compare-shot.mjs    # run while strict is deployed
 *   LABEL=unsafe  node scripts/compare-shot.mjs    # run while unsafe-inline is deployed
 *
 * Output: output/compare/<label>/<slug>.png  +  output/compare/<label>.json (metrics)
 */
const BASE = process.env.MYLS_BASE_URL || 'https://my.development.legitscript.net';
const LABEL = process.env.LABEL || 'shot';
const WAIT = Number(process.env.WAIT || 11000);

const ROUTES = [
  ['account-home', '#/account/home'],
  ['account-details', '#/account/account-details'],
  ['mm-merchant-list', '#/merchant-monitoring/merchant-list'],
  ['mo-merchant-list', '#/merchant-onboarding/merchant-list'],
];

const outDir = `output/compare/${LABEL}`;
fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome' });
const ctx = await browser.newContext({
  storageState: '.auth/state.json',
  ignoreHTTPSErrors: true,
  viewport: { width: 1280, height: 900 },
});
const page = await ctx.newPage();

// Live CSP header (so the report records exactly which mode was active).
let liveStyleSrc = '';
page.on('response', (r) => {
  if (r.url().replace(/\?.*$/, '') === BASE + '/' || r.url() === BASE + '/') {
    const csp = r.headers()['content-security-policy'] || r.headers()['content-security-policy-report-only'] || '';
    const m = csp.match(/style-src[^;]*/i);
    if (m) liveStyleSrc = m[0];
  }
});

const metrics = { label: LABEL, base: BASE, capturedAt: new Date().toISOString(), liveStyleSrc: '', views: [] };

for (const [slug, route] of ROUTES) {
  let styleViolations = 0;
  const onConsole = (msg) => {
    const t = msg.text();
    if (/content security|refused to apply/i.test(t) && /style/i.test(t)) styleViolations++;
  };
  page.on('console', onConsole);

  await page.goto(`${BASE}/${route}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(WAIT);

  const dom = await page.evaluate(() => {
    const intercomFrame = document.querySelector('iframe[name="intercom-frame"], .intercom-lightweight-app, .intercom-launcher, #intercom-container');
    let launcher = null;
    const cand = document.querySelector('.intercom-launcher, .intercom-lightweight-app, iframe[name="intercom-frame"]');
    if (cand) {
      const r = cand.getBoundingClientRect();
      launcher = { tag: cand.tagName, w: Math.round(r.width), h: Math.round(r.height), visible: r.width > 0 && r.height > 0 };
    }
    return {
      intercomWidgetPresent: !!intercomFrame,
      intercomLoaderScript: !!document.querySelector('[id*="intercom"],script[src*="intercom"]'),
      launcher,
    };
  });

  await page.screenshot({ path: `${outDir}/${slug}.png`, fullPage: true });
  page.off('console', onConsole);

  metrics.views.push({ slug, route, url: page.url(), styleViolations, ...dom });
  console.log(`[${LABEL}] ${slug}: styleViolations=${styleViolations} intercomWidget=${dom.intercomWidgetPresent} launcher=${JSON.stringify(dom.launcher)}`);
}

metrics.liveStyleSrc = liveStyleSrc;
fs.writeFileSync(`output/compare/${LABEL}.json`, JSON.stringify(metrics, null, 2));
console.log(`\nlive style-src header: ${liveStyleSrc}`);
console.log(`metrics: output/compare/${LABEL}.json`);

await browser.close();
