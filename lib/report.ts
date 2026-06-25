import fs from 'node:fs';
import path from 'node:path';
import type { CspViolation } from './cspCollector';
import type { ConsoleEntry } from './consoleCollector';

/**
 * Consolidated, timestamped run report.
 *
 * Each sweep writes a self-contained folder `output/reports/<YYYY-MM-DD_HH-MM-SS>/`
 * so runs never overlap/clobber each other. The folder contains:
 *   - report.md         → this consolidated report (CSP + console + image gallery)
 *   - csp-findings.*     → the per-run CSP findings (written by cspCollector)
 *   - console-errors.*   → the per-run console findings (written by consoleCollector)
 *   - screenshots/       → one PNG per directive+route captured when a violation fired
 *
 * The accumulating hash-ledger stays in the stable output/ root (cross-run).
 */
export interface ConsoleFinding extends ConsoleEntry {
  count: number;
  routes: Set<string> | string[];
}

export interface RunMeta {
  stamp: string; // 2026-06-23_17-24-52
  generatedAt: string; // ISO
  baseURL: string;
  visited: string[];
}

function routeOfDoc(url: string): string {
  try {
    const u = new URL(url);
    return u.hash || u.pathname || url;
  } catch {
    return url;
  }
}

function esc(s: string): string {
  return (s || '').replace(/\|/g, '\\|');
}

export function writeRunReport(
  reportDir: string,
  meta: RunMeta,
  csp: CspViolation[],
  consoleFindings: ConsoleFinding[],
): string {
  fs.mkdirSync(reportDir, { recursive: true });

  const totalConsole = consoleFindings.length;
  const consoleByType = {
    pageerror: consoleFindings.filter((f) => f.type === 'pageerror').length,
    requestfailed: consoleFindings.filter((f) => f.type === 'requestfailed').length,
    error: consoleFindings.filter((f) => f.type === 'error').length,
    warning: consoleFindings.filter((f) => f.type === 'warning').length,
  };

  // Unique screenshots (directive+route already deduped them at capture time).
  const shots: { file: string; directive: string; route: string }[] = [];
  const seenShot = new Set<string>();
  for (const f of csp) {
    if (f.screenshot && !seenShot.has(f.screenshot)) {
      seenShot.add(f.screenshot);
      shots.push({ file: f.screenshot, directive: f.directive, route: routeOfDoc(f.docURL || '') });
    }
  }

  let md = `# MyLS CSP sweep report — ${meta.stamp}\n\n`;
  md += `- **Generated:** ${meta.generatedAt}\n`;
  md += `- **Target:** ${meta.baseURL}\n`;
  md += `- **Routes/flows visited:** ${meta.visited.length}\n`;
  md += `- **CSP violations:** ${csp.length}\n`;
  md += `- **Console findings:** ${totalConsole} `;
  md += `(pageerror: ${consoleByType.pageerror}, requestfailed: ${consoleByType.requestfailed}, error: ${consoleByType.error}, warning: ${consoleByType.warning})\n`;
  md += `- **Screenshots captured:** ${shots.length}\n\n`;

  // Quick verdict line.
  if (!csp.length && !totalConsole) {
    md += `> ✅ Clean run — no CSP violations and no console errors captured.\n\n`;
  } else {
    md += `> ⚠️ ${csp.length} CSP violation(s) and ${totalConsole} console finding(s) captured. Details below.\n\n`;
  }

  // ---------------------------------------------------------------- CSP
  md += `## 1 · CSP violations (${csp.length})\n\n`;
  if (!csp.length) {
    md += `✅ No CSP violations captured for legitimate resources.\n\n`;
  } else {
    md += `| # | Directive | Blocked | Source (file:line) | Route | Hash | Screenshot |\n`;
    md += `|---|---|---|---|---|---|---|\n`;
    csp.forEach((f, i) => {
      const src = f.sourceFile ? `${f.sourceFile.split('/').pop()}${f.line != null ? ':' + f.line : ''}` : '—';
      const route = routeOfDoc(f.docURL || '');
      const shot = f.screenshot ? `[view](screenshots/${f.screenshot})` : '';
      md += `| ${i + 1} | \`${f.directive}\` | ${esc(f.blockedURI)} | ${esc(src)} | ${esc(route)} | ${f.hash ? '`' + f.hash + '`' : ''} | ${shot} |\n`;
    });
    md += `\n`;
  }

  // ---------------------------------------------------------------- Console
  md += `## 2 · Console findings (${totalConsole})\n\n`;
  if (!totalConsole) {
    md += `✅ No console errors, exceptions or failed requests captured.\n\n`;
  } else {
    const section = (title: string, type: ConsoleEntry['type']) => {
      const rows = consoleFindings.filter((f) => f.type === type);
      if (!rows.length) return '';
      let s = `### ${title} (${rows.length})\n\n`;
      s += `| # | Message | Source / resource | Routes | Count |\n|---|---|---|---|---|\n`;
      rows.forEach((f, i) => {
        const msg = esc(f.text).slice(0, 200);
        const srcRaw = f.resource || f.location || '';
        const src = esc(srcRaw).slice(0, 120);
        const routesArr = Array.isArray(f.routes) ? f.routes : [...f.routes];
        const routes = routesArr.slice(0, 4).join('<br>');
        s += `| ${i + 1} | ${msg} | ${src} | ${routes} | ${f.count} |\n`;
      });
      return s + `\n`;
    };
    md += section('🔴 Uncaught exceptions (pageerror)', 'pageerror');
    md += section('🌐 Failed / blocked requests', 'requestfailed');
    md += section('⚠️ console.error', 'error');
    md += section('🟡 console.warning', 'warning');
  }

  // ---------------------------------------------------------------- Gallery
  md += `## 3 · Screenshot gallery (${shots.length})\n\n`;
  if (!shots.length) {
    md += `_No screenshots — screenshots are only captured when a CSP violation fires._\n`;
  } else {
    for (const s of shots) {
      md += `### \`${s.directive}\` — ${s.route}\n\n`;
      md += `![${s.directive} on ${s.route}](screenshots/${s.file})\n\n`;
    }
  }

  const reportPath = path.join(reportDir, 'report.md');
  fs.writeFileSync(reportPath, md);

  // Machine-readable twin.
  fs.writeFileSync(
    path.join(reportDir, 'report.json'),
    JSON.stringify(
      {
        ...meta,
        cspViolations: csp,
        consoleFindings: consoleFindings.map((f) => ({
          ...f,
          routes: Array.isArray(f.routes) ? f.routes : [...f.routes],
        })),
        screenshots: shots,
      },
      null,
      2,
    ),
  );

  return reportPath;
}
