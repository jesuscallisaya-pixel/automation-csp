import { chromium } from '@playwright/test';

/**
 * Captures the style-src violations that remain under the CURRENT deployed policy
 * (strict + unsafe-hashes + 2 Intercom hashes), to assess whether the PrimeNG
 * ones are worth hashing: count, element vs attribute, and stability across two
 * reloads of the same view.
 */
const BASE = 'https://my.development.legitscript.net';
const b = await chromium.launch({ channel: 'chrome' });
const c = await b.newContext({ storageState: '.auth/state.json', ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
const p = await c.newPage();

const seen = new Map(); // key hash|source -> { hash, source, isAttr, count, reloads:Set }
let pass = 0;
p.on('console', (m) => {
  const t = m.text();
  if (!/content security|refused to apply/i.test(t) || !/style/i.test(t)) return;
  // The SUGGESTED hash for the blocked style is in "a hash ('sha256-…')" —
  // NOT the first sha256 in the message (those are the policy's own hashes).
  const hash = (t.match(/a hash \('?(sha256-[A-Za-z0-9+/=]+)'?\)/) || [])[1] || '(none)';
  const isAttr = /style attributes/i.test(t); // Chrome adds this note only for attributes
  const loc = m.location();
  const source = loc && loc.url ? `${loc.url.split('/').pop()}:${loc.lineNumber}` : '?';
  const key = `${hash}|${source}`;
  const rec = seen.get(key) || { hash, source, isAttr, count: 0, reloads: new Set() };
  rec.count++;
  rec.reloads.add(pass);
  seen.set(key, rec);
});

async function visit(route, label) {
  await p.goto(`${BASE}/${route}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await p.waitForTimeout(9000);
}

// Warm up + reach merchant-monitoring through the UI, plus home & account-details.
pass = 1;
await visit('#/account/home', 'home-1');
await visit('#/account/account-details', 'acctdet-1');
await visit('#/merchant-monitoring/merchant-list', 'mm-1');
pass = 2; // reload pass for stability
await visit('#/account/home', 'home-2');
await visit('#/account/account-details', 'acctdet-2');
await visit('#/merchant-monitoring/merchant-list', 'mm-2');

const rows = [...seen.values()];
const attrs = rows.filter((r) => r.isAttr);
const elems = rows.filter((r) => !r.isAttr);
const stable = rows.filter((r) => r.reloads.has(1) && r.reloads.has(2));

console.log(`Unique style violations remaining: ${rows.length}`);
console.log(`  <style> elements (hashable): ${elems.length}`);
console.log(`  style attributes (need unsafe-hashes): ${attrs.length}`);
console.log(`  stable across both reload passes: ${stable.length}/${rows.length}`);
console.log('');
console.log('detail (hash | source | type | stable):');
for (const r of rows) {
  console.log(`  ${r.hash}  ${r.source}  ${r.isAttr ? 'ATTR' : 'elem'}  ${r.reloads.has(1) && r.reloads.has(2) ? 'stable' : 'one-pass'}`);
}

await b.close();
