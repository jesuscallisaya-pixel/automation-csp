import { chromium } from '@playwright/test';

const BASE = 'https://my.development.legitscript.net';
const LABEL = process.env.LABEL || 'shot';
const WAIT = Number(process.env.WAIT || 30000);

const b = await chromium.launch({ channel: 'chrome' });
const c = await b.newContext({ storageState: '.auth/state.json', ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
const p = await c.newPage();

let styleViol = 0;
const viol = [];
p.on('console', (m) => {
  const t = m.text();
  if (/content security|refused to apply/i.test(t) && /style/i.test(t)) {
    styleViol++;
    if (viol.length < 20) viol.push(t.slice(0, 130));
  }
});

await p.goto(`${BASE}/#/account/home`, { waitUntil: 'domcontentloaded' }).catch(() => {});
await p.waitForTimeout(WAIT); // wait long enough for Intercom to fully boot

const info = await p.evaluate(() => {
  const vh = window.innerHeight, vw = window.innerWidth;
  // Probe several points across the BOTTOM strip of the viewport.
  const pts = [
    [120, vh - 30], [400, vh - 30], [800, vh - 30], [1100, vh - 30],
    [120, vh - 120], [1200, vh - 120],
  ];
  const at = pts.map(([x, y]) => {
    const el = document.elementFromPoint(x, y);
    if (!el) return { x, y, el: null };
    const r = el.getBoundingClientRect();
    return {
      x, y,
      tag: el.tagName,
      id: el.id || '',
      cls: String(el.className || '').slice(0, 70),
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      bg: getComputedStyle(el).backgroundColor,
    };
  });

  // All intercom-related nodes with geometry.
  const intercom = [...document.querySelectorAll('[class*="intercom" i],[id*="intercom" i],iframe[name="intercom-frame"]')].map((e) => {
    const r = e.getBoundingClientRect();
    return { tag: e.tagName, id: e.id || '', cls: String(e.className || '').slice(0, 60), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), pos: getComputedStyle(e).position };
  });

  // Any large block in the lower third that is NOT the nav/app shell.
  const big = [...document.querySelectorAll('div,iframe,section')].map((e) => {
    const r = e.getBoundingClientRect();
    return { e, r };
  }).filter(({ r }) => r.width > 250 && r.height > 80 && r.top > vh * 0.55 && r.bottom <= vh + 5)
    .slice(0, 8)
    .map(({ e, r }) => ({ tag: e.tagName, id: e.id || '', cls: String(e.className || '').slice(0, 70), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), bg: getComputedStyle(e).backgroundColor }));

  return { viewport: { vw, vh }, elementsAtBottom: at, intercomNodes: intercom, bigLowerBlocks: big };
});

await p.screenshot({ path: `output/bottom-${LABEL}.png` });

console.log(`MODE=${LABEL} waited=${WAIT}ms styleViolations=${styleViol}`);
console.log(JSON.stringify(info, null, 2));
console.log('sample violations:');
viol.forEach((v) => console.log('  •', v));
console.log('screenshot: output/bottom-' + LABEL + '.png');

await b.close();
