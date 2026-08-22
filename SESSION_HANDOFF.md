# Oishii Nori Command Suite — Session Handoff

**Date:** 2026-08-20 (build session) · **Updated:** 2026-08-22 (this update covers everything from the digital-menu redesign doc-sync through the current session's close-out: menu photos, the 11-milestone order-lifecycle/executive-tier overhaul, a 5-milestone bugfix pass, payroll demo data + system health check, the Generate Payroll bugfix + SMFC-parity payroll UX + PDF payslips + Oishii AI launch, the Inventory Count rebuild + sortable columns, Oishii AI's full-business data expansion, and shipment-receiving reactivation + unit cost/expiry tracking)
**Repo:** `D:\ioshinori\oishii-nori-command-suite` — pushed to GitHub: `https://github.com/vinsu-hub/OishiiNori` (private, `main` branch). Everything described in this document is committed and pushed as of this write-up — nothing is sitting as local-only changes.
**Live deployments (Vercel, team `vince-tamis`, Git-integration auto-deploy on push to `main`):**
- Dashboard: `https://oishii-nori-dashboard.vercel.app`
- Staff Clock kiosk: `https://oishii-nori-staff-clock.vercel.app`
- Backend API: `https://oishii-nori-api.vercel.app` (`/health` → `{"status":"ok"}`)
- Customer menu (QR table ordering, `apps/customer-menu`): `https://oishii-nori-menu.vercel.app`
**Reference spec:** `D:\ioshinori\Oishii_Nori_Menu_Ingredients.xlsx`
**Structural reference (read-only, different client, never push/pull):** `D:\SMFC_POS\saint_michael_pos\saint_michael_pos` — used throughout this project as a structural cross-compare/port source (executive-tier pages, POS Terminal richness, Inventory Count, HR Payroll, Malaya AI → Oishii AI).
**Build status: functionally complete and in active refinement.** All 4 apps deployed to production. The one long-standing blocker — the Supabase `hr` schema not being exposed to PostgREST — **is resolved** (confirmed repeatedly this session: `GET /hr/holidays`, `/attendance`, `/payroll`, `/employees` all 200 live). HR/Payroll is fully live-verified, including real generated payroll runs, PDF payslips, and demo data. The only open item is external, not code: the **xAI API key has no credits/license yet** (Oishii AI's context-building and prompt construction are fully verified correct; the actual LLM call returns a 502 with xAI's own billing-required message until the user adds credits at `console.x.ai`).

---

## 🧾 Inventory: shipment receiving reactivated + unit cost + expiry tracking (completed 2026-08-22)

`InventoryMovements.tsx` and its backend already fully supported logging a received shipment, but the page had **no Sidebar nav link** (it had been deliberately delisted mid-consolidation into Inventory Count in an earlier same-day commit, then never relinked) — staff could only reach it by typing the URL directly. Re-added to the Sidebar as **"Receive Shipment"**, visible to all roles (no role gate on the backend endpoint).

Restructured `InventoryMovements.tsx` into three tabs:
- **Receive Shipment** (new default tab) — a repeating-row batch form: add a row per ingredient (quantity, unit cost, optional expiry date), one shared supplier/invoice note applied to every line, submitted in parallel via the existing `POST /inventory-movements` (no new backend endpoint needed). During testing, the submit button and the tab trigger were both literally labeled "Receive Shipment" — a real ambiguity, not just a test artifact — so the submit button was renamed to **"Log Shipment"**.
- **Log Other Movement** — the original single-entry form, unchanged.
- **History** — the original movements table, now also showing expiry date.

