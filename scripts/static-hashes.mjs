import https from 'node:https';
import crypto from 'node:crypto';

const BASE = process.env.MYLS_BASE_URL || 'https://my.development.legitscript.net';
const PAGES = ['/assets/legal.html', '/assets/unsupported-browser.html'];

function fetch(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { rejectUnauthorized: false }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      })
      .on('error', reject);
  });
}

const sha = (s) => "'sha256-" + crypto.createHash('sha256').update(s, 'utf8').digest('base64') + "'";

for (const p of PAGES) {
  const { status, body } = await fetch(BASE + p);
  console.log(`\n=== ${p}  (HTTP ${status}, ${body.length} bytes) ===`);

  // <style> ELEMENTS
  const styleEls = [...body.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)];
  styleEls.forEach((m, i) => {
    const content = m[1];
    console.log(`  <style> #${i + 1}: ${sha(content)}  (len ${content.length})`);
  });

  // style="" ATTRIBUTES (double or single quoted)
  const attrs = [...body.matchAll(/style=("([^"]*)"|'([^']*)')/gi)];
  attrs.forEach((m, i) => {
    const val = m[2] !== undefined ? m[2] : m[3];
    console.log(`  style-attr #${i + 1}: ${sha(val)}  value="${val}"`);
  });

  if (!styleEls.length && !attrs.length) console.log('  (no inline styles found)');
}
