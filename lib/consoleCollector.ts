import type { Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Browser-console error collector for the MyLS sweep.
 *
 * Originally this suite collected CSP inline-script HASHES (the old hash-based
 * policy). The policy is now NONCE + strict-dynamic, ENFORCED at the edge, so
 * there are no hashes to gather — instead we drive every flow and record what
 * actually BREAKS in the browser: console errors, uncaught exceptions and
 * failed/blocked network requests. Pure CSP-violation messages are left to
 * cspCollector (csp-findings.*); this focuses on functional breakage.
 */
export interface ConsoleEntry {
  type: 'error' | 'warning' | 'pageerror' | 'requestfailed';
  text: string;
  /** page URL where it occurred */
  url: string;
  /** source file:line:col when available */
  location?: string;
  /** the failed URL, for requestfailed */
  resource?: string;
}

// CSP messages are captured by cspCollector — don't double-report them here.
const CSP_RE =
  /content security policy|violates the following|refused to (execute|load|connect|apply|frame|create)/i;

// net::ERR_ABORTED is almost always a benign navigation/cancel; drop it to keep
// signal high. Everything else (incl. ERR_BLOCKED_BY_CSP, ERR_FAILED) is kept.
const BENIGN_REQ_RE = /ERR_ABORTED/;

/** Attach console/pageerror/requestfailed capture to a page (and call again for
 *  popups). Mirrors the page-level pattern used by attachConsoleCapture. */
export function attachConsoleErrors(page: Page, sink: ConsoleEntry[]) {
  page.on('console', (msg) => {
    const type = msg.type();
    if (type !== 'error' && type !== 'warning') return;
    const text = msg.text();
    if (CSP_RE.test(text)) return; // handled by cspCollector
    const loc = msg.location();
    sink.push({
      type: type === 'warning' ? 'warning' : 'error',
      text,
      url: page.url(),
      location: loc && loc.url ? `${loc.url}:${loc.lineNumber}:${loc.columnNumber}` : undefined,
    });
  });

  page.on('pageerror', (err) => {
    sink.push({
      type: 'pageerror',
      text: err.message || String(err),
      url: page.url(),
      location: (err.stack || '').split('\n')[1]?.trim(),
    });
  });

  page.on('requestfailed', (req) => {
    const errorText = req.failure()?.errorText || 'request failed';
    if (BENIGN_REQ_RE.test(errorText)) return;
    sink.push({
      type: 'requestfailed',
      text: errorText,
      url: page.url(),
      resource: req.url(),
    });
  });
}

function routeOf(url: string): string {
  try {
    const u = new URL(url);
    return u.hash || u.pathname || url;
  } catch {
    return url;
  }
}

/** Dedupe by type + message + resource; track count and the routes where seen. */
export function writeConsoleErrors(outDir: string, visited: string[], all: ConsoleEntry[]) {
  fs.mkdirSync(outDir, { recursive: true });

  const uniq = new Map<string, ConsoleEntry & { count: number; routes: Set<string> }>();
  for (const e of all) {
    const key = `${e.type}|${e.text}|${e.resource || ''}`;
    const cur = uniq.get(key);
    if (cur) {
      cur.count++;
      cur.routes.add(routeOf(e.url));
    } else {
      uniq.set(key, { ...e, count: 1, routes: new Set([routeOf(e.url)]) });
    }
  }
  const findings = [...uniq.values()].sort((a, b) => {
    const order = { pageerror: 0, requestfailed: 1, error: 2, warning: 3 } as const;
    return order[a.type] - order[b.type] || b.count - a.count;
  });

  fs.writeFileSync(
    path.join(outDir, 'console-errors.json'),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        visited,
        findings: findings.map((f) => ({ ...f, routes: [...f.routes] })),
      },
      null,
      2,
    ),
  );

  const counts = {
    pageerror: findings.filter((f) => f.type === 'pageerror').length,
    requestfailed: findings.filter((f) => f.type === 'requestfailed').length,
    error: findings.filter((f) => f.type === 'error').length,
    warning: findings.filter((f) => f.type === 'warning').length,
  };

  let md = `# Browser console errors — MyLS sweep\n\n`;
  md += `Generated: ${new Date().toISOString()}\n\n`;
  md += `Routes/flows visited: ${visited.length}\n\n`;
  md += `Unique findings: **${findings.length}** `;
  md += `(pageerror: ${counts.pageerror}, requestfailed: ${counts.requestfailed}, error: ${counts.error}, warning: ${counts.warning})\n\n`;
  md += `> CSP violations are reported separately in \`csp-findings.md\`. This file is\n`;
  md += `> functional breakage: JS exceptions, console errors and failed/blocked requests.\n\n`;

  if (!findings.length) {
    md += `✅ No console errors, exceptions or failed requests captured.\n`;
  } else {
    const section = (title: string, type: ConsoleEntry['type']) => {
      const rows = findings.filter((f) => f.type === type);
      if (!rows.length) return '';
      let s = `## ${title} (${rows.length})\n\n`;
      s += `| # | Message | Source / resource | Routes | Count |\n|---|---|---|---|---|\n`;
      rows.forEach((f, i) => {
        const msg = f.text.replace(/\|/g, '\\|').slice(0, 200);
        const src = (f.resource || f.location || '').replace(/\|/g, '\\|').slice(0, 120);
        const routes = [...f.routes].slice(0, 4).join('<br>');
        s += `| ${i + 1} | ${msg} | ${src} | ${routes} | ${f.count} |\n`;
      });
      return s + `\n`;
    };
    md += section('🔴 Uncaught exceptions (pageerror)', 'pageerror');
    md += section('🌐 Failed / blocked requests', 'requestfailed');
    md += section('⚠️ console.error', 'error');
    md += section('🟡 console.warning', 'warning');
  }

  fs.writeFileSync(path.join(outDir, 'console-errors.md'), md);
  return findings;
}
