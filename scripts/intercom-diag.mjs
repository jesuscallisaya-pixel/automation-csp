import { chromium } from '@playwright/test';

const BASE = process.env.MYLS_BASE_URL || 'https://my.development.legitscript.net';
const WAIT = Number(process.env.WAIT || 15000);

const browser = await chromium.launch({ channel: 'chrome' });
const ctx = await browser.newContext({
  storageState: '.auth/state.json',
  ignoreHTTPSErrors: true,
  viewport: { width: 1280, height: 900 },
});
const page = await ctx.newPage();

const net = [];
page.on('request', (r) => {
  if (/intercom|intercomcdn/i.test(r.url())) net.push(r.url().slice(0, 110));
});
const cspStyle = [];
page.on('console', (m) => {
  const t = m.text();
  if (/content security|refused to apply/i.test(t) && /style/i.test(t)) cspStyle.push(t.slice(0, 200));
});

await page.goto(`${BASE}/#/account/home`, { waitUntil: 'domcontentloaded' }).catch(() => {});
await page.waitForTimeout(WAIT);

// What Intercom actually put in the DOM, and whether its iframes have content.
const dom = await page.evaluate(() => {
  const iframes = [...document.querySelectorAll('iframe')].map((f) => {
    const r = f.getBoundingClientRect();
    return { name: f.name || '', src: (f.src || '').slice(0, 80), w: Math.round(r.width), h: Math.round(r.height) };
  });
  const intercomEls = [...document.querySelectorAll('[class*="intercom" i],[id*="intercom" i]')].map((e) => {
    const r = e.getBoundingClientRect();
    return { tag: e.tagName, id: e.id || '', cls: (e.className || '').toString().slice(0, 60), w: Math.round(r.width), h: Math.round(r.height) };
  });
  return {
    iframeCount: iframes.length,
    iframes,
    intercomElCount: intercomEls.length,
    intercomEls,
    hasIntercomGlobal: typeof window.Intercom === 'function',
    intercomSettings: window.intercomSettings ? Object.keys(window.intercomSettings) : null,
  };
});

console.log('=== NETWORK (intercom requests) ===');
console.log(net.length ? [...new Set(net)].join('\n') : '(none — widget code never requested)');
console.log('\n=== DOM ===');
console.log(JSON.stringify(dom, null, 2));
console.log('\n=== CSP style violations during load ===', cspStyle.length);
cspStyle.slice(0, 8).forEach((m) => console.log('  •', m));

await browser.close();
