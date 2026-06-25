import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import {
  installCspCapture,
  attachConsoleCapture,
  writeFindings,
  type CspViolation,
  type ScreenshotOpts,
} from '../lib/cspCollector';
import {
  attachConsoleErrors,
  writeConsoleErrors,
  type ConsoleEntry,
} from '../lib/consoleCollector';
import { writeRunReport } from '../lib/report';
import { FLOWS, SIGN_OUT } from '../lib/flows';

/**
 * Walks the authenticated MyLS app and records every CSP violation that affects
 * a legitimate resource. Findings are written to ./output (json + md).
 *
 * Requires a valid `.auth/state.json` (run `npm run auth` first).
 *
 * Coverage:
 *   1. Initial authenticated load.
 *   2. Auto-discovered in-app routes.
 *   3. Named user flows that are known to trigger GTM inline scripts
 *      (Manage Users invite/update, Merchant Monitoring URL click, ...).
 *   4. Sign-out (run last — it ends the session).
 */
const OUTPUT_DIR = 'output';

// Best-effort list of meaningful routes. Adjust as the app evolves.
// Real portal-ui routes (from layout.component.ts / routing modules).
const KNOWN_ROUTES = [
  '#/',
  '#/account/home',
  '#/account/users',
  '#/account/billing',
  '#/merchant-monitoring/merchant-list',
  '#/merchant-onboarding',
  '#/services/lookups/data',
  '#/test-transactions',
];

/** Resolve to `fallback` if `p` does not settle within `ms` (backstop so one
 * hung flow can never eat the whole budget). The underlying op keeps running but
 * is abandoned; default action/nav timeouts below keep it from hanging long. */
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);
}

test('CSP violations across authenticated MyLS flows', async ({ page, context }) => {
  test.setTimeout(12 * 60 * 1000);

  // Hard caps so no single action/navigation can hang for minutes.
  page.setDefaultTimeout(8000);
  page.setDefaultNavigationTimeout(12000);

  const violations: CspViolation[] = [];
  const consoleErrors: ConsoleEntry[] = [];

  // Timestamped run folder so reports never overlap/clobber across runs.
  // Format: output/reports/2026-06-23_17-24-52/
  const runStamp = new Date().toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-');
  const reportDir = path.join(OUTPUT_DIR, 'reports', runStamp);
  fs.mkdirSync(reportDir, { recursive: true });

  // Screenshot capture for CSP violations (on by default; set NO_SHOTS=1 to skip).
  // One screenshot per directive+route is saved INSIDE the run folder at the
  // moment a violation fires, so the broken page state is captured as evidence
  // and the whole run folder stays self-contained.
  const shotDir = path.join(reportDir, 'screenshots');
  fs.mkdirSync(shotDir, { recursive: true });
  const shot: ScreenshotOpts | undefined = process.env.NO_SHOTS
    ? undefined
    : { dir: shotDir, files: new Map<string, string>() };

  await installCspCapture(context, violations, shot);
  attachConsoleCapture(page, violations, shot);
  attachConsoleErrors(page, consoleErrors);
  // Capture console on any popup/new tab too, and auto-close it so an external
  // docs/guide page can't hold the run open.
  context.on('page', (p) => {
    attachConsoleCapture(p, violations, shot);
    attachConsoleErrors(p, consoleErrors);
    if (p !== page) p.waitForTimeout(2500).then(() => p.close().catch(() => {}));
  });

  const visited: string[] = [];

  // Findings are written in `finally` so even a partial/timed-out run leaves
  // usable output instead of nothing.
  try {
    // 1. Initial authenticated load
    await page.goto('/', { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(5000);

    // If we got bounced to login, the stored state is stale -> fail loudly.
    expect(page.url(), 'Auth state looks stale; run `npm run auth` to refresh').not.toMatch(
      /accounts\.google\.com|\/login\//,
    );

    // 2. Auto-discover in-app routes from the nav
    const discovered = await page.evaluate(() => {
      const set = new Set<string>();
      document.querySelectorAll('a[href]').forEach((a) => {
        const h = a.getAttribute('href') || '';
        if (h.startsWith('#/') || h.startsWith('/#/')) set.add(h.replace(/^\//, ''));
      });
      return Array.from(set);
    });

    const routes = Array.from(new Set([...KNOWN_ROUTES, ...discovered]));
    console.log('Routes to visit:', routes);
    for (const route of routes) {
      try {
        await page.goto('/' + route, { waitUntil: 'domcontentloaded', timeout: 20000 });
      } catch {
        /* route may not exist; keep going */
      }
      await page.waitForTimeout(1500);
      visited.push(route);
    }

    // 3. Named interaction flows (trigger GTM inline tags). Each flow is capped
    //    at 35s so a single slow flow can't starve the rest.
    // Full sweep by default: run every flow INCLUDING the ones that submit
    // (invite/update user, register merchant, save filter set) so those code
    // paths are exercised and any console errors surface. They run against dev
    // and only touch test-prefixed data. Set READONLY=1 to skip the submits.
    const RUN_DESTRUCTIVE = !process.env.READONLY;
    for (const flow of FLOWS) {
      if (!RUN_DESTRUCTIVE && /SUBMIT/i.test(flow.name)) {
        console.log(`[flow] ${flow.name}: skipped (READONLY=1)`);
        visited.push(`flow:${flow.name} (skipped)`);
        continue;
      }
      try {
        const ran = await withTimeout(flow.run(page), 35000, false);
        console.log(`[flow] ${flow.name}: ${ran ? 'ran' : 'skipped/timeout'}`);
        visited.push(`flow:${flow.name}`);
      } catch (e) {
        console.log(`[flow] ${flow.name}: error ${(e as Error).message}`);
      }
    }

    // 4. Sign out LAST (ends the session)
    try {
      const ran = await withTimeout(SIGN_OUT.run(page), 35000, false);
      console.log(`[flow] ${SIGN_OUT.name}: ${ran ? 'ran' : 'skipped/timeout'}`);
      visited.push(`flow:${SIGN_OUT.name}`);
    } catch (e) {
      console.log(`[flow] ${SIGN_OUT.name}: error ${(e as Error).message}`);
    }
  } finally {
    // Per-run findings live in the timestamped folder; the hash-ledger stays in
    // OUTPUT_DIR so it keeps accumulating across runs.
    const findings = writeFindings(reportDir, visited, violations, OUTPUT_DIR);
    console.log(`\nCaptured ${findings.length} unique CSP violation(s). See ${reportDir}/csp-findings.md`);
    for (const f of findings) console.log(`  • ${f.directive} -> ${f.blockedURI}`);

    const consoleFindings = writeConsoleErrors(reportDir, visited, consoleErrors);
    console.log(`\nCaptured ${consoleFindings.length} unique console finding(s). See ${reportDir}/console-errors.md`);
    for (const f of consoleFindings.slice(0, 30)) console.log(`  • [${f.type}] ${f.text.slice(0, 120)}`);

    // Consolidated, timestamped report (CSP + console + screenshot gallery).
    const reportPath = writeRunReport(
      reportDir,
      {
        stamp: runStamp,
        generatedAt: new Date().toISOString(),
        baseURL: process.env.MYLS_BASE_URL || 'https://my.development.legitscript.net',
        visited,
      },
      findings,
      consoleFindings,
    );
    console.log(`\n📄 Consolidated report: ${reportPath}`);
  }

  // The test documents findings; it does not fail on violations (they are the
  // deliverable). Flip the next line to assert a clean policy once fixed.
  // expect(findings, JSON.stringify(findings, null, 2)).toHaveLength(0);
});