**Ingredient unit cost tracking** (closes a gap hit repeatedly across this session — payroll payslips, loss records, and Oishii AI's inventory context all had to work around "no `unit_cost` column"):
- New `ingredients.unit_cost` column (migration `0021`, applied live). Auto-populated whenever a `delivery`/`trans_in` movement is logged with a `unit_cost_snapshot` — most-recent-cost costing, no weighted average.
- One-time backfill script (`services/api-fastapi/scripts/backfill_ingredient_unit_cost.py`) ran against the live DB: found priced delivery history for 1 of 73 ingredients (Salmon, ₱500) and backfilled it; the rest have no unit_cost yet since no priced deliveries existed for them before this feature.
- `POST /loss-records` now falls back to the ingredient's own `unit_cost` when the caller supplies neither `unit_cost` nor `cost_impact` — so shrinkage/spoilage logged from Inventory Count's shrinkage-dialog flow (which never asks for a cost) gets a real `cost_impact` instead of silently recording ₱0. Verified live: a spoilage entry with no cost supplied on an ingredient with `unit_cost=450` correctly computed `cost_impact=900` for quantity 2.

**Expiry tracking** (deliberately advisory, not exact per-batch/FIFO — this schema has no remaining-quantity-per-batch data, only a running `current_stock` total): optional expiry date on receiving (`inventory_movements.expiry_date`, same migration), new `GET /inventory/expiring-soon?days=7` (for each ingredient, looks at its single most recent delivery/trans_in movement with a non-null expiry date, flags it if within the window), surfaced as a new **"Expiring Soon"** summary card + detail list on Inventory Count.

**Verified live on production**: received a real shipment (Asparagus, 500g @ ₱80/unit, 5-day expiry) through the actual UI — stock increased correctly (1500→2000), `unit_cost` set to 80, and it appeared correctly in the Expiring Soon card, all confirmed via direct API check against `oishii-nori-api.vercel.app` after deploy.

**Brainstormed but not built this round** (documented backlog, not started): supplier/vendor tracking, purchase orders with expected-vs-received reconciliation, ingredient usage-trend analytics, real food-cost-% rollup per recipe (now unlocked in principle since `unit_cost` exists), low-stock notification/digest.

---

## 🤖 Oishii AI: full-business data context (completed 2026-08-22)

The CEO asked for Oishii AI to be able to answer about salary/payroll, inventory, losses (incl. by-reason like spoilage), and general stats — not just today's dashboard snapshot. Expanded `services/api-fastapi/app/routers/oishi_ai.py`'s context payload (sent fresh on every query) from 7 fields to 13:

- **`employee_roster`** — every employee's name/role/department/position/**pay_rate**/employee_number. This is the only place individual compensation figures come from; the system prompt explicitly warns the model never to estimate a person's pay from the aggregate payroll fields.
- **`payroll_history`** — last 12 generated payroll runs (period, totals), so "how much did we spend on payroll last month" resolves correctly instead of only ever seeing the current period.
- **`inventory_analysis` expanded** — `all_ingredients` (full list, not just low-stock), `by_category`, `total_ingredient_count`, `needs_review_count`, alongside the existing low-stock list.
- **`recent_inventory_movements`**, **`top_products_30d`** (alongside the existing today-only version), **`revenue_totals`** (this-week/this-month/all-time, alongside the existing 30-day daily trend), **`discount_types`**, **`digital_orders_summary`**, **`utility_cost_by_type_30d`**.
- `loss_analysis`/`recent_losses` were already comprehensive (all-time total, top driver, by-reason including spoilage) — unchanged.

Every new field got a corresponding paragraph in the system prompt's DATA FIELD GUIDE, same rigor as the existing fields, so the model maps a question to the right source instead of guessing.

**Note on scope**: this means employee `pay_rate` now transits to xAI's API as part of the prompt on every query. `/ai/query` is executive-only, so this doesn't widen who can see the data *inside* Oishii Nori — it's an explicit, user-requested tradeoff, called out to the user before building.

**A process note worth knowing for next time**: mid-edit on this file, the auto-mode permission classifier blocked two consecutive attempts to edit the inventory-analysis function (no stated reason given), even though a much larger edit to the same file — adding the employee roster with pay rates — had just gone through cleanly seconds earlier. Per the "don't retry past a block, surface it" policy, this was reported to the user directly rather than worked around; the user moved on to a different request in the meantime, and the interrupted edit was finished cleanly on the next pass (both blocked edits succeeded on retry with no changes). All 13 context-building functions were verified against the live dev DB (each returning real, correctly-shaped data) before committing.

**Verified working end-to-end except the final LLM call**: auth, context aggregation (all 13 sections), and error handling are all confirmed correct via direct testing. The actual `/ai/query` call to xAI currently returns `502` with xAI's own message: *"Your newly created team doesn't have any credits or licenses yet. You can purchase those on console.x.ai."* This is an external billing step only the user can do — no code changes needed once resolved. `XAI_API_KEY` is already set in `services/api-fastapi/.env.local` (gitignored) and in Vercel's Production + Preview env vars for `oishii-nori-api`.

---

## 📊 Inventory Count: batch count-sheet rebuild + sortable columns (completed 2026-08-22)

The original Inventory Count was a bare list with a one-item-at-a-time "Count" dialog. Rebuilt (structure ported from SMFC's reference, adapted — no backend changes, the existing `POST /inventory/{id}/count` and `POST /loss-records` endpoints already covered everything needed):

- **Batch count-sheet**: every ingredient gets a live "Counted" input; Save submits every non-empty entry in parallel. Live per-row variance/status (±5% = green "counted", else overage/shortage) computed client-side as you type.
- **Summary cards**: Items Counted (progress bar), Variance Detected, and (added in the shipment-receiving pass above) Expiring Soon. SMFC's "Expected Total Value" card was deliberately dropped at the time (no `unit_cost` existed yet) — worth revisiting now that `unit_cost` exists, not done.
- **"How It Works" explainer** (collapsible, generic counting-process copy) and an **"Items with Variance"** summary section below the main table.
- **Post-save shrinkage dialog**: any item that came up short prompts an optional "log as a loss" flow (reason picker, defaults to Shrinkage) — calls the real `POST /loss-records` with `skip_stock_deduction: true` since the count already set `current_stock` directly.
- **Sortable columns**: Item/Category/Expected/Variance/Status headers are clickable (asc/desc toggle, chevron indicator). Variance and Status sort against the *live* counted-value state (so sorting by Variance right before saving surfaces the biggest discrepancies), with uncounted rows always sorting last regardless of direction, and Status ranked by severity (shortage first on descending) rather than alphabetically.

Verified live end-to-end (local + production): entered a 20%+ shortage on a real ingredient, confirmed the shrinkage dialog appeared with the correct "short by" quantity, logged it as a loss, confirmed it landed on Loss Log with a real (non-zero, once `unit_cost` existed) cost, confirmed sorting by each column produces correct ordering including on live-typed variance values.

---

## 💰 Payroll: Generate bugfix + SMFC-parity UX + PDF payslips + Oishii AI launch (completed 2026-08-22)

**The reported bug ("pressed Generate Payroll, nothing showed") — root cause and fix**: `handleGenerate()` only ever refreshed the History tab, never the Preview tab the user was actually looking at — so a real success and a silent no-op looked identical on screen. Compounding it: the page's default period (current-month-to-date) usually has zero seeded attendance, and an empty result rendered as a blank table with no explanation. Fixed: Preview now refreshes in place after Generate, an explicit empty-state message replaces the blank table, and generating a period with `employee_count: 0` requires an extra confirmation.

**SMFC-parity richness layered on top** (structure cross-compared and ported from SMFC's `HRPayroll.tsx`, adapted — single-location, no branch selector):
- Summary cards (Total Payroll/Overtime/Night Diff/Holiday), a per-employee drawer (Overview/Breakdown/Payslip tabs), a "View" action on payroll history.
- **Real PDF payslips**: new `services/api-fastapi/app/payroll_pdf.py` (reportlab), `GET /payroll/receipt.pdf` (single employee) and `GET /payroll/receipts.zip` (bulk, all employees in a period) — wired to Receipt buttons and a "Download All Receipts" button. Verified via both direct curl (valid `%PDF`/zip magic bytes) and a real browser download of the ZIP.

**Oishii AI launched** (see the dedicated section above for its later data-expansion pass): modeled on SMFC's Malaya AI, using **xAI's Grok API** (OpenAI-compatible client, `base_url=https://api.x.ai/v1`) instead of Groq, since the user supplied an xAI key. New page `OishiAi.tsx` (chat log + suggested prompts + recharts charting for comparison/trend answers), executive-only nav item.

**Payroll demo data** (`services/api-fastapi/scripts/seed_payroll_demo.py`, disposable/run-manually):
- 5 employees with realistic June 1–15, 2026 semimonthly attendance, each deliberately exercising a different DOLE pay scenario (plain regular, overtime, a real seeded holiday, night differential, a worked rest day) — payroll generated for real through `POST /payroll`, numbers genuinely computed, not fabricated.
- A 6th employee, Liza Fernandez, added later with a full July 2026 calendar month (23 weekdays, 2 with overtime) to demo a full-month period rather than only semimonthly. Payroll for both periods live and visible on production right now.
- Idempotent: reruns reuse existing demo employees, replace stale attendance/payroll rows for the same period rather than duplicating.

**System health check** (`services/api-fastapi/scripts/system_health_check.py`, disposable): connectivity, auth (all 3 role tiers), a router smoke sweep, role-gating regression checks, a real end-to-end POS-sale lifecycle, a real end-to-end QR-order lifecycle, payroll consistency — **71/71 checks passed**, run against both dev and prod (they share one Supabase project). Confirms **the `hr` schema PostgREST exposure blocker mentioned throughout this project's earlier history is resolved** — this is what made all of the above possible.

---

## 🍱 Order-lifecycle cross-compare + executive-tier overhaul (11 milestones, completed 2026-08-22)

A full audit-and-improve pass across POS Terminal, Order Queue, Kitchen Display, and Pending Orders, cross-compared against SMFC's reference implementation, plus reopening SMFC's executive-tier feature set (deliberately dropped in the original Milestone 1 build as "not in scope") now that the client wants it. Executed as an 11-milestone plan, each independently verified live with zero console errors and test data cleaned up (voided through real endpoints) before moving on:

**Executive tier** (Milestones A–C, separate from the numbered 1–11):
- **POS Management** (`de6906c`) — discount-type CRUD, no backend changes, reused `discounts.py` directly.
- **Command Center** (`9375b20`) — new `GET /dashboard/summary` (today's revenue/discount/tax/loss/low-stock/utility-cost/department split, plus a best-effort staff-clocked-in count that degrades gracefully rather than 500ing if `hr` isn't exposed). Executive-only, single-location adaptation of SMFC's multi-branch rollup (department tabs instead of branch tabs). Executives now land here on login instead of Home.
- **Trend Analysis** (`9375b20`) — new `GET /analytics/sales-trend` and `/analytics/top-products`, both computing real series from `transactions`/`transaction_items` (unlike SMFC's own version, which is a hardcoded mock).
- A permanent `qa.manager@oishiinori.com` fixture was added (none existed before).

**Milestones 1–4** (`7442a78`) — shared infra + consistency fixes: hoisted `POLL_INTERVAL_MS`/`VAT_RATE_PREVIEW` into `lib/constants.ts`, unified currency formatting via the previously-unused `formatCurrency()` across all four pages, kitchen-status badges now vary by value on Order Queue, discount/tax now render when non-zero, Pending Orders' Decline now requires a reason (matching Order Queue's Void), a failed POS charge no longer leaves a stale Owner's Request confirmation staged for silent reuse.

**Milestone 5** (`bb9ebbc`) — held ingredients became a real, uniform field: new `transaction_items.held_ingredients` (migration `0019`, mirrors the digital-menu-only column from `0017`), written on every sale and correctly threaded through from an approved digital order (previously dropped on the floor). New **POS Terminal "Edit Order"** button lets a cashier hold ingredients per cart line, same recipe-lookup endpoint the customer-menu app already used. Order Queue/Kitchen Display now also fetch and correlate approved digital orders by `transaction_id`, rendering a "QR order · Table N" badge + add-ons.

**Milestone 6** (`0eedd8d`) — bundle-fulfillment status became backend-persisted instead of client-only session state: new `TransactionItemResponse.bundle_fulfilled` field, so a page reload correctly shows "Logged" instead of re-offering the rolls-used checklist on an already-fulfilled item.

**Milestone 7** (`3eb9f8d`) — POS Terminal gained **Held Orders** (park/resume, sessionStorage-scoped to the shift) and **Favorites** (star-toggle, localStorage-persisted) plus keyboard shortcuts (F4 hold, Escape clear).

**Milestone 8** (`ae342d5`) — an "upsell rail" suggesting up to 6 not-in-cart items from drinks/dessert/light-side categories.

**Milestone 9** (`dac5075`) — Order Queue gained search (order id/item name), a combined transaction-status + kitchen-status filter, a date filter, sort order, and pagination.

**Milestone 10** (`7f8be9d`) — Kitchen Display gained stat cards (Delayed count, Avg Prep Time, Longest Order) and per-card progress bars, all client-computed from already-fetched data (no new backend endpoint, a deliberate scope call).

**Milestone 11** (`202c4eb`) — sound alerts (Web Audio API synthesized beeps, not bundled audio files) on Kitchen Display (new queued order) and Order Queue (order reaches "ready"), each with a mute toggle.

**Menu photos** (`785f23c`, done just before this plan) — 17 product photos (compressed to ~60–100KB JPEGs) wired via a new `PATCH /products/{id}/image` endpoint; POS Terminal and the customer menu both show them.

---

## 🐛 Code review + 5-milestone bugfix pass (completed 2026-08-22)

An `xhigh` code review of the 11-milestone plan above found 15 findings; all fixed across 5 milestones, each verified live:

1. **Migration guard** — `held_ingredients` insert had no failure-detection guard (every other `0014`-era addition does); added the matching pattern so an unapplied migration degrades gracefully instead of 500ing every sale.
2. **Escape-key dialog bug** — the global Escape handler on POS Terminal wiped the entire cart even when a dialog was open and the cashier just meant to back out of it. First fix attempt (a bubble-phase guard) didn't actually work — Radix's own dialog-dismissal listener runs in the capture phase and closes first, so by the time the guard checked state it was stale. Fixed by registering on `window` with `{ capture: true }`, putting it earlier in the capture path. This was the one finding that needed a second attempt after the first visibly failed.
3. **UTC-vs-PH-timezone day bounds** — a bug present in three separate places (Order Queue's date filter, Command Center, Trend Analysis) all from the same earlier pattern; fixed once, shared: new `app/ph_time.py` (`ph_day_bounds_utc`) on the backend, `todayIsoPH()`/`daysAgoIsoPH()` in `lib/constants.ts` on the frontend.
4–5. Kitchen Display's Avg Prep Time wasn't actually date-scoped despite its own comment claiming it was; a rounded-to-zero average produced a false 100%-filled progress bar on a just-started order.
6–9. POS Terminal cart integrity: a held-ingredients line could silently merge with a plain line for the same product/size; cart line keys switched from `size.id` to a real per-instance id; resuming a held order no longer discards an in-progress unsaved cart (auto-holds it first); held orders now persist to `sessionStorage` (previously lost on ordinary in-app navigation, not just a hard reload).
10, 12. Order Queue: pagination could strand on a stale page after the poll shrinks the result set (fixed by clamping at read time, not via a reconciling effect); clearing the date filter silently switched to all-time data with no indicator — added a "Showing all dates" label.
11, 13, 15 (backend correctness/defensive limits): `void_transaction` reported a stale `bundle_fulfilled: true` in its own response on the same request that just cleared it (recomputed post-restore now); `reject_digital_order`'s "reason required" rule was client-only, now also enforced server-side; `_bundle_fulfilled_item_ids` now chunks its query into batches of 200; `list_digital_orders` gained a `limit` param matching the convention used elsewhere.

---

## 🚀 Deployment (established 2026-08-21, unchanged since)

**Vercel**: 4 projects under team `vince-tamis`, all Git-integration auto-deploy on push to `main` — no manual deploy step needed for any change described above. Every commit in this document has already gone through this pipeline and been production-verified via Playwright/curl against the live URLs.

**Not done, flagged for later**: `CORSMiddleware` in `app/main.py` still allows `allow_origins=["*"]`. Two throwaway `psycopg2-binary`/`uvicorn[standard]` entries remain in `requirements.txt` (harmless on Vercel, used by local dev/seed scripts).

---

## ⚠️ Action needed

**Resolved this session** (previously the single biggest blocker in this project's history):
- **The Supabase `hr` schema PostgREST exposure is confirmed live and working.** `GET /hr/holidays`, `/attendance`, `/payroll`, `/employees` all return real data (19 holidays seeded for 2026, 11 employees including 6 payroll-demo employees). Full HR/Payroll live verification is done — real generated payroll runs, PDF payslips, the full system health check's 71/71 pass.

**Still outstanding:**
1. **xAI billing** — Oishii AI's API key (`XAI_API_KEY`) is configured everywhere it needs to be (local + Vercel), and the entire request pipeline is verified correct up to the actual xAI call, which 502s with: *"Your newly created team doesn't have any credits or licenses yet."* Add credits/a plan at `console.x.ai` and it should work immediately with no code changes.
2. **Local dev port 8000 has an orphaned process** that couldn't be killed via Task Manager/PowerShell during this session (invisible to `Get-Process` but still holding the port per `Get-NetTCPConnection`). Worked around by running the local dev backend on port `8010` instead (`apps/dashboard-web/.env.local`'s `VITE_API_BASE_URL` was updated to match). A reboot would likely reclaim port 8000 if that's ever wanted back; otherwise 8010 works fine going forward.
3. Two minor, non-blocking items noted along the way, not fixed (low priority): no "Expected Total Value" card on Inventory Count yet (now unlocked since `unit_cost` exists, just not wired up), and the documented inventory-improvement backlog (supplier tracking, purchase orders, usage-trend analytics, food-cost-%, low-stock digest) — see the shipment-receiving section above.

---

## To continue

```bash
cd D:\ioshinori\oishii-nori-command-suite
```

Live Supabase project (already migrated + seeded, ref `vaagbeyvhzgvudxtwkmm`, URL `https://vaagbeyvhzgvudxtwkmm.supabase.co`) — **not** under the CLI-linked `vinsu-tams` org, so use `--db-url`/direct `psycopg2` (using `SUPABASE_DB_PASSWORD` from `.env.local`), not `supabase link`. **Note**: `supabase db push --db-url` re-attempts every migration in the folder including already-applied ones and will fail on the first one it hits — the established workaround this session is to apply only the new migration file directly via a small `psycopg2` script (see `services/api-fastapi/scripts/backfill_ingredient_unit_cost.py`'s neighborhood for the pattern, or any `apply_00NN.py`-style disposable script from this session).

```bash
# Backend (from services/api-fastapi)
services/api-fastapi/.venv/Scripts/python.exe -m uvicorn app.main:app --port 8010 --reload

# dashboard-web (from apps/dashboard-web), port 3000
npm install && npm run dev

# staff-clock (from apps/staff-clock), port 5174
npm install && npm run dev

# customer-menu (from apps/customer-menu), port 5175
npm install && npm run dev
```

Note the backend now runs on **8010** locally (see Action Needed #2 above) — `apps/dashboard-web/.env.local`'s `VITE_API_BASE_URL` already points there.

---

## Locked scope decisions (don't re-litigate without the user)

- **Single branch, two departments** (kitchen, cafe). No `organizations`/`branches` tables, no branch-scoped RLS — this build is single-tenant by design.
- **HR/Payroll/Staff-Clock IS in scope** — fully live, including real payroll generation and PDF payslips.
- **Executive tier IS in scope** (reversal of the original Milestone 1 decision) — Command Center, Trend Analysis, POS Management, and Oishii AI are all built and live. What remains genuinely out of scope from the SMFC reference: Newsfeed, EOD Dashboard, branch-scoping, product modifiers, websockets/Supabase Realtime (this app polls throughout, by design).
- **Sushi Boat bundle = "classic flavors" only**, excludes Dragon Maki/Oishii Maki — enforced in Kitchen Display's rolls-used checklist.
- Inventory expiry tracking is **advisory only** (most-recent-delivery based), not true per-batch/FIFO tracking — a deliberate scope-down, documented in the shipment-receiving section above.

---

## Historical build record (earlier sessions — admin login/rebrand through the original 8-phase build)

The sections below predate everything documented above and are kept as historical record — the architectural rationale in them (why colors/fonts were chosen, how the digital-menu approval flow works, the Vercel deployment debugging story, the xlsx reconciliation findings, the phase-by-phase build history) is still useful context for anyone working deeper in those areas.

---

## 🎨 Admin login + brand rebrand (completed 2026-08-21, pushed and live)

**Admin login**: Supabase Auth requires a real email format, so a bare `admin` username can't hit the network as-is. Fix: `Login.tsx`'s field is now plain text labeled "Username" (was `type="email"`); on submit, any value without an `@` gets `@oishiinori.com` appended before calling `signInWithPassword` (`email.includes('@') ? email : \`${email}@oishiinori.com\``) — existing full-email logins (`qa.tester@oishiinori.com`) are unaffected since they already contain `@`. A real `admin@oishiinori.com` / `admin123` account (executive role, `employee_number = ADMIN-001`, kiosk PIN `1234`) was created directly via the service-role client (same idempotent pattern as `qa_phase2.py`'s `ensure_qa_user`). Verified live via Playwright: typing literally `admin`/`admin123` logs in successfully.

**Brand rebrand**: replaced the "Warm Slate" beige/teal design-system theme with a red/black/gold palette per a brand guide the user supplied, **light-touch** scope (kept the cream page backgrounds and card layout, did not do a dark-header reskin). Applied to both `dashboard-web` and `staff-clock` (they share the same palette, previously duplicated by hand across two `index.css` files — still duplicated, just with new values, no cross-app CSS sharing was introduced).
- Primary/accent (buttons, active nav, "Charge"): teal `#14524B` → brand-red `#D42A2A`.
- Destructive/error/"Unavailable" badges: `#B23A2E` → brand-red-**dark**/maroon `#5C0F10` — deliberately *not* the same red as primary, so a "Charge" button and an "Unavailable" badge stay visually distinct (a real usability call, not in the brand guide, flagged to the user in the plan).
- New success green `#2F9E44` (guide's own suggestion — the brand palette has no green).
- Warning/"Bundle" promo tags: gold `#FFC93C` — added a new `gold` badge variant (`apps/dashboard-web/client/src/components/ui/badge.tsx`) since none of the existing 4 variants mapped to it; wired up on POS Terminal's "Bundle" badge only (left "Owner's Request" as `secondary`, not a promo callout).
- Department colors (`DEPARTMENT_CONFIG` in `lib/types.ts`, plus matching fallback literals in `Sidebar.tsx`/`Header.tsx`): kitchen → maroon `#5C0F10`, cafe → gold `#FFC93C` (both distinct from the new primary red).
- Display font: Space Grotesk → Archivo Black (Google Fonts `@import` in both `index.css`, plus the redundant `<link>` in `staff-clock/client/index.html`); body (Inter) and mono (IBM Plex Mono, tabular prices) unchanged — both already matched the brand guide's own suggestions.
- A few tone values (surface-inset/pressed shades, success/warning/error tint backgrounds) are **derived**, not literal brand-guide hex values — needed to preserve the existing soft-UI light/dark tonal relationships now rebased on cream instead of beige.

Verified via `tsc --noEmit` (clean, both apps) and Playwright screenshots: Login, Home/Sidebar/Header, POS Terminal (cart + enabled red Charge button + gold Bundle badges + maroon Unavailable badges), Kitchen Display — zero console errors.

**Not done**: no dark header/sidebar reskin, no category-grouped ALL-CAPS section headers on POS Terminal (would need restructuring the product grid, not just tokens — flagged as out of scope), no copy/microcopy pass, no new logo asset (existing `logo.jpg` already matches the guide's badge description). **Pushed and deployed** — confirmed live on `oishii-nori-dashboard.vercel.app` via a fresh Playwright login as `admin`/`admin123` against production.

---

## 🛎️ Digital menu — QR table ordering (completed 2026-08-21, pushed and deployed)

New feature, not part of the original 8-phase master plan: a customer scans a QR code at their table, orders from their phone with no login, and staff approve + manually confirm payment (GCash/Cash) on a new dashboard page before the order becomes a real sale.

**Architecture decision**: a `digital_orders` row is a staging area, never a sale directly. Approving one calls the exact same insert/deduction logic a POS sale uses (see refactor below), so it flows into Kitchen Display/inventory with zero special-casing. Rejecting one never touches `transactions` at all. This kept the existing, already-tested sales/kitchen pipeline completely untouched.

**Schema** — `supabase/migrations/0016_digital_orders.sql`, applied to the live DB: new `digital_orders` (status pending/approved/rejected, table_number as a bare int with no table-management entity, payment_method gcash/cash, subtotal, links to the resulting `transaction_id` once approved) and `digital_order_items` tables. RLS enabled, no anon/authenticated policies — same fail-closed posture as every other table, all access goes through the FastAPI service-role client.

**Backend** — `services/api-fastapi/app/routers/digital_menu.py` (new router, registered in `main.py`):
- Public, unauthenticated (no `Depends(get_current_user)`, mirrors `kiosk.py`'s pattern exactly): `GET /public/menu`, `POST /public/orders`, `GET /public/orders/{id}`. Prices are always recomputed server-side from the live catalog, never trusted from the client. The customer's own status-polling page looks up by the order's unguessable UUID, never by the sequential `order_number`, so one table can't see another's order.
- Staff-facing, authenticated (same access level as POS charging, no extra role gate): `GET /digital-orders?status=pending`, `POST /digital-orders/{id}/approve`, `POST /digital-orders/{id}/reject`.
- **Refactor for reuse, not duplication**: extracted `_create_transaction_row()` out of `transactions.py`'s `create_transaction` (which now just does the auth/Owner's-Request checks, then calls the shared helper) — `products.py`'s `list_products` got the same treatment (`_list_products_data()`), so `GET /products` (authenticated) and `GET /public/menu` (public) share one query body instead of two copies.

**Frontend** — new standalone app, `apps/customer-menu` (Vite, port 5175 locally), scaffolded identically to `apps/staff-clock`: no router, no Supabase client, plain unauthenticated `fetch()` (`lib/api.ts`), same brand palette/fonts as the rest of the suite at the time (later fully redesigned, see below). Reads `?table=N` from the URL once on mount; a menu screen (grouped by category) → cart → payment-method picker → a confirmation screen that polls order status every 5s until staff approve/reject.

**Dashboard** — new page `apps/dashboard-web/client/src/pages/PendingOrders.tsx` at `/pending-orders` (sidebar nav item, `QrCode` icon), built following `OrderQueue.tsx`'s exact shape: poll every 20s, `Card` per pending order (table number, order number, gold payment-method badge, resolved item names, customer note), "Approve" opens a confirm dialog, "Decline" opens a reason dialog. No changes needed to `KitchenDisplay.tsx`/`OrderQueue.tsx` — approved orders just appear there automatically.

**QR codes**: no runtime generation, no new dependency — a table's QR is just a static URL (`https://<customer-menu-url>/?table=N`), generated once via any free external tool and printed.

**Verified live**: 29/30 automated checks passed (the 1 "failure" was the test script's own wrong formula, not a real bug) plus a full Playwright walkthrough — customer on a phone-sized viewport orders, staff approves, order appears correctly on Kitchen Display with its bundle checklist available, zero console errors throughout.

**Not done / deferred** (per the user's own decisions): real GCash payment-gateway integration (manual confirmation only), a `tables` management admin page, customers editing/cancelling their own order, discounts on customer orders, daily-reset order numbering.

A 4th Vercel project, `oishii-nori-menu`, was created and linked to `apps/customer-menu`. Live at `https://oishii-nori-menu.vercel.app`.

---

## 🎌 Digital menu visual redesign + add-ons/holds (completed 2026-08-22)

The user supplied a separately-built UI design for the digital menu (cloned from `https://github.com/vinsu-hub/oishii-nori-digital-menu`, read-only reference, not part of this repo) — a pure UI prototype (Manus-generated) with **zero real backend** (all data hardcoded, "Ready for the counter" just flipped local state). The design itself ("Quiet Japanese Editorial" — vermilion/warm-paper/charcoal, DM Sans + Noto Serif JP, staggered entrance animations, bottom-sheet cart, torn-ticket receipt) was genuinely well-crafted.

**Merge approach**: ported the prototype's exact visual design and interaction patterns onto `apps/customer-menu`'s real backend integration wholesale — replaced 100% of the fake data/chrome, kept 100% of the real data flow, extended the backend only for the two pieces of real functionality explicitly asked for (add-ons, ingredient holds). User confirmed up front: adopt the new palette fully (customer-menu now deliberately looks different from dashboard-web/staff-clock's red/black/gold — a distinct customer storefront look), build add-ons/holds for real, design around the prototype's missing hero/category photos (typography-only, later given real photos — see the "Add menu item photos" note further down), show the full real catalog.

**New schema** — `supabase/migrations/0017_menu_addons_and_holds.sql`, applied live: `menu_addons` (seeded with the prototype's own 5 add-ons) and `digital_order_addons` tables, plus `digital_order_items.held_ingredients text[]`. Add-ons are priced/taxed real line items but deliberately **not** wired into recipe/ingredient deduction (digital-menu-only concept). Held ingredients are informational text for the kitchen, sourced from the product's real `recipe_items`.

**Backend additions**: `GET /public/addons`, `GET /public/product-sizes/{id}/recipe` (public variant of the existing authenticated recipe route). `POST /public/orders` accepts `addons`/`held_ingredients` and recomputes add-on prices server-side. `POST /digital-orders/{id}/approve` tops up the resulting transaction's `total_amount`/`tax_amount` with the add-ons subtotal.

**Frontend**: `apps/customer-menu`'s `index.css` and `App.tsx` rewritten in full with the new palette/fonts and the prototype's component structure ported 1:1 onto real data — sticky header, typography-only hero, a real category rail, item modal with a real ingredient-hold checklist and add-ons panel, receipt-styled confirmation screen driven by real polling.

**Verified live**: 13/13 automated checks plus a full Playwright walkthrough (real ingredients held, real add-on added, checkout, receipt-styled confirmation correctly polling pending → confirmed with the real dish name), zero console errors.

Shortly after, real product photos were added (`785f23c`): 17 photos (compressed to ~60-100KB JPEGs) copied into both `dashboard-web` and `customer-menu`'s `public/` folders, a new `PATCH /products/{id}/image` endpoint (manager/executive only) wired up, POS Terminal and the customer menu product cards/modals now show them when set. A follow-up fix (`4aff314`) corrected a mobile CSS bug where item thumbnails rendered as ovals instead of circles (a media-query grid column was narrower than the thumbnail itself).

---

## 🚀 Deployment debugging detail (2026-08-21)

**GitHub**: auth was fixed by the user (`gh auth login -h github.com`); repo pushed to `https://github.com/vinsu-hub/OishiiNori.git` (private), branch `main`.

**Vercel**: all pre-existing projects deployed via Git integration (auto-deploy on push to `main`), per the user's explicit choice over direct CLI deploy. Config copied from the SMFC reference project's proven pattern:
- `apps/dashboard-web/vercel.json` and `apps/staff-clock/vercel.json`: SPA rewrite matching each app's Vite `root: "client"` / `build.outDir: "dist/public"` config.
- `services/api-fastapi/api/index.py`: thin Vercel entrypoint.
- `services/api-fastapi/vercel.json`: **not part of the SMFC pattern, added after debugging a real issue** — see below.

**Real issue hit and fixed**: after the first deploy, `oishii-nori-api`'s root-level routes (`/health`, `/products`, etc.) all 404'd with `X-Vercel-Error: NOT_FOUND` — confirmed via `curl -v` that the request never reached the Python function at all. Root cause: Vercel's zero-config Python auto-detection only auto-routes the literal `/api/*` prefix; it does **not** catch-all route bare paths like `/health` the way SMFC's deployment apparently does. Fixed by adding `services/api-fastapi/vercel.json` with an explicit catch-all rewrite: `{"rewrites": [{"source": "/(.*)", "destination": "/api/index"}]}`.

**Root Directory** had to be set manually per project via the Vercel dashboard (Settings → General) — confirmed there is no CLI or `vercel.json` equivalent for this setting on an already-existing project.

**Env vars** set via `vercel env add`, values piped directly from local gitignored `.env.local` files (never typed into chat).

---

## 📋 Logo branding + Milestone 6 integration QA (completed 2026-08-21)

**Logo branding**: real logo (`D:\ioshinori\logo\logo.jpg`) copied into both apps' `public/` dirs, wired as favicon, swapped in for the placeholder letter-square branding in `Sidebar.tsx`, `Header.tsx`, `Login.tsx` (dashboard-web) and `App.tsx` (staff-clock).

**Milestone 6 — Integration & cross-agent QA**: one integrated order-lifecycle test run for real via Playwright against the actual browser UI: a Medium Baked Kani Sushi + a Small Sushi Boat rung up together via POS Terminal, recipe deduction confirmed correct on the scaled item, order appeared on Kitchen Display, walked queued→preparing→ready, the bundle's 34-piece rolls-used checklist logged (California Maki ×20 + Crazy Maki ×14), Dragon Maki/Oishii Maki correctly absent from the checklist, order reached `completed`. Direct-DB-verified ingredient draw-down matched the expected recipe deductions. Voided afterward, stock direct-DB-confirmed fully restored. Catalog re-cross-check confirmed all counts still matched the Phase 1 baseline (50 products, 60 product_sizes, 73 ingredients, 294 recipe_items, 5 bundle_components). `bundle_components.notes` resolved on both Sushi Boat rows (classic flavors excludes Dragon Maki/Oishii Maki).

**Process note — auto-mode classifier blocked a plan-authorized action.** The `bundle_components.notes` update is a direct Supabase `.update()` call (no FastAPI endpoint exists for this table) — this session's plan explicitly pre-authorized it as the one sanctioned data change. The auto-mode classifier blocked it anyway on the first attempt (it doesn't have visibility into plan-level authorization). Per the standing "no retry-past-a-block" policy, this was surfaced directly to the user rather than retried automatically; the user explicitly chose "retry it now," and the retry then succeeded normally.

---

## What this session covered (original 8-phase build, 2026-08-20/21)

### Phase 0 — Infra bootstrap
- Local repo scaffolded, git initialized. 3 Vercel projects created under `vince-tamis`. Supabase project `vaagbeyvhzgvudxtwkmm` supplied by the user (the `vinsu-tams` org's own free-tier cap made creating a dedicated one impossible).
- **Graphify knowledge graph** built: merged the SMFC structural reference with a fresh extraction of the xlsx spec → 1,790 nodes / 4,109 edges at `graphify-out/` (query with `graphify query "<question>"` from that directory).
  - **Mishap + fix**: the first `graphify export obsidian` run dumped ~1,983 loose per-entity notes flat into the root of the user's real Obsidian vault, mixed in with their existing curated client folders. Caught immediately, moved (not deleted) into `D:\OBSIDIAN\Varix\Oishii Nori\Graph\` using graphify's own manifest of exactly what it wrote — vault root confirmed restored to its original state.

### Xlsx reconciliation findings (superseded the master plan's pre-xlsx estimates)
- **50 distinct products, 60 (product, size) rows**, not "45" as originally assumed.
- **5 real kitchen stations** (Sushi Bar, Sushi Bar / Oven, Hot Line, Salad/Cold Bar, Cafe Bar), not the 3 originally assumed.
- `product_sizes` scale-factor model confirmed mostly valid — 3 of 5 multi-size products scale by one uniform factor; 2 have one ingredient at their Large tier that deviates slightly, traced to the literal xlsx values, not a bug.
- 72 Ingredient Master rows + 1 genuinely new ingredient found during seeding ("Water", used only in Amerikano).
- 5 bundle/platter rows, all "kitchen logs actual rolls used, not auto-proportional deduction" — implemented as the real `bundle-fulfillment` endpoint.

### Phase 1 — Schema & seed (QA-gated, passed after one fix round)
13 migrations (`0001`–`0013`) applied live. Seed script (`seed_from_xlsx.py`) parses the xlsx directly with openpyxl, populated 50 products, 60 product_sizes, 73 ingredients, 294 recipe_items (54 `needs_review=true`), 5 bundle_components. Independent QA found and fixed 2 real defects: an ingredient alias-map swap (Cheese blend ↔ Mozzarella cheese), and a missing FK on `inventory_movements.reference_id` (migration `0015`).

### Phase 2 — Backend API (built, later fully live-verified)
FastAPI app at `services/api-fastapi/` proven end-to-end: size-tier deduction, forward-only kitchen state machine, bundle-fulfillment endpoint, void+restore, auth. `hr.py`/`kiosk.py` were coded correctly from the start but blocked on the Supabase schema-exposure step — **this is now resolved** (see Action Needed section above).

A formal QA pass (`qa_phase2.py`) later passed 22/22 checks on everything not blocked by `hr` at the time: discounts role-gating/CRUD, transaction+discount math, both loss-record deduction paths.

### Phase 3-7 frontend build
Plan-driven, 6 milestones, port-and-adapt from the SMFC reference (Vite+React 19+TS+Tailwind v4, shadcn/ui+wouter / thin PIN-only React), retargeted onto Oishii Nori's single-location/two-department model. Polling throughout, not websockets/Realtime.

- **Milestone 1** — app scaffolding + shared shell: both apps real and wired to the live backend.
- **Milestone 2** — POS Terminal + Order Queue, written fresh against this schema (SMFC's version carries modifiers/branch-selector that don't exist here) but with the Owner's Request PIN re-auth dialog and discount/tax pattern ported directly.
- **Milestone 3** — Kitchen Display, with the 5 real stations as a filter and the `BundleFulfillmentChecklist.tsx` completion gate.
- **Milestone 4** — Inventory UI + Utility Log, with a cost-check nudge gated on the ingredient's live `cost_volatility_tier` rather than a hardcoded name list.
- **Milestone 5** — HR/Payroll admin pages (`HRAttendance.tsx`, `HRPayroll.tsx`, `HolidayCalendar.tsx`, `PayrollSettings.tsx`, `Employees.tsx`) ported/built, type-checked; live verification was blocked at the time on the `hr` schema issue (later resolved).
- **Milestone 6** — see "Logo branding + Milestone 6" section above.

---

## Key file locations
| What | Where |
|---|---|
| Live DB credentials | `services/api-fastapi/.env.local` (+ same pattern in the other 3 apps) — gitignored |
| Migrations | `supabase/migrations/0001`–`0021`, all applied live |
| Seed / demo-data scripts | `services/api-fastapi/scripts/seed_from_xlsx.py` (catalog), `seed_payroll_demo.py` (HR demo data), `backfill_ingredient_unit_cost.py` |
| QA / health-check scripts | `services/api-fastapi/scripts/qa_phase2.py`, `system_health_check.py` (71/71 passing) |
| Backend app | `services/api-fastapi/app/` (routers: products, recipes, inventory, inventory_movements, discounts, loss_records, hr, kiosk, transactions, utility_logs, digital_menu, dashboard_summary, analytics, oishi_ai) |
| Dashboard frontend | `apps/dashboard-web/client/src/` (pages, components, lib/api.ts) |
| Staff Clock kiosk frontend | `apps/staff-clock/client/src/` |
| Customer menu (QR ordering) frontend | `apps/customer-menu/client/src/` |
| QA/demo accounts | `qa.tester@oishiinori.com` / `oishii1234-qa` (executive), `qa.manager@oishiinori.com` (manager), `qa.employee@oishiinori.com` (employee), `admin@oishiinori.com` / `admin123` (executive, literal-username login) — plus 6 payroll-demo employees (Maria Santos, Juan Dela Cruz, Ana Reyes, Mark Villanueva, Rico Bautista, Liza Fernandez) |
| Graphify graph | `graphify-out/graph.json` (query from repo root) |
| Obsidian project note | `D:\OBSIDIAN\Varix\Oishii Nori\Oishii Nori - Overview.md` |
