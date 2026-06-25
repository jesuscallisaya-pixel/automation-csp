import { chromium } from '@playwright/test';

const BASE = process.env.MYLS_BASE_URL || 'https://my.development.legitscript.net';
const LABEL = process.env.LABEL || 'shot';

const browser = await chromium.launch({ channel: 'chrome' });
const ctx = await browser.newContext({
  storageState: '.auth/state.json',
  ignoreHTTPSErrors: true,
  viewport: { width: 1280, height: 900 },
});
const page = await ctx.newPage();

const cspIntercom = [];
page.on('console', (m) => {
  const t = m.text();
  if (/content security|refused to (apply|load)/i.test(t) && /intercom|e00fsmjg|frame-modern/i.test(t)) {
    cspIntercom.push(t.slice(0, 160));
  }
});

await page.goto(BASE, { waitUntil: 'domcontentloaded' }).catch(() => {});
// Intercom boots a few seconds AFTER login/account load.
await page.waitForTimeout(14000);

const url = page.url();
const loggedIn = !/accounts\.google\.com|\/login\//.test(url);

const info = await page.evaluate(() => {
  const sels = [
    '.intercom-lightweight-app',
    '#intercom-container',
    'iframe[name="intercom-frame"]',
    '.intercom-launcher',
    '.intercom-app',
    '[class*="intercom"]',
    '[id*="intercom"]',
  ];
  const out = {};
  for (const s of sels) {
    const els = document.querySelectorAll(s);
    out[s] = els.length;
  }
  // Geometry of the first intercom-ish element, if any.
  const any = document.querySelector('[class*="intercom"],[id*="intercom"],iframe[name="intercom-frame"]');
  if (any) {
    const r = any.getBoundingClientRect();
    out._firstRect = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    out._firstTag = any.tagName + (any.className ? '.' + String(any.className).slice(0, 60) : '');
  }
  return out;
});

await page.screenshot({ path: `output/intercom-${LABEL}.png`, fullPage: true });

console.log('URL:', url);
console.log('loggedIn:', loggedIn);
console.log('intercom DOM:', JSON.stringify(info, null, 2));
console.log('csp intercom violations seen:', cspIntercom.length);
cspIntercom.slice(0, 5).forEach((m) => console.log('  •', m));
console.log('screenshot:', `output/intercom-${LABEL}.png`);

await browser.close();
