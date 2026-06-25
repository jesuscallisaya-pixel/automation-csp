# CSP Validation — MyLS (portal-ui)

Playwright suite that drives the authenticated **MyLS** portal
(`my.legitscript.com`) under its **enforced Content-Security-Policy** and reports
what actually breaks: **CSP violations** on legitimate resources **and** browser
**console errors** (uncaught exceptions, `console.error`/`warning`, failed/blocked
requests).

Supports **LS-34808**, acceptance criterion #4:

> _Application functions correctly (no CSP violations in browser console for
> legitimate resources)._

---

## TL;DR — get it running

```bash
npm install            # 1. install deps (uses your local Google Chrome)
npm run auth           # 2. ONE-TIME interactive login (Google SSO + MFA on phone)
npm run test           # 3. run the sweep (headless)
npm run report         # 4. open the Playwright HTML report
```

Findings for each run land in a timestamped folder:
**`output/reports/<YYYY-MM-DD_HH-MM-SS>/report.md`** — start there.

---

## How the policy works (context)

The CSP is **enforced at the edge**, not in the app:

- **SPA document** → Lambda@Edge `lambda/csp-nonce/index.js` (in the `iac` repo)
  injects a per-request **nonce + `strict-dynamic`** policy.
- **Static pages** → CloudFront Function `functions/security-headers.js`.

Because the policy uses nonce + strict-dynamic (not hashes), there is **no hash
list to maintain anymore**. This suite's job is to walk the real app and surface
anything the enforced policy breaks, so you can decide whether to allowlist a
resource (`connect-src`, `frame-src`, …) or leave it blocked.

> **Legacy note:** an earlier hash-based policy required collecting `sha256`
> hashes of inline scripts. That machinery still exists (`output/hash-ledger.*`,
> the `🔑 hashes` sections in reports) but is **no longer the deliverable** —
> it only populates if a hash-style violation happens to fire. Ignore it unless
> you are specifically working on the old policy.

---

## Auth model — why login is manual

MyLS authenticates via **Google SSO + MFA**, which cannot be scripted
non-interactively (Google blocks automated credential entry; MFA is approved on a
phone). We use Playwright's **`storageState`** pattern:

1. **`npm run auth`** — log in **once, by hand**; the authenticated session is
   saved to `.auth/state.json`.
2. **`npm run test`** — automated runs **reuse** that session. No login needed
   until it expires (just re-run `npm run auth`).

`.auth/state.json` is a real session — it is **gitignored, never commit it**.

---

## Prerequisites

- **Node.js 18+**
- **Google Chrome** installed — the suite uses `channel: 'chrome'`, so no
  Chromium download happens.

```bash
npm install
```

---

## npm scripts

| Script | What it does |
|---|---|
| `npm run auth` | **Interactive.** Opens real Chrome, you log in, saves `.auth/state.json`. |
| `npm run test` | The CSP/console sweep, **headless**. |
| `npm run test:headed` | Same, but **visible** Chrome at `SLOWMO=400ms` so you can watch every flow. |
| `npm run test:bg` | Headless, **detached** → logs to `output/run.log`. Follow with `tail -f output/run.log`. |
| `npm run report` | Open the Playwright HTML report. |
| `npm run cleanup` | Delete leftover `csp-test-*` filter sets the sweep may create (see Scripts). |
| `npm run grab-state` | Bootstrap `.auth/state.json` from an already-running debug Chrome (see Scripts). |

### Environment variables

| Var | Default | Effect |
|---|---|---|
| `MYLS_BASE_URL` | `https://my.development.legitscript.net` | Target environment (see table below). |
| `READONLY` | unset | `READONLY=1` **skips the submitting flows** (invite/update user, register merchant, save filter set) for a non-mutating sweep. |
| `NO_SHOTS` | unset | `NO_SHOTS=1` skips the per-violation screenshots. |
| `SLOWMO` | `0` | Per-action delay in ms (set automatically by `test:headed`). |

> **By default the sweep is a full sweep** and DOES run the submitting flows.
> They run against **dev** and only touch **test-prefixed data** (users:
> `lsclientportaltest+jjcs0410-…`, merchants `test-merchant-*`, filter sets
> `csp-test-*`). Use `READONLY=1` if you want a strictly read-only pass.

---

## What the sweep does

`tests/csp.spec.ts` walks, in order:

1. **Initial authenticated load** (fails loudly if the saved state is stale).
2. **Auto-discovered in-app routes** (from nav `<a href="#/…">`) plus a
   `KNOWN_ROUTES` list (account, merchant-monitoring, merchant-onboarding,
   lookups, …).
3. **Named interaction flows** in `lib/flows.ts` — account pages, Merchant
   Monitoring / Merchant Onboarding lists, the shared filter bar (apply / add /
   remove / clear / favorite / rename / delete / save-as / paginate / RBAC
   access filters), Manage Users (invite / edit / activate / deactivate /
   remove), lookups, S3 screenshot download, API-doc menu items, etc. Each is
   capped at 35s.
4. **Sign-out** — run **last**; it ends the session.

Every flow is **best-effort**: if a button/link isn't found (RBAC, entitlements,
no data) it logs and skips, so the sweep never breaks. Selectors use accessible
text/roles + real portal-ui selectors — adjust in `lib/flows.ts` if the DOM
differs.

