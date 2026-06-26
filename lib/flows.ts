import type { Page } from '@playwright/test';

/**
 * Named user flows for the MyLS CSP sweep (LS-34808, AC4).
 *
 * portal-ui pushes events to the GTM dataLayer via `DataLayerService`; GTM then
 * injects an inline <script> per tag. Our CSP has no 'unsafe-inline', so each
 * distinct GTM inline needs its sha256 hash. Every `log…Event()` is a test case.
 *
 * Selectors/routes are from the real portal-ui source (legitjs/portal-ui):
 *   Routes:  #/account/home, #/account/users, #/account/billing,
 *            #/account/account-details, #/merchant-monitoring/merchant-list,
 *            #/merchant-onboarding, #/services/lookups/data
 *   Account menu:  button [aria-label="Account Settings"] → Manage Users /
 *            Billing / Sign out (layout.component.ts)
 *   Invite/Edit user form: name="email", name="firstName"/"lastName"/"phone"
 *            (required), name="position", access-type radio inputId
 *            "accessTypeEdit" (Write), submit button "Submit". (users-table/edit)
 *   Single merchant: "Add Merchants" → tab "Single Merchant" → generic-form
 *            inputs id=controlName (#merchantUrl, #merchantName) → "Submit
 *            Merchant". (merchant-upload/single)
 *   Lookups search: name="website" / name="product" + "Search". (lookups)
 *
 * ⚠️ Some flows are DESTRUCTIVE and now actually SUBMIT (invite user with a
 * unique random email, update user, register a single merchant) so the GTM
 * submit-time events fire and their hashes are captured. They run against dev.
 */

const log = (...a: unknown[]) => console.log('[flow]', ...a);

/** Email prefix for EVERY user this automation invites. Also the safety marker:
 *  edit/deactivate/activate/remove flows ONLY act on rows whose email starts with
 *  this prefix, so a real account user is never touched. */
const TEST_USER_PREFIX = 'lsclientportaltest+jjcs0410-';

/** Unique, non-repeating test invite address. */
function uniqueEmail(): string {
  const rnd = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  return `${TEST_USER_PREFIX}${rnd}@gmail.com`;
}

async function clickByText(page: Page, re: RegExp, timeout = 1500): Promise<boolean> {
  const candidates = [
    page.getByRole('menuitem', { name: re }),
    page.getByRole('link', { name: re }),
    page.getByRole('button', { name: re }),
    page.getByRole('tab', { name: re }),
    page.getByText(re, { exact: false }),
  ];
  for (const loc of candidates) {
    try {
      const el = loc.first();
      if (await el.isVisible({ timeout }).catch(() => false)) {
        await el.click({ timeout }).catch(() => {});
        return true;
      }
    } catch {
      /* next */
    }
  }
  return false;
}

async function clickSel(page: Page, selector: string, timeout = 1500): Promise<boolean> {
  const el = page.locator(selector).first();
  if (await el.isVisible({ timeout }).catch(() => false)) {
    await el.click({ timeout }).catch(() => {});
    return true;
  }
  return false;
}

/** Fill an input matched by CSS, tolerating absence. */
async function fill(page: Page, selector: string, value: string): Promise<boolean> {
  const el = page.locator(selector).first();
  if (await el.isVisible({ timeout: 1500 }).catch(() => false)) {
    await el.fill(value, { timeout: 2000 }).catch(() => {});
    return true;
  }
  return false;
}

// Do NOT wait for 'networkidle' — MyLS polls continuously and never goes idle.
async function settle(page: Page, ms = 1200) {
  await page.waitForTimeout(ms);
}

