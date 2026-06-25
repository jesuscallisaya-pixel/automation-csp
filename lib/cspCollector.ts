import type { BrowserContext, Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

export interface CspViolation {
  directive: string;
  blockedURI: string;
  docURL: string;
  sourceFile?: string;
  line?: number;
  /** "page" = securitypolicyviolation event; "console" = console message */
  via: 'page' | 'console';
  /** raw console text, when via === 'console' */
  raw?: string;
  /** sha256 Chrome suggests for an inline script/style, when present */
  hash?: string;
  /** screenshot filename (relative to the screenshots dir) captured at the
   * moment the violation fired, when screenshot capture is enabled */
  screenshot?: string;
}

const ORIGIN_RE = /legitscript\.(net|com)/;

/**
 * Screenshot capture for CSP violations. Deduped by directive+route so we get
 * ONE screenshot per page state (all 14 PrimeNG styles on a route share the same
 * broken view), not one per hash. The filename is reserved before the async
 * screenshot so a page event + its console twin don't double-capture.
 */
export interface ScreenshotOpts {
  dir: string;
  files: Map<string, string>; // key "directive|route" -> relative png filename
}

async function captureShot(page: Page, v: CspViolation, shot?: ScreenshotOpts) {
  if (!shot) return;
  if (!ORIGIN_RE.test(v.docURL || '')) return;
  const route = routeFromUrl(v.docURL || '');
  const key = `${v.directive}|${route}`;
  const existing = shot.files.get(key);
  if (existing) {
    v.screenshot = existing; // another violation already shot this page state
    return;
  }
  const safe = key.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'shot';
  const rel = `${String(shot.files.size + 1).padStart(2, '0')}-${safe}.png`;
  shot.files.set(key, rel); // reserve BEFORE awaiting to prevent a double-capture
  try {
    await page.screenshot({ path: path.join(shot.dir, rel), fullPage: true });
    v.screenshot = rel;
  } catch {
    /* page may have navigated/closed before the shot — leave it unset */
  }
}

/**
 * Installs CSP violation capture on a context. Survives navigations and new
 * pages because it uses addInitScript + exposeBinding. When `shot` is provided,
 * a screenshot of the broken page is captured on the first violation per route.
 */
export async function installCspCapture(
  context: BrowserContext,
  sink: CspViolation[],
  shot?: ScreenshotOpts,
) {
  await context.exposeBinding('__cspReport', async (source, v: CspViolation) => {
    const viol: CspViolation = { ...v, via: 'page' };
    sink.push(viol);
    await captureShot(source.page, viol, shot);
  });
  await context.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      const ev = e as SecurityPolicyViolationEvent;
      // @ts-expect-error exposed binding
      window.__cspReport({
        directive: ev.effectiveDirective || ev.violatedDirective,
        blockedURI: ev.blockedURI,
        docURL: location.href,
        sourceFile: ev.sourceFile,
        line: ev.lineNumber,
      });
    });
  });
}

/**
 * Extract the sha256 Chrome suggests for a blocked inline script/style.
 * Anchored to "a hash ('sha256-…')" so we do NOT pick up the existing hashes
 * that Chrome echoes back inside the policy text of the same message.
 */
function extractHash(text: string): string | undefined {
  return (text.match(/a hash \('?(sha256-[A-Za-z0-9+/=]+)'?\)/) || [])[1];
}

/**
 * Extract the blocked resource. Only look at the text BEFORE "because it
 * violates" / "violates the following" — after that Chrome echoes the whole
 * policy (with its allowlisted hosts), which would otherwise be mis-read as the
 * blocked URL (the old "unknown -> js.stripe.com" false positive).
 */
function extractBlocked(text: string): string {
  const head = text.split(/because it violates|violates the following/i)[0];
  const url = (head.match(/'(https?:\/\/[^'\s]+)'/) || head.match(/(https?:\/\/[^'"\s]+)/) || [])[1];
  if (url) return url;
  if (/inline (script|event handler)|executing inline|apply inline style|inline style/i.test(text)) return 'inline';
  return 'unknown';
}

