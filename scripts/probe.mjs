import { chromium } from '@playwright/test';

const BASE = 'https://my.development.legitscript.net';
const b = await chromium.launch({ channel: 'chrome' });
const c = await b.newContext({ storageState: '.auth/state.json', ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
const p = await c.newPage();
await p.goto(`${BASE}/#/merchant-monitoring/merchant-list`, { waitUntil: 'domcontentloaded' }).catch(() => {});
await p.waitForTimeout(12000);

const info = await p.evaluate(() => {
  const pclasses = {};
  document.querySelectorAll('[class*="p-"]').forEach((e) => {
    String(e.className).split(/\s+/).forEach((cls) => {
      if (cls.startsWith('p-')) pclasses[cls] = (pclasses[cls] || 0) + 1;
    });
  });
  const top = Object.entries(pclasses).sort((a, b) => b[1] - a[1]).slice(0, 35);

  const buttons = [...document.querySelectorAll('button, p-button, .p-button, [role="button"]')]
    .map((e) => ({ tag: e.tagName, cls: String(e.className).slice(0, 40), txt: (e.innerText || '').trim().slice(0, 30) }))
    .filter((x) => x.txt || x.cls)
    .slice(0, 25);

  const dropdowns = [...document.querySelectorAll('p-dropdown, p-multiselect, p-calendar, p-overlaypanel, .p-dropdown, .p-multiselect, .p-calendar')]
    .map((e) => ({ tag: e.tagName, cls: String(e.className).slice(0, 50) }));

  return { topPrimeClasses: top, buttons, dropdowns };
});

console.log(JSON.stringify(info, null, 2));
await b.close();