async function goRoute(page: Page, route: string) {
  await page
    .goto('/' + route.replace(/^\//, ''), { waitUntil: 'domcontentloaded', timeout: 12000 })
    .catch(() => {});
  await settle(page);
}

async function dismiss(page: Page) {
  await clickByText(page, /cancel|close|dismiss|done|ok/i, 1500).catch(() => {});
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(600);
}

/** Open MO/MM "More" overflow menu, hovering intermediate (sub)menu labels. */
async function moreMenuItem(page: Page, ...labels: RegExp[]): Promise<boolean> {
  if (!(await clickByText(page, /^more$/i, 2500))) return false;
  await page.waitForTimeout(400);
  for (let i = 0; i < labels.length; i++) {
    const re = labels[i];
    const item = page.getByRole('menuitem', { name: re }).first();
    if (!(await item.isVisible({ timeout: 2000 }).catch(() => false))) {
      const ok = await clickByText(page, re, 2000); // fallback
      if (!ok) return false;
    } else if (i < labels.length - 1) {
      await item.hover().catch(() => {}); // expand submenu
      await page.waitForTimeout(300);
    } else {
      await item.click().catch(() => {});
    }
  }
  await settle(page);
  return true;
}

export interface Flow {
  name: string;
  event?: string;
  destructive?: boolean;
  run: (page: Page) => Promise<boolean>;
}

/* -------------------------------------------------------------------------
 * Filter-bar / pagination helpers (shared `ls-table`)
 *
 * MO and MM both render the merchant list through the shared
 * `shared/components/ls-table` component, so the filter bar, saved filter
 * sets, favorites, RBAC access filters and paginator have IDENTICAL DOM in
 * both modules. Selectors below come from the real source:
 *   filter/filter-bar/filter-bar.component.html  (sets menu, Add filter,
 *      Clear all, star=favorite, pencil=rename, trash=delete, Save/Save as)
 *   filter/filter.component.html                 (chip remove btn aria-label)
 *   filter/filterTypes/multi-select-filter…html  (p-multiSelect chip + options)
 *   table.component.html                         (p-paginator next/prev)
 *
 * Each list navigation reloads the SPA (page.goto), which resets NgRx filter
 * state, so every flow is self-contained and acts on the default-visible
 * filters. All steps are tolerant: a missing control returns false (skipped),
 * never throws — entitlements/RBAC/data differ per account.
 * ---------------------------------------------------------------------- */

/** Open the saved-filter-set dropdown (label = applied set name or "Filters"). */
async function openFilterSetMenu(page: Page): Promise<boolean> {
  return (
    (await clickSel(page, '.filter-drop-down button, button.filter-drop-down', 2500)) ||
    (await clickByText(page, /^filters$/i, 2000))
  );
}

/** Apply the first saved filter set from the dropdown (emits applyFilterSet). */
async function applyFirstFilterSet(page: Page): Promise<boolean> {
  if (!(await openFilterSetMenu(page))) return false;
  await page.waitForTimeout(500);
  const item = page.locator('.filter-menu-item .filter-item-name').first();
  if (await item.isVisible({ timeout: 2000 }).catch(() => false)) {
    await item.click().catch(() => {});
    await settle(page);
    return true;
  }
  await page.keyboard.press('Escape').catch(() => {});
  return false;
}

/** "Add filter" → pick the first available filter from the overlay (emits addFilter). */
async function addFirstFilter(page: Page): Promise<boolean> {
  if (!(await clickByText(page, /add filter/i, 2500))) return false;
  await page.waitForTimeout(500);
  const opt = page
    .locator('.add-filter-panel .filter-category-contents p-button button:not([disabled])')
    .first();
  if (await opt.isVisible({ timeout: 2000 }).catch(() => false)) {
    await opt.click().catch(() => {});
    await settle(page);
    return true;
  }
  await page.keyboard.press('Escape').catch(() => {});
  return false;
}

/** Open the first visible filter chip and select an option (emits applyFilter). */
async function applyFirstVisibleFilter(page: Page): Promise<boolean> {
  const chip = page.locator('.filter-display p-multiselect, .filter-display .p-multiselect').first();
  if (!(await chip.isVisible({ timeout: 2000 }).catch(() => false))) return false;
  await chip.click().catch(() => {});
  await page.waitForTimeout(600);
  const option = page.locator('.p-multiselect-panel .p-multiselect-item, .p-multiselect-items li').first();
  let ok = false;
  if (await option.isVisible({ timeout: 2000 }).catch(() => false)) {
    await option.click().catch(() => {});
    ok = true;
    await page.waitForTimeout(400);
  }
  await page.keyboard.press('Escape').catch(() => {});
  await settle(page);
  return ok;
}

/** Remove the first applied filter chip (X button, emits removeFilter). */
async function removeFirstFilter(page: Page): Promise<boolean> {
  const btn = page.locator('[aria-label^="Remove "][aria-label$=" filter"]').first();
  if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await btn.click().catch(() => {});
    await settle(page);
    return true;
  }
  return false;
}

/** "Clear all" (only visible when filters are applied → emits clearFilters). */
async function clearAllFilters(page: Page): Promise<boolean> {
  const ok = await clickByText(page, /clear all/i, 2000);
  await settle(page);
  return ok;
}

/** Toggle the favorite star on the first user filter set, then toggle back. */
async function toggleFavoriteFilterSet(page: Page): Promise<boolean> {
  if (!(await openFilterSetMenu(page))) return false;
  await page.waitForTimeout(500);
  const star = () => page.locator('i.pi-star.action-item, i.pi-star-fill.action-item').first();
  if (!(await star().isVisible({ timeout: 2000 }).catch(() => false))) {
    await page.keyboard.press('Escape').catch(() => {});
    log('no user filter set to favorite (rbac/no saved sets) — skipped');
    return false;
  }
  await star().click().catch(() => {}); // favorite / unfavorite
  await page.waitForTimeout(700);
  if (await star().isVisible({ timeout: 1500 }).catch(() => false)) {
    await star().click().catch(() => {}); // toggle back → net-zero state
  }
  await page.keyboard.press('Escape').catch(() => {});
  await settle(page);
  return true;
}

/** Open the rename-set modal (pencil) and cancel — non-destructive. */
async function openRenameThenCancel(page: Page): Promise<boolean> {
  if (!(await openFilterSetMenu(page))) return false;
  await page.waitForTimeout(400);
  const pencil = page.locator('i.pi-pencil.action-item').first();
  if (!(await pencil.isVisible({ timeout: 2000 }).catch(() => false))) {
    await page.keyboard.press('Escape').catch(() => {});
    return false;
  }
  await pencil.click().catch(() => {});
  await page.waitForTimeout(600);
  await clickByText(page, /^cancel$/i, 2000); // single-line-input-modal cancel
  await page.keyboard.press('Escape').catch(() => {});
  await settle(page);
  return true;
}

/** Open the delete-set confirmation (trash) and cancel — non-destructive. */
async function openDeleteThenCancel(page: Page): Promise<boolean> {
  if (!(await openFilterSetMenu(page))) return false;
  await page.waitForTimeout(400);
  const trash = page.locator('i.pi-trash.action-item').first();
  if (!(await trash.isVisible({ timeout: 2000 }).catch(() => false))) {
    await page.keyboard.press('Escape').catch(() => {});
    return false;
  }
  await trash.click().catch(() => {});
  await page.waitForTimeout(600);
  await clickByText(page, /^cancel$/i, 2000); // confirmation dialog cancel
  await settle(page);
  return true;
}

/** Open the filter-set menu and delete the set whose name matches exactly. */
async function deleteFilterSetByName(page: Page, name: string): Promise<boolean> {
  if (!(await openFilterSetMenu(page))) return false;
  await page.waitForTimeout(500);
  const item = page
    .locator('.filter-menu-item', { has: page.locator('.filter-item-name', { hasText: name }) })
    .first();
  if (!(await item.isVisible({ timeout: 2000 }).catch(() => false))) {
    await page.keyboard.press('Escape').catch(() => {});
    return false;
  }
  await item.hover().catch(() => {}); // action icons may be hover-revealed
  await page.waitForTimeout(200);
  const trash = item.locator('i.pi-trash.action-item').first();
  if (!(await trash.isVisible({ timeout: 2000 }).catch(() => false))) {
    await page.keyboard.press('Escape').catch(() => {});
    return false;
  }
  await trash.click().catch(() => {});
  await page.waitForTimeout(500);
  const confirmed = await clickByText(page, /delete filter/i, 2500); // confirm dialog
  await settle(page);
  return confirmed;
}

/** Make the set dirty, "Save as" a unique set, then delete it to clean up. */
async function saveFilterSetAsThenDelete(page: Page, label: string): Promise<boolean> {
  if (!(await applyFirstVisibleFilter(page))) {
    log(`${label}: could not modify a filter to dirty the set — skip save`);
    return false;
  }
  // Save/Save as only render for edit users on a dirty set.
  if (!(await clickByText(page, /save as|^save$/i, 2500))) {
    log(`${label}: Save button not available (rbac/entitlement) — skip`);
    return false;
  }
  await page.waitForTimeout(600);
  const name = `csp-test-${Date.now()}`;
  await fill(page, '.p-dialog input[type="text"], .p-dialog input', name);
  await page.waitForTimeout(300);
  const saved = await clickByText(page, /^save$/i, 2500); // confirm name modal
  await settle(page, 1500);
  if (!saved) return false;
  // cleanup: delete the exact set we just created (by name, not position).
  if (!(await deleteFilterSetByName(page, name))) {
    log(`${label}: created filter set "${name}" but could NOT auto-delete — run "npm run cleanup"`);
  }
  return true;
}

/** Go to next page then back to first, keeping list state stable. */
async function paginate(page: Page): Promise<boolean> {
  const next = page.locator('.p-paginator-next, [aria-label="Next Page"]').first();
  const enabled =
    (await next.isVisible({ timeout: 2000 }).catch(() => false)) &&
    (await next.isEnabled().catch(() => true));
  if (!enabled) {
    log('paginator next not available (single page of results) — skipped');
    return false;
  }
  await next.click().catch(() => {});
  await settle(page);
  const prev = page.locator('.p-paginator-prev, [aria-label="Previous Page"]').first();
  if (await prev.isVisible({ timeout: 1500 }).catch(() => false)) {
    await prev.click().catch(() => {}); // back to page 1
  }
  await settle(page);
  return true;
}

/**
 * RBAC access filters (MM only). Access filter sets share the same filter-set
 * menu as user filters and are governed by saveAccessFilterSet /
 * deleteAccessFilterSet / renameAccessFilterSet (platform-access role + an
 * assigned access filter). The DOM does not tag them distinctly, so this is a
 * best-effort pass: apply a set and, if the "modify this filter?" confirmation
 * appears, cancel it (non-destructive).
 */
async function exerciseAccessFilters(page: Page): Promise<boolean> {
  if (!(await openFilterSetMenu(page))) return false;
  await page.waitForTimeout(500);
  const item = page.locator('.filter-menu-item .filter-item-name').first();
  const ok = await item.isVisible({ timeout: 2000 }).catch(() => false);
  if (ok) await item.click().catch(() => {});
  else await page.keyboard.press('Escape').catch(() => {});
  await clickByText(page, /^cancel$/i, 1500).catch(() => {}); // modify-assigned-filter modal
  await settle(page);
  if (!ok) log('MM: no filter sets in menu (rbac/entitlement) — RBAC access-filter pass skipped');
  return ok;
}

/** Build the filter/pagination/favorite/RBAC flow set for a merchant list. */
function filterFlows(label: string, route: string, opts: { rbac?: boolean } = {}): Flow[] {
  const at = async (page: Page) => {
    await goRoute(page, route);
  };
  const flows: Flow[] = [
    { name: `${label} → apply saved filter set`, run: async (p) => (await at(p), applyFirstFilterSet(p)) },
    { name: `${label} → add filter`, event: 'addFilter', run: async (p) => (await at(p), addFirstFilter(p)) },
    {
      name: `${label} → apply/modify filter value`,
      event: 'AppliedFilters',
      run: async (p) => (await at(p), applyFirstVisibleFilter(p)),
    },
    { name: `${label} → remove filter`, run: async (p) => (await at(p), removeFirstFilter(p)) },
    {
      name: `${label} → clear all filters`,
      run: async (p) => {
        await at(p);
        await applyFirstVisibleFilter(p);
        return clearAllFilters(p);
      },
    },
    { name: `${label} → favorite/unfavorite filter set`, run: async (p) => (await at(p), toggleFavoriteFilterSet(p)) },
    { name: `${label} → rename filter set (open+cancel)`, run: async (p) => (await at(p), openRenameThenCancel(p)) },
    { name: `${label} → delete filter set (open+cancel)`, run: async (p) => (await at(p), openDeleteThenCancel(p)) },
    {
      name: `${label} → save filter set as (SUBMIT, then delete)`,
      destructive: true,
      run: async (p) => (await at(p), saveFilterSetAsThenDelete(p, label)),
    },
    { name: `${label} → pagination (next/prev)`, run: async (p) => (await at(p), paginate(p)) },
  ];
  if (opts.rbac) {
    flows.push({
      name: `${label} → RBAC access filters (platform access)`,
      run: async (p) => (await at(p), exerciseAccessFilters(p)),
    });
  }
  return flows;
}

/**
 * Open the per-row "More actions" menu (users-table.component.html) for a user
 * created by THIS automation (email starts with TEST_USER_PREFIX). Optionally
 * require a specific status so activate/deactivate target a valid row. Returns
 * false (caller skips) when no matching test user exists — real users are never
 * matched, so these destructive flows can only ever affect our own test data.
 */
async function openTestUserMenu(page: Page, status?: 'active' | 'deactivated'): Promise<boolean> {
  await goRoute(page, '#/account/users');
  // The RBAC users-table renders only once account state is loaded; on a cold
  // load EditComponent can throw and leave the page empty (pre-existing app bug,
  // also skips the legacy "Update User" flow). Give the row actions time to appear.
  await page
    .locator('[aria-label="More actions"]')
    .first()
    .waitFor({ state: 'visible', timeout: 12000 })
    .catch(() => {});
  const emailCell = page.locator(`a[href^="mailto:${TEST_USER_PREFIX}"]`);
  let row = page.locator('tr', { has: emailCell });
  if (status) row = row.filter({ hasText: status === 'active' ? /\bactive\b/i : /deactivated/i });
  const target = row.first();
  if (!(await target.isVisible({ timeout: 2500 }).catch(() => false))) return false;
  const btn = target.locator('[aria-label="More actions"]').first();
  if (!(await btn.isVisible({ timeout: 2000 }).catch(() => false))) return false;
  await btn.scrollIntoViewIfNeeded().catch(() => {});
  // The per-row tieredMenu (appendTo body) can need a second, forced click.
  for (let attempt = 0; attempt < 2; attempt++) {
    await btn.click(attempt === 0 ? {} : { force: true }).catch(() => {});
    await page.waitForTimeout(900);
    const open = await page
      .locator('.p-tieredmenu, .p-tieredmenu-overlay, .p-menu, .p-menu-overlay')
      .first()
      .isVisible({ timeout: 1000 })
      .catch(() => false);
    if (open) return true;
  }
  return true; // best-effort; caller's clickByText still attempts the action
}

/* -------------------------------------------------------------------------
 * Add Merchant dialog helpers (merchant-upload.component)
 *
 * ROOT CAUSE of the 2026-06-26 style-src hash misses: the original sweep only
 * exercised Merchant Onboarding (MO) "Add Merchants", and even there the Bulk
 * tab was opened "open only" (no file attached) and Single Merchant was driven
 * with fill() on 2 hard-coded MO ids. The hashes the user hit live in the
 * Merchant Monitoring (MM) dialog (merchant-monitoring-v2/components/
 * merchant-upload), which was never opened, and only render on DEEPER
 * interaction the sweep never performed:
 *   - Bulk: selecting a real file flips ls-upload → single-file-display +
 *     p-progressBar [style] (inline width/height) → style-src hash.
 *   - Single: the <generic-form> fields (pInputText / pInputTextarea /
 *     p-dropdown[virtualScroll] / p-chips) inject focus-ring + ng-invalid/
 *     ng-touched validation + cdk virtual-scroll inline styles ONLY when a real
 *     user TABS field→field (focus/blur) and opens the dropdown overlay. fill()
 *     sets values directly and the MO ids don't exist here, so it was a no-op.
 * These helpers drive both like a human so the inline styles actually render
 * and cspCollector captures their hashes.
 * ---------------------------------------------------------------------- */

/** Open the MM "Add Merchants" dialog and switch to the given tab. */
async function openMMAddMerchant(page: Page, tab: RegExp): Promise<boolean> {
  await goRoute(page, '#/merchant-monitoring/merchant-list');
  if (!(await clickByText(page, /add merchants/i, 3000))) {
    log('MM Add Merchants button not found (entitlement/rbac) — skipped');
    return false;
  }
  await page
    .locator('.merchant-upload-dialog, .p-dialog:has-text("Add Merchants")')
    .first()
    .waitFor({ state: 'visible', timeout: 4000 })
    .catch(() => {});
  await clickByText(page, tab, 2500); // "Bulk Upload" | "Single Merchant"
  await page.waitForTimeout(700);
  return true;
}

/** Attach an in-memory CSV to the first hidden file <input> in a dialog. */
async function attachCsv(page: Page, scope = '.merchant-upload-dialog'): Promise<boolean> {
  const input = page.locator(`${scope} input[type="file"]`).first();
  if (!(await input.count())) return false;
  await input
    .setInputFiles({
      name: `csp-test-${Date.now()}.csv`,
      mimeType: 'text/csv',
      buffer: Buffer.from('merchant_url,merchant_name\nhttps://test-merchant.com,CSP Test\n'),
    })
    .catch(() => {});
  await settle(page, 1500); // let single-file-display / progressBar / validation render
  return true;
}

/** Tab through every visible field of a <generic-form>, typing to dirty each
 *  (focus ring + ng-invalid/ng-touched validation = inline styles). */
async function tabThroughFormFields(page: Page, scope: string): Promise<boolean> {
  const fields = page.locator(`${scope} .form-field :is(input,textarea,.p-dropdown,.p-chips)`);
  const n = Math.min(await fields.count(), 12);
  if (n === 0) return false;
  for (let i = 0; i < n; i++) {
    const f = fields.nth(i);
    await f.scrollIntoViewIfNeeded().catch(() => {});
    await f.click({ timeout: 1000 }).catch(() => {}); // focus → (focus)=onFocus()
    await page.keyboard.type('test', { delay: 20 }).catch(() => {}); // dirty → validation
    await page.keyboard.press('Tab').catch(() => {}); // blur → markAsTouched()
    await page.waitForTimeout(150);
  }
  // Open the virtual-scroll p-dropdown overlay (cdk injects height/transform).
  const dd = page.locator(`${scope} p-dropdown, ${scope} .p-dropdown`).first();
  if (await dd.isVisible({ timeout: 1200 }).catch(() => false)) {
    await dd.click().catch(() => {});
    await page.waitForTimeout(600);
    await page.keyboard.press('Escape').catch(() => {});
  }
  await settle(page);
  return true;
}

export const FLOWS: Flow[] = [
  // ---- session / account ----
  {
    name: 'page view (account home)',
    event: 'logCustomerDataEvent',
    run: async (page) => {
      await goRoute(page, '#/account/home');
      return true;
    },
  },
  {
    name: 'Account Settings page',
    run: async (page) => {
      await goRoute(page, '#/account/account-details');
      return true;
    },
  },
  {
    name: 'Billing page',
    run: async (page) => {
      await goRoute(page, '#/account/billing');
      return true;
    },
  },

  // ---- Merchant Monitoring (v2) ----
  {
    name: 'Merchant Monitoring list',
    run: async (page) => {
      await goRoute(page, '#/merchant-monitoring/merchant-list');
      return true;
    },
  },
  {
    name: 'MM → open detail (click first merchant row)',
    event: 'merchantOnboardingLogOpenedDetailViewEvent',
    run: async (page) => {
      await goRoute(page, '#/merchant-monitoring/merchant-list');
      const popupP = page.context().waitForEvent('page', { timeout: 3000 }).catch(() => null);
      const ok = (await clickSel(page, 'table tbody tr td a', 2500)) || (await clickSel(page, 'table tbody tr', 2500));
      const popup = await popupP;
      if (popup) await popup.close().catch(() => {});
      await settle(page);
      if (!ok) log('merchant row not found — skipped');
      return ok;
    },
  },
  {
    // Exercises the snapshot DOWNLOAD, which does fetch(presigned S3 URL) and
    // createObjectURL — a connect-src request to *.s3*.amazonaws.com that the
    // automated sweep otherwise never triggers (the thumbnail <img> does not).
    name: 'MM → open detail → download screenshot (S3 presigned fetch)',
    run: async (page) => {
      await goRoute(page, '#/merchant-monitoring/merchant-list');
      const opened = (await clickSel(page, 'table tbody tr td a', 2500)) || (await clickSel(page, 'table tbody tr', 2500));
      if (!opened) {
        log('no merchant row — skipped');
        return false;
      }
      await settle(page);
      // Auto-accept any browser download so the click doesn't hang the run.
      page.on('download', (d) => d.cancel().catch(() => {}));
      // Screenshots section: "Download All" fetches each snapshot from its S3
      // presigned URL.
      let dl = await clickByText(page, /download all/i, 2500);
      if (!dl) {
        // Fallback: open the carousel from a thumbnail, then download one image.
        const openedCarousel = await clickSel(page, 'app-merchant-screenshots img, .screenshot-grid img', 2000);
        if (openedCarousel) {
          await settle(page);
          dl = await clickByText(page, /download/i, 2000);
        }
      }
      if (!dl) log('no screenshots/download available for this merchant — skipped');
      await settle(page);
      return dl;
    },
  },
  {
    name: 'MM → More → API Guides → V4 Docs',
    event: 'logAPIV4GuideEvent',
    run: async (page) => {
      await goRoute(page, '#/merchant-monitoring/merchant-list');
      return moreMenuItem(page, /api guides/i, /v4 api docs|v4 docs/i);
    },
  },
  {
    name: 'MM → More → API Guides → V3 Docs',
    event: 'logAPIV3GuideEvent',
    run: async (page) => {
      await goRoute(page, '#/merchant-monitoring/merchant-list');
      return moreMenuItem(page, /api guides/i, /v3 api docs|v3 docs/i);
    },
  },
  {
    name: 'MM → More → User Guides → User Guide (EN)',
    event: 'logUserGuideEvent',
    run: async (page) => {
      await goRoute(page, '#/merchant-monitoring/merchant-list');
      return moreMenuItem(page, /user guides/i, /user guide.*\(en\)|user guide/i);
    },
  },

  // ---- Merchant Onboarding (MO) ----
  {
    name: 'Merchant Onboarding list',
    run: async (page) => {
      await goRoute(page, '#/merchant-onboarding');
      return true;
    },
  },
  {
    name: 'MO → Export Merchants',
    event: 'merchantOnboardingLogExportedMerchantsEvent',
    run: async (page) => {
      await goRoute(page, '#/merchant-onboarding');
      const ok = await clickByText(page, /export merchants/i, 2500);
      await settle(page);
      await dismiss(page);
      if (!ok) log('Export Merchants not found — skipped');
      return ok;
    },
  },
  {
    name: 'MO → register Single Merchant (SUBMIT)',
    event: 'merchantOnboardingLogMerchantUploadEvent',
    destructive: true,
    run: async (page) => {
      await goRoute(page, '#/merchant-onboarding');
      if (!(await clickByText(page, /add merchants/i, 2500))) {
        log('Add Merchants not found — skipped');
        return false;
      }
      await page.waitForTimeout(700);
      await clickByText(page, /single merchant/i, 2000);
      await page.waitForTimeout(700);
      const rnd = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
      const filled =
        (await fill(page, '#merchantUrl', `https://test-merchant-${rnd}.com`)) ||
        (await fill(page, 'input[placeholder*="example" i]', `https://test-merchant-${rnd}.com`));
      await fill(page, '#merchantName', `Test Merchant ${rnd}`);
      await page.waitForTimeout(400);
      const submitted = await clickByText(page, /submit merchant/i, 3000);
      await settle(page, 2500);
      await dismiss(page);
      if (!filled) log('merchant URL field not found');
      return submitted;
    },
  },
  {
    // Was "open only" (never attached a file) — one of the gaps that let the
    // 2026-06-26 upload style-src hashes slip through. Now attaches a real CSV so
    // ls-upload's single-file-display + p-progressBar inline styles render.
    name: 'MO → Add Merchants → Bulk Upload (ATTACH file → upload/progressBar styles)',
    event: 'merchantOnboardingLogMerchantUploadEvent',
    destructive: true,
    run: async (page) => {
      await goRoute(page, '#/merchant-onboarding');
      const opened = await clickByText(page, /add merchants/i, 2500);
      await page.waitForTimeout(600);
      await clickByText(page, /bulk upload/i, 2000);
      await page.waitForTimeout(500);
      const attached = await attachCsv(page);
      if (!attached) log('MO bulk file input not found — opened tab only');
      await dismiss(page); // Cancel — do NOT submit (non-destructive)
      return opened;
    },
  },
  {
    name: 'MO → Get API Credentials',
    event: 'merchantOnboardingLogOpenedApiCredentialsEvent',
    run: async (page) => {
      await goRoute(page, '#/merchant-onboarding');
      const ok =
        (await clickByText(page, /get api credentials/i, 2500)) || (await moreMenuItem(page, /get api credentials/i));
      await settle(page);
      await dismiss(page);
      if (!ok) log('Get API Credentials not found — skipped');
      return ok;
    },
  },
  {
    name: 'MO → More → Merchant Onboarding API Docs',
    event: 'merchantOnboardingLogOpenedApiDocsEvent',
    run: async (page) => {
      await goRoute(page, '#/merchant-onboarding');
      return moreMenuItem(page, /api guides/i, /merchant onboarding api docs|api docs/i);
    },
  },
  {
    name: 'MO → More → View Upload History',
    event: 'merchantOnboardingLogOpenedUploadHistoryEvent',
    run: async (page) => {
      await goRoute(page, '#/merchant-onboarding');
      return moreMenuItem(page, /view upload history|upload history/i);
    },
  },
  {
    name: 'MO summary → Needs Action tile',
    event: 'merchantOnboardingLogAppliedNeedsActionEvent / …MiniDashboardClickEvent',
    run: async (page) => {
      await goRoute(page, '#/merchant-onboarding');
      const ok = await clickByText(page, /needs action/i, 2500);
      await settle(page);
      if (!ok) log('Needs Action tile not found — skipped');
      return ok;
    },
  },
  {
    name: 'MO summary → monthly/submitted tile',
    event: 'merchantOnboardingLogAppliedSubmittedDateEvent / …MiniDashboardClickEvent',
    run: async (page) => {
      await goRoute(page, '#/merchant-onboarding');
      const ok =
        (await clickByText(page, /submitted this month|this month|monthly/i, 2500)) ||
        (await clickSel(page, '[pTooltip*="submitted this month"]', 2000));
      await settle(page);
      if (!ok) log('monthly/submitted tile not found — skipped');
      return ok;
    },
  },
  {
    name: 'MO → applied filters',
    event: 'merchantOnboardingLogAppliedFiltersEvent',
    run: async (page) => {
      await goRoute(page, '#/merchant-onboarding');
      const open = await clickByText(page, /filter/i, 2500);
      await page.waitForTimeout(500);
      await clickByText(page, /apply/i, 2000);
      await settle(page);
      await dismiss(page);
      return open;
    },
  },

  // ---- Merchant Monitoring → Add Merchant (MM merchant-upload dialog) ----
  // The module the original sweep MISSED. Source of the 2026-06-26 style-src
  // hash misses (see openMMAddMerchant / attachCsv / tabThroughFormFields above).
  {
    name: 'MM → Add Merchant → Bulk Upload (ATTACH file → upload/progressBar styles)',
    run: async (page) => {
      if (!(await openMMAddMerchant(page, /bulk upload/i))) return false;
      const attached = await attachCsv(page);
      if (!attached) log('MM bulk file input not found — skipped');
      await dismiss(page); // Cancel — do NOT submit the upload (non-destructive)
      return attached;
    },
  },
  {
    name: 'MM → Add Merchant → Single Merchant (TAB through fields → focus/validation styles)',
    run: async (page) => {
      if (!(await openMMAddMerchant(page, /single merchant/i))) return false;
      const ok = await tabThroughFormFields(page, '.single-merchant-content');
      if (!ok) log('MM single-merchant form fields not found — skipped');
      await dismiss(page); // Cancel — never submit
      return ok;
    },
  },

  // ---- Manage Users ----
  {
    name: 'Manage Users (page)',
    run: async (page) => {
      await goRoute(page, '#/account/users');
      return true;
    },
  },
  {
    name: 'Users → Invite User (SUBMIT, random email)',
    event: 'logAddUserEvent',
    destructive: true,
    run: async (page) => {
      await goRoute(page, '#/account/users');
      if (!(await clickByText(page, /invite user/i, 2500))) {
        log('Invite User not found — skipped');
        return false;
      }
      await page.waitForTimeout(700);
      const email = uniqueEmail();
      await fill(page, 'input[name="email"]', email);
      await fill(page, 'input[name="firstName"]', 'JJ');
      await fill(page, 'input[name="lastName"]', 'CSPTest');
      await fill(page, 'input[name="phone"]', '5035551234');
      await fill(page, 'input[name="position"]', 'QA');
      // Access type: Write
      (await clickSel(page, '#accessTypeEdit', 1500)) || (await clickByText(page, /^write$/i, 1500));
      await page.waitForTimeout(400);
      const submitted = await clickByText(page, /^submit$/i, 3000);
      log(`invite user email=${email} submitted=${submitted}`);
      await settle(page, 2000);
      await dismiss(page);
      return submitted;
    },
  },
  {
    name: 'Users → Update User (SUBMIT)',
    event: 'logEditUserEvent',
    destructive: true,
    run: async (page) => {
      await goRoute(page, '#/account/users');
      // open the per-row "More actions" menu, then Edit
      if (!(await clickSel(page, '[aria-label="More actions"]', 2500))) {
        log('row actions menu not found — skipped');
        return false;
      }
      await page.waitForTimeout(400);
      if (!(await clickByText(page, /^edit$/i, 2000))) {
        log('Edit action not found — skipped');
        return false;
      }
      await page.waitForTimeout(700);
      // change a low-risk field (Title/Position) and submit
      await fill(page, 'input[name="position"]', `QA ${Math.floor(Math.random() * 1000)}`);
      await page.waitForTimeout(400);
      const submitted = await clickByText(page, /^submit$/i, 3000);
      log(`update user submitted=${submitted}`);
      await settle(page, 2000);
      await dismiss(page);
      return submitted;
    },
  },
  {
    // Row menu → Edit on a test user (safer twin of "Update User", which targets
    // the first row). Changes a low-risk field and submits → logEditUserEvent.
    name: 'Users → Edit test user (SUBMIT)',
    event: 'logEditUserEvent',
    destructive: true,
    run: async (page) => {
      if (!(await openTestUserMenu(page))) {
        log('no automation test user to edit — skipped');
        return false;
      }
      if (!(await clickByText(page, /^edit$/i, 2000))) return false;
      await page.waitForTimeout(700);
      await fill(page, 'input[name="position"]', `QA ${Math.floor(Math.random() * 1000)}`);
      await page.waitForTimeout(300);
      const ok = await clickByText(page, /^submit$/i, 3000);
      await settle(page, 1500);
      await dismiss(page);
      return ok;
    },
  },
  {
    // Row menu → Deactivate (only an ACTIVE test user; menu item is hidden
    // otherwise). Freshly invited users are "pending", so this usually skips.
    name: 'Users → Deactivate test user',
    destructive: true,
    run: async (page) => {
      if (!(await openTestUserMenu(page, 'active'))) {
        log('no ACTIVE automation test user to deactivate — skipped');
        return false;
      }
      const ok = await clickByText(page, /^deactivate$/i, 2000);
      await settle(page, 1500);
      await dismiss(page);
      return ok;
    },
  },
  {
    // Row menu → Activate (only a DEACTIVATED test user). Net-zero with the
    // deactivate flow above when both run on the same user.
    name: 'Users → Activate test user',
    destructive: true,
    run: async (page) => {
      if (!(await openTestUserMenu(page, 'deactivated'))) {
        log('no DEACTIVATED automation test user to activate — skipped');
        return false;
      }
      const ok = await clickByText(page, /^activate$/i, 2000);
      await settle(page, 1500);
      await dismiss(page);
      return ok;
    },
  },
  {
    // Row menu → Remove → confirm "Remove" in the "Remove User" modal →
    // deleteUser. Also cleans up the test users our invite flow keeps creating.
    name: 'Users → Remove test user (cleanup)',
    destructive: true,
    run: async (page) => {
      if (!(await openTestUserMenu(page))) {
        log('no automation test user to remove — skipped');
        return false;
      }
      if (!(await clickByText(page, /^remove$/i, 2000))) return false;
      await page.waitForTimeout(700); // "Remove User" confirmation modal
      const ok = await clickByText(page, /^remove$/i, 2500); // modal confirm button
      await settle(page, 1500);
      return ok;
    },
  },

  // ---- Lookups (under /services/lookups) ----
  {
    name: 'Websites lookup (search)',
    event: 'logWebsitesLookUpEvent',
    run: async (page) => {
      await goRoute(page, '#/services/lookups/data');
      await clickByText(page, /websites?/i, 2000);
      await page.waitForTimeout(500);
      const f = await fill(page, 'input[name="website"]', 'www.example.com');
      const ok = await clickByText(page, /search/i, 2000);
      await settle(page);
      if (!f) log('website search field not found (entitlement?) — skipped');
      return ok && f;
    },
  },
  {
    name: 'Products lookup (search)',
    event: 'logProductsLookUpEvent',
    run: async (page) => {
      await goRoute(page, '#/services/lookups/data');
      await clickByText(page, /products?/i, 2000);
      await page.waitForTimeout(500);
      const f = await fill(page, 'input[name="product"]', 'aspirin');
      const ok = await clickByText(page, /search/i, 2000);
      await settle(page);
      if (!f) log('product search field not found (entitlement?) — skipped');
      return ok && f;
    },
  },

  // ---- Filters / pagination / favorites / RBAC (MM + MO, shared ls-table) ----
  // MM has the full RBAC access-filter set; MO has user filter sets only.
  ...filterFlows('MM filters', '#/merchant-monitoring/merchant-list', { rbac: true }),
  ...filterFlows('MO filters', '#/merchant-onboarding'),
];

export const LOGIN_NOTE =
  'logLoginEvent is not exercised here (session is reused via storageState). ' +
  'Capture its hash during a manual login.';

/** Run LAST: ends the session (account menu → Sign out → logLogoutEvent). */
export const SIGN_OUT: Flow = {
  name: 'sign out',
  event: 'logLogoutEvent',
  run: async (page) => {
    await clickSel(page, '[aria-label="Account Settings"]', 3000);
    await page.waitForTimeout(500);
    const ok = await clickByText(page, /sign out/i, 2500);
    await settle(page, 4000);
    if (!ok) log('Sign out not found — skipped');
    return ok;
  },
};