function extractDirective(text: string): string {
  const m = text.match(/directive:?\s*['"]?([a-z-]+)/i);
  if (m) return m[1];
  if (/refused to frame|\bframe-src\b/i.test(text)) return 'frame-src';
  if (/inline script|executing inline|refused to (load|execute).*script|\bscript-src/i.test(text)) return 'script-src';
  if (/refused to connect|\bconnect-src\b/i.test(text)) return 'connect-src';
  if (/refused to create a worker|\bworker-src\b/i.test(text)) return 'worker-src';
  if (/inline style|apply inline style|\bstyle-src\b/i.test(text)) return 'style-src';
  return 'unknown';
}

/** Also capture CSP messages that only appear in the console (carry the hash). */
export function attachConsoleCapture(page: Page, sink: CspViolation[], shot?: ScreenshotOpts) {
  page.on('console', async (msg) => {
    const t = msg.text();
    if (
      !/content security policy|violates the following|refused to (execute|load|connect|apply|frame|create)/i.test(t)
    ) {
      return;
    }
    // Chrome reports WHERE the blocked inline style/script lives (e.g.
    // layout.component.html:196). Capture it so we can triage ours vs 3rd-party.
    const loc = msg.location();
    const viol: CspViolation = {
      directive: extractDirective(t),
      blockedURI: extractBlocked(t),
      docURL: page.url(),
      sourceFile: loc && loc.url ? loc.url : undefined,
      line: loc ? loc.lineNumber : undefined,
      via: 'console',
      raw: t,
      hash: extractHash(t),
    };
    sink.push(viol);
    await captureShot(page, viol, shot);
  });
}

/**
 * Keep only violations on a LegitScript origin, deduped. The dedupe key includes
 * the hash so distinct inline scripts (all blockedURI="inline") are NOT collapsed
 * into a single entry. Hashless inline entries (page events) are dropped when an
 * equivalent entry WITH a hash exists.
 */
export function dedupeOwnOrigin(all: CspViolation[]): CspViolation[] {
  const uniq = new Map<string, CspViolation>();
  for (const v of all) {
    if (!ORIGIN_RE.test(v.docURL || '')) continue;
    const blocked = (v.blockedURI || '').split('?')[0];
    const key = `${v.directive}|${blocked}|${v.hash || ''}`;
    if (!uniq.has(key)) uniq.set(key, v);
  }
  // Drop hashless "inline" entries if any hashed inline exists (they're the same
  // violation seen via the page event, which doesn't carry the hash).
  const hasHashedInline = [...uniq.values()].some((v) => v.blockedURI === 'inline' && v.hash);
  if (hasHashedInline) {
    for (const [k, v] of uniq) {
      if (v.blockedURI === 'inline' && !v.hash) uniq.delete(k);
    }
  }
  return [...uniq.values()];
}

/** Map a MyLS docURL to an environment label (development | staging | production). */
export function envFromUrl(url: string): string {
  try {
    const host = new URL(url).host;
    const m = host.match(/my\.([a-z]+)\.legitscript\.(net|com)/i);
    if (m) return m[1].toLowerCase(); // development | staging
    if (/^my\.legitscript\.com$/i.test(host)) return 'production';
    return host || 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Short route label (#/hash or pathname) from a docURL. */
function routeFromUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.hash || u.pathname || url;
  } catch {
    return url;
  }
}

/* -------------------------------------------------------------------------
 * Cross-run / cross-environment hash ledger.
 *
 * `csp-findings.*` is overwritten every run and only reflects THAT run. The
 * ledger ACCUMULATES every inline-script hash ever captured as a violation,
 * recording which environment(s) and route(s) each one appeared in. Because a
 * hash that is already in the deployed policy no longer violates (so it won't
 * reappear), the ledger is how we (a) never lose a previously captured hash and
 * (b) detect drift: when the same policy is deployed to staging/prod, any inline
 * whose hash differs there gets BLOCKED → shows up as a new violation → lands in
 * the ledger flagged as environment-specific.
 * ---------------------------------------------------------------------- */
export interface HashEnvRecord {
  firstSeen: string;
  lastSeen: string;
  routes: string[];
}
export interface HashRecord {
  directive: string;
  firstSeen: string;
  lastSeen: string;
  environments: Record<string, HashEnvRecord>;
}
export interface HashLedger {
  updatedAt: string;
  hashes: Record<string, HashRecord>;
}

export function updateHashLedger(outDir: string, findings: CspViolation[]): HashLedger {
  const file = path.join(outDir, 'hash-ledger.json');
  let ledger: HashLedger = { updatedAt: '', hashes: {} };
  if (fs.existsSync(file)) {
    try {
      ledger = JSON.parse(fs.readFileSync(file, 'utf8')) as HashLedger;
      ledger.hashes ??= {};
    } catch {
      /* corrupt/empty — start fresh */
    }
  }
  const now = new Date().toISOString();
  for (const f of findings) {
    if (!f.hash) continue;
    const env = envFromUrl(f.docURL);
    const route = routeFromUrl(f.docURL);
    const rec = (ledger.hashes[f.hash] ??= { directive: f.directive, firstSeen: now, lastSeen: now, environments: {} });
    rec.lastSeen = now;
    if (!rec.directive || rec.directive === 'unknown') rec.directive = f.directive;
    const er = (rec.environments[env] ??= { firstSeen: now, lastSeen: now, routes: [] });
    er.lastSeen = now;
    if (route && !er.routes.includes(route)) er.routes.push(route);
  }
  ledger.updatedAt = now;
  fs.writeFileSync(file, JSON.stringify(ledger, null, 2));
  writeLedgerMd(outDir, ledger);
  return ledger;
}

function writeLedgerMd(outDir: string, ledger: HashLedger) {
  const hashes = Object.entries(ledger.hashes);
  const allEnvs = [...new Set(hashes.flatMap(([, r]) => Object.keys(r.environments)))].sort();

  let md = `# CSP hash ledger — MyLS\n\n`;
  md += `Accumulates every inline-script hash captured as a CSP violation, across runs AND environments.\n`;
  md += `Use it to keep the full hash list and to spot hashes that differ per environment.\n\n`;
  md += `Updated: ${ledger.updatedAt}\n`;
  md += `Unique hashes: **${hashes.length}**\n`;
  md += `Environments seen: ${allEnvs.length ? allEnvs.join(', ') : '—'}\n\n`;

  // Drift detection (only meaningful once >1 environment has been swept).
  if (allEnvs.length > 1) {
    const envSpecific = hashes.filter(([, r]) => Object.keys(r.environments).length < allEnvs.length);
    md += `## ⚠️ Environment-specific hashes (potential drift)\n\n`;
    if (!envSpecific.length) {
      md += `✅ Every captured hash appeared in all swept environments (${allEnvs.join(', ')}). No drift detected.\n\n`;
    } else {
      md += `Captured in some environments but not others — confirm whether the GTM container / content differs:\n\n`;
      md += `| Hash | Seen in | Missing from |\n|---|---|---|\n`;
      for (const [h, r] of envSpecific) {
        const seen = Object.keys(r.environments);
        const missing = allEnvs.filter((e) => !seen.includes(e));
        md += `| \`${h}\` | ${seen.join(', ')} | ${missing.join(', ')} |\n`;
      }
      md += `\n`;
    }
  }

  md += `## All captured hashes (${hashes.length})\n\n`;
  md += `| Hash | Directive | Environments | Routes | First seen |\n|---|---|---|---|---|\n`;
  for (const [h, r] of hashes) {
    const envs = Object.keys(r.environments).join(', ');
    const routes = [...new Set(Object.values(r.environments).flatMap((e) => e.routes))].join('<br>');
    md += `| \`${h}\` | ${r.directive} | ${envs} | ${routes} | ${r.firstSeen.slice(0, 10)} |\n`;
  }

  md += `\n## Paste block — all hashes (SCRIPT_HASHES)\n\n`;
  md += `\`\`\`js\n`;
  for (const [h, r] of hashes) {
    md += `"'${h}'", // ${Object.keys(r.environments).join('/')}\n`;
  }
  md += `\`\`\`\n`;

  fs.writeFileSync(path.join(outDir, 'hash-ledger.md'), md);
}

export function writeFindings(
  outDir: string,
  visited: string[],
  all: CspViolation[],
  ledgerDir: string = outDir,
) {
  fs.mkdirSync(outDir, { recursive: true });
  const findings = dedupeOwnOrigin(all);

  // Accumulate into the cross-run / cross-environment hash ledger. This lives in
  // a STABLE dir (output/ root) so it survives across timestamped run folders.
  fs.mkdirSync(ledgerDir, { recursive: true });
  updateHashLedger(ledgerDir, findings);

  fs.writeFileSync(
    path.join(outDir, 'csp-findings.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), visited, findings }, null, 2),
  );

  const byDirective = new Map<string, Set<string>>();
  for (const f of findings) {
    if (!byDirective.has(f.directive)) byDirective.set(f.directive, new Set());
    byDirective.get(f.directive)!.add(f.blockedURI);
  }

  // Unique inline-script hashes ready to paste into SCRIPT_HASHES.
  const hashes = new Map<string, string>(); // hash -> route/docURL where first seen
  for (const f of findings) {
    if (f.hash && !hashes.has(f.hash)) {
      let where = f.docURL;
      try {
        where = new URL(f.docURL).hash || new URL(f.docURL).pathname;
      } catch {
        /* keep raw */
      }
      hashes.set(f.hash, where || f.docURL);
    }
  }

  let md = `# CSP findings — MyLS\n\n`;
  md += `Generated: ${new Date().toISOString()}\n\n`;
  md += `Routes/flows visited: ${visited.length}\n\n`;
  md += `> This file reflects only THIS run. The accumulating, cross-environment\n`;
  md += `> record of every hash ever captured lives in \`hash-ledger.md\` / \`.json\`.\n\n`;

  if (hashes.size) {
    md += `## 🔑 Inline-script hashes to add to SCRIPT_HASHES (${hashes.size})\n\n`;
    md += `Paste these into \`viewer-response.js\` (one per line), then deploy + verify:\n\n`;
    md += '```js\n';
    for (const [h, where] of hashes) {
      md += `"'${h}'", // seen on ${where}\n`;
    }
    md += '```\n\n';
  } else {
    md += `## 🔑 Inline-script hashes\n\n✅ No new inline-script hashes captured.\n\n`;
  }

  md += `## All violations\n\n`;
  if (!findings.length) {
    md += `✅ No CSP violations captured for legitimate resources.\n`;
  } else {
    const shotCount = new Set(findings.filter((f) => f.screenshot).map((f) => f.screenshot)).size;
    md += `Found **${findings.length}** unique CSP violation(s) on LegitScript origins.`;
    md += shotCount ? ` ${shotCount} screenshot(s) saved under \`screenshots/\`.\n\n` : `\n\n`;
    md += `| Directive | Blocked resource | Source (file:line) | Route | Hash | Screenshot |\n|---|---|---|---|---|---|\n`;
    for (const f of findings) {
      let src = '';
      if (f.sourceFile) {
        src = `${f.sourceFile.split('/').pop()}${f.line != null ? ':' + f.line : ''}`;
      }
      let route = f.docURL || '';
      try {
        route = new URL(f.docURL).hash || new URL(f.docURL).pathname;
      } catch {
        /* keep */
      }
      const shotCell = f.screenshot ? `[view](screenshots/${f.screenshot})` : '';
      md += `| \`${f.directive}\` | ${f.blockedURI} | ${src || '—'} | ${route} | ${f.hash ? '`' + f.hash + '`' : ''} | ${shotCell} |\n`;
    }
    md += `\n### Suggested allowlist additions (non-inline)\n\n`;
    for (const [dir, uris] of byDirective) {
      const hosts = [...uris]
        .filter((u) => u !== 'inline' && u !== 'unknown')
        .map((u) => {
          try {
            return new URL(u).host;
          } catch {
            return u;
          }
        });
      if (hosts.length) md += `- \`${dir}\`: ${[...new Set(hosts)].map((h) => '`' + h + '`').join(', ')}\n`;
    }
  }
  fs.writeFileSync(path.join(outDir, 'csp-findings.md'), md);
  return findings;
}
