# CSP Validation — MyLS (portal-ui)

Playwright suite that validates the **Content-Security-Policy** enforced on the
MyLS portal (`my.legitscript.com`) and reports any CSP violations that affect
**legitimate** resources.

This supports **LS-34808**, acceptance criterion #4:

> _Application functions correctly (no CSP violations in browser console for
> legitimate resources)._

> **Update (nonce + enforce):** the policy moved from hashes to **nonce +
> strict-dynamic**, now **enforced** at the edge by a Lambda@Edge
> (`lambda/csp-nonce/index.js`) for the SPA document plus a CloudFront Function
> (`functions/security-headers.js`) for the static pages. The hash ledger is no
> longer relevant. The suite now also captures **browser console errors** —
> uncaught exceptions, `console.error`/`warning`, and failed/blocked requests —
> written to `output/console-errors.{json,md}` (CSP violations stay in
> `output/csp-findings.{json,md}`). This is how we find what actually breaks
> under the enforced policy.
>
> - **Full sweep by default:** flows that submit (invite/update user, register a
>   merchant, save a filter set) **DO run** so those paths are exercised and any
>   console errors surface. They run against **dev** and only touch
>   test-prefixed data (users: `lsclientportaltest+…`). Set `READONLY=1` to skip
>   the submits if you want a non-mutating sweep.

The CSP header is injected at the edge by a CloudFront `viewer-response`
function defined in the `iac` repo
(`terraform/modules/applications/portal-ui/static-page/function/viewer-response.js`).
This suite drives the real app, captures every `securitypolicyviolation`, and
writes a findings report you can turn directly into allowlist fixes.

---

## How it works

MyLS authenticates via **Google SSO + MFA**, which cannot be scripted
non-interactively (Google blocks automated credential entry, and MFA is
approved on a phone). We therefore use Playwright's **`storageState`** pattern:

1. **Log in once, by hand** → save the authenticated session to `.auth/state.json`.
2. **Automated runs reuse** that session to walk all flows and capture CSP
   violations — no login required until the session expires.

### Flows covered

`tests/csp.spec.ts` exercises, in order:

1. Initial authenticated load (catches the G2 `connect-src` violation).
2. Auto-discovered in-app routes + a known-route list.
3. Named interaction flows in `lib/flows.ts` that trigger GTM-injected inline
   scripts: **Manage Users → invite user**, **Manage Users → update user**,
   **Merchant Monitoring → click merchant/authoritative URL** (`javascript:`
   tracking — not hashable, accepted-blocked).
4. **Sign-out** (run last; ends the session).

Each flow is best-effort: if a button/link isn't found it logs and skips, so the
sweep never breaks. Selectors use accessible text/roles — adjust in
`lib/flows.ts` if the real DOM differs.

CSP violations are captured two ways for completeness:
- `securitypolicyviolation` DOM events (via `addInitScript`, survives navigation),
- console messages (`Refused to…` / `violates the following Content Security Policy`).

Only violations whose **document is a LegitScript origin** are reported (so
Auth0/Google pages, which have their own CSP, are ignored).

---

## Prerequisites

- Node.js 18+
- **Google Chrome** installed (the suite uses `channel: 'chrome'`, so no
  Chromium download is needed).

```bash
npm install
```

---

## Usage

### 1. Create the auth session (once, interactive)

```bash
npm run auth
```

A real Chrome window opens. Log in with your LegitScript Google account and
approve MFA on your phone. When you land back on MyLS the session is saved to
`.auth/state.json`. Re-run this whenever the session expires.

### 2. Run the CSP validation (automated)

```bash
npm run test          # headless (foreground)
npm run test:headed   # opens a visible Chrome and runs slowed (SLOWMO=400ms) so
                      # you can watch every flow being driven
npm run test:bg       # headless, detached: runs in the background and logs to
                      # output/run.log — follow live with: tail -f output/run.log
```

### 3. Read the findings

- `output/csp-findings.md` — human-readable table + suggested allowlist additions **(this run only)**
- `output/csp-findings.json` — machine-readable, per-violation detail **(this run only)**
- `output/hash-ledger.md` / `.json` — **accumulating** record of every hash ever captured, per environment
- `npm run report` — open the Playwright HTML report

### The hash ledger (cross-run / cross-environment)

`csp-findings.*` is overwritten every run and only shows that run. The **ledger**
(`output/hash-ledger.json` + `.md`) is append-only: each run merges newly captured
hashes into it, recording which environment(s) and route(s) each appeared in. It is
where you read the full hash list to paste into `viewer-response.js`, and how you
detect drift across environments.

How drift shows up: deploy the same policy to staging/prod and run the sweep there.
Any inline whose hash is already covered does **not** violate (so it won't reappear —
that's the "no drift" signal, a clean run). Any inline whose hash **differs** in that
environment gets blocked → new violation → lands in the ledger flagged under that
environment in the **"⚠️ Environment-specific hashes"** section. So a non-empty
staging section = hashes that must be added specifically for staging.

> The ledger lives under `output/` (gitignored), so it persists across runs **on the
> same machine**. Run the multi-environment sweeps from the same checkout to build a
> complete cross-environment picture.

---

## Targeting another environment

Defaults to development. Override the base URL (the ledger tags captures with the
environment automatically, derived from the host):

```bash
MYLS_BASE_URL=https://my.staging.legitscript.com npm run auth
MYLS_BASE_URL=https://my.staging.legitscript.com npm run test
```

| Environment | Base URL | Ledger label |
|---|---|---|
| development | `https://my.development.legitscript.net` (default) | `development` |
| staging | `https://my.staging.legitscript.com` | `staging` |
| production | `https://my.legitscript.com` | `production` |

---

## Project layout

```
csp-validation/
├─ playwright.config.ts     # projects: "setup" (login) and "myls" (validation)
├─ tests/
│  ├─ auth.setup.ts         # interactive login -> saves .auth/state.json
│  └─ csp.spec.ts           # walks flows, records violations -> output/
├─ lib/
│  └─ cspCollector.ts       # capture + dedupe + findings writer
├─ scripts/
│  └─ grab-state.mjs        # bootstrap auth state from a running debug Chrome
└─ output/                  # findings land here (gitignored)
```

---

## Interpreting a finding

Each finding is `directive -> blocked resource`. A common pattern is a resource
allowed to **load** but not to **connect**:

| Action | Directive |
|---|---|
| load/run a script | `script-src` |
| make a network call (fetch/XHR/beacon) | `connect-src` |
| embed an iframe | `frame-src` |

Example already found in development:

```
connect-src -> https://tracking-api.g2.com/...
```

`script-src` allows `https://*.g2.com` (the G2 script loads), but `connect-src`
does not, so G2's network call is blocked. Fix: add `https://*.g2.com` to
`connect-src` in `viewer-response.js`.

> A "violation" only matters if the resource is **legitimate**. Decide per
> resource whether to allowlist it (it's needed) or leave it blocked (unwanted
> third party). The report lists candidates; the allowlist decision is yours.

---

## Notes / limitations

- The suite **documents** violations; it does not fail the build on them by
  default. To enforce a clean policy once fixed, un-comment the final
  `expect(findings).toHaveLength(0)` in `tests/csp.spec.ts`.
- Auto-discovery only finds links present in the DOM at visit time; deep flows
  behind buttons/wizards may need explicit steps added to `csp.spec.ts`.
- `.auth/state.json` contains a real session — it is gitignored. Never commit it.
# automation-csp