**Capture is robust:** CSP violations are caught both via
`securitypolicyviolation` DOM events (survive navigation through `addInitScript`)
and via console messages; console errors/exceptions/failed-requests are caught
via `console`/`pageerror`/`requestfailed`. Popups/new tabs are also instrumented
and auto-closed. Only events whose **document is a LegitScript origin** are
reported (Auth0/Google pages have their own CSP and are ignored).

---

## Reading the results

Each run creates **`output/reports/<timestamp>/`** (self-contained, never
clobbers a previous run):

```
output/reports/2026-06-25_20-22-49/
├─ report.md            ← START HERE: CSP + console + screenshot gallery
├─ report.json          ← machine-readable twin
├─ csp-findings.md/.json   ← CSP violations only (this run)
├─ console-errors.md/.json ← functional breakage only (this run)
└─ screenshots/         ← one PNG per directive+route, taken when a violation fired
```

`report.md` opens with a verdict line (✅ clean / ⚠️ N violations) and three
sections: **CSP violations**, **Console findings** (exceptions → failed requests
→ errors → warnings), and a **screenshot gallery**.

> `output/` is gitignored, so reports persist locally but are not committed.

---

## Interpreting a CSP finding

Each finding is `directive → blocked resource`. A common pattern is a resource
allowed to **load** but not to **connect**:

| Action | Directive |
|---|---|
| load/run a script | `script-src` |
| make a network call (fetch/XHR/beacon) | `connect-src` |
| embed an iframe | `frame-src` |
| apply inline style | `style-src` |

Example found in development:

```
connect-src → https://tracking-api.g2.com/...
```

`script-src` allows `https://*.g2.com` (the G2 script loads) but `connect-src`
does not, so its network call is blocked. Fix: add `https://*.g2.com` to
`connect-src` at the edge.

> A "violation" only matters if the resource is **legitimate**. The report lists
> candidates; the allowlist decision (allow it vs. leave the unwanted third party
> blocked) is yours.

---

## Targeting another environment

Defaults to development. Override the base URL for both `auth` and `test`:

```bash
MYLS_BASE_URL=https://my.staging.legitscript.com npm run auth
MYLS_BASE_URL=https://my.staging.legitscript.com npm run test
```

| Environment | Base URL |
|---|---|
| development (default) | `https://my.development.legitscript.net` |
| staging | `https://my.staging.legitscript.com` |
| production | `https://my.legitscript.com` |

---

## Project layout

```
csp-validation/
├─ playwright.config.ts   # projects: "setup" (login) + "myls" (validation)
├─ tests/
│  ├─ auth.setup.ts       # interactive login → saves .auth/state.json
│  └─ csp.spec.ts         # walks routes + flows, writes the timestamped report
├─ lib/
│  ├─ flows.ts            # named user flows (the bulk of the coverage)
│  ├─ cspCollector.ts     # CSP capture, dedupe, screenshots, findings + hash-ledger
│  ├─ consoleCollector.ts # console errors / exceptions / failed requests
│  └─ report.ts           # consolidated per-run report.md / report.json
├─ scripts/               # standalone diagnostic / maintenance helpers (below)
├─ .auth/state.json       # saved session (gitignored)
└─ output/                # all findings land here (gitignored)
```

### Scripts (`scripts/`)

Standalone Node scripts (run with `node scripts/<name>.mjs`). Most reuse
`.auth/state.json` and honor `MYLS_BASE_URL`; several were one-off diagnostics
from the old hash-based policy work and are kept for reference.

| Script | Purpose |
|---|---|
| `grab-state.mjs` | Export storageState from an already-running debug Chrome (`node scripts/grab-state.mjs <port>`). Alt to `npm run auth`. |
| `cleanup-orphans.mjs` | Delete leftover `csp-test-*` filter sets the sweep creates. `npm run cleanup`; `HEADED=1` to watch. |
| `verify-static.mjs` | Check the static pages (`legal.html`, `unsupported-browser.html`) for style-src violations. |
| `static-hashes.mjs` | Compute sha256 hashes for the static pages' inline content. |
| `compare-shot.mjs` | A/B screenshots of fixed views (`LABEL=strict` vs `LABEL=unsafe`) → `output/compare/`. |
| `interact-shot.mjs` | A/B of PrimeNG overlays/menus → `output/interact/`. |
| `intercom-diag.mjs` / `intercom-shot.mjs` | Diagnose Intercom widget CSP/network behavior. |
| `probe.mjs` / `bottom-probe.mjs` / `remaining-viol.mjs` | Ad-hoc probes for DOM/PrimeNG classes and residual style-src violations. |

---

## Notes / limitations

- The suite **documents** findings; it does **not** fail the build on them by
  default. To enforce a clean policy once fixed, un-comment the final
  `expect(findings).toHaveLength(0)` in `tests/csp.spec.ts`.
- Auto-discovery only finds links present in the DOM at visit time; deep flows
  behind wizards may need explicit steps added to `lib/flows.ts`.
- MyLS polls continuously and **never goes network-idle** — flows wait on fixed
  timeouts, not `networkidle`.
- If a run bounces to the Google/login page, the saved state is stale → run
  `npm run auth` again.
