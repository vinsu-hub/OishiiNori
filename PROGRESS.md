# Oishii Nori Command Suite — Progress / Task Board

Status as of 2026-08-21 (Milestone 6 close-out, then git push + Vercel deployment, same day). Phase 2 (backend API) closed out with a formal live QA pass (22/22 checks). Phase 3-7 frontend build — **all 6 milestones done and verified live**, including Milestone 6 integration QA. Logo branding completed, and the app is now **live in production** on Vercel. Subagent DB-write autonomy is **check-in required** per user decision — any destructive/schema-changing op stops and asks first; the auto-mode classifier independently enforced this same policy this session (see below). Update this file as phases advance; it's the shared task board the master orchestrator prompt calls for.

**Overall: ~99% complete. All 8 original phases are done or code-complete, plus a new Phase 9 (digital menu), and all 4 apps are deployed.** Live URLs: dashboard `https://oishii-nori-dashboard.vercel.app`, staff clock `https://oishii-nori-staff-clock.vercel.app`, API `https://oishii-nori-api.vercel.app`, customer menu `https://oishii-nori-menu.vercel.app`. Only remaining blocker: the Supabase `hr` schema exposure toggle (blocks live verification of Phase 2's `hr.py`/`kiosk.py` and Phase 7's HR pages only — code itself is built, type-checked, and deployed). Nothing remains to be ported from the SMFC reference: every page/feature in the locked scope is built; what's left of SMFC (Malaya AI chat, Command Center, Trend Analysis, Newsfeed, EOD Dashboard, branch-scoping, modifiers, websockets/Realtime) was deliberately excluded, not missed.

**Admin login + brand rebrand — done and deployed 2026-08-21.** `admin`/`admin123` now works as a literal typed login (Login.tsx username field + a real `admin@oishiinori.com` account); full red/black/gold brand rebrand applied to both apps' CSS tokens, `DEPARTMENT_CONFIG`, and a new gold "Bundle" badge variant, per the user's brand guide (light-touch scope, no dark header reskin). See `SESSION_HANDOFF.md` "🎨 Admin login + brand rebrand" section for full detail. `tsc --noEmit` clean, verified visually via Playwright against production.

**Digital menu (QR table ordering) — new feature, done and deployed 2026-08-21.** A 4th app, `apps/customer-menu` (live at `oishii-nori-menu.vercel.app`), lets a customer scan a per-table QR code and order with no login; orders land as `pending` in a new `digital_orders`/`digital_order_items` schema (migration `0016`, applied live) and show up on a new staff page, `/pending-orders`, for approval + manual payment confirmation (GCash/Cash). Approving creates a real `transactions` row through the exact same insert/deduction path as a POS sale (a small refactor extracted `_create_transaction_row` out of `create_transaction` so both share it) — approved orders need zero extra code to show up correctly on Kitchen Display, confirmed live. New public (unauthenticated) backend endpoints: `GET /public/menu`, `POST /public/orders`, `GET /public/orders/{id}` — same no-JWT pattern as `kiosk.py`, safety enforced by never trusting a client-sent price and never looking up an order by its guessable sequential number. See `SESSION_HANDOFF.md` "🛎️ Digital menu" section for full detail, including the live QA pass (29/30 automated checks + a full Playwright walkthrough, customer phone-sized viewport → staff approval → Kitchen Display, zero console errors, then re-verified against the deployed production URLs).

| Phase | Status |
|---|---|
| 0 — Infra bootstrap | **Done** — GitHub repo pushed, all 4 apps deployed to Vercel (2026-08-21) |
| 1 — Schema & seed | Done (one non-blocking open item below) |
| 2 — Backend API | Done; `hr.py`/`kiosk.py` code correct but unverified live (blocked on `hr` schema exposure) |
| 3 — POS Terminal + Order Queue | Done, verified live |
| 4 — Kitchen Display | Done, verified live |
| 5 — Inventory UI + Utility Log | Done, verified live |
| 6 — Integration & cross-agent QA | **Done, verified live 2026-08-21** — see below |
| 7 — HR/Payroll/Staff-Clock | Built + type-checked; live verification blocked on the same `hr` schema issue as Phase 2 |
| 9 — Digital menu (QR ordering, new feature) | **Done, verified live and deployed 2026-08-21** — see above |

**Logo branding — done 2026-08-21.** Real logo (`D:\ioshinori\logo\logo.jpg`) wired in as favicon on both apps and replacing the placeholder letter-square marks in `Sidebar.tsx`, `Header.tsx`, `Login.tsx` (dashboard-web), and `App.tsx` (staff-clock). Verified visually via Playwright screenshots; `tsc --noEmit` clean.

**Milestone 6 — done 2026-08-21.** One integrated order-lifecycle test run for real via the browser (POS Terminal → Kitchen Display → bundle checklist → Order Queue void): a Medium Baked Kani Sushi + a Small Sushi Boat rung up together, recipe deduction confirmed on the scaled item, order walked queued→preparing→ready on Kitchen Display, the 34-piece rolls-used checklist logged (California Maki ×20 + Crazy Maki ×14) with Dragon Maki/Oishii Maki correctly excluded, order reached `completed`, ingredient draw-down direct-DB-verified correct for both the scaled item and the logged rolls, voided and fully restored to baseline. Catalog re-cross-check confirmed all 5 counts unchanged from the Phase 1 baseline (50 products, 60 product_sizes, 73 ingredients, 294 recipe_items, 5 bundle_components). The Sushi Boat `bundle_components.notes` REVIEW text was replaced on both rows with the resolved "classic flavors excludes Dragon Maki/Oishii Maki" decision text.

One process note: the direct Supabase `.update()` call needed for the `notes` text change was blocked by the auto-mode classifier (a raw DB write bypassing the FastAPI app) even though it was the one change explicitly pre-authorized in this session's plan — the classifier doesn't know about plan-level authorization. Surfaced to the user directly rather than retried automatically; the user explicitly authorized the retry and it then succeeded. No workaround was attempted.

**Git push + Vercel deployment — done, later the same day (2026-08-21).** GitHub auth fixed by the user; repo pushed to `https://github.com/vinsu-hub/OishiiNori` (private, `main`). All 3 Vercel projects deployed via Git integration. Root Directory had to be set manually per project (no CLI/vercel.json path exists for that setting on an existing project) — dashboard-web → `apps/dashboard-web`, staff-clock → `apps/staff-clock`, api → `services/api-fastapi`. Hit and fixed one real issue: the API's root-level routes 404'd at the Vercel edge (zero-config Python only auto-routes `/api/*`, not bare paths) — fixed with an explicit `services/api-fastapi/vercel.json` catch-all rewrite. Verified end-to-end via Playwright against the live URLs: login + POS Terminal on `oishii-nori-dashboard.vercel.app` correctly calling `oishii-nori-api.vercel.app` (200s, zero console errors). See `SESSION_HANDOFF.md` "🚀 Deployment" section for full detail. Only the `hr` schema exposure toggle remains out of scope (external Supabase Dashboard step only the user can do).

Legend: `[x]` done & QA-passed · `[~]` in progress / partially done · `[ ]` not started · `[!]` blocked

---

## Phase 0 — Infra bootstrap
- [x] New local git repo scaffolded (`D:\ioshinori\oishii-nori-command-suite`)
- [x] GitHub repo — **done 2026-08-21**, pushed to `https://github.com/vinsu-hub/OishiiNori` (private, `main`)
- [x] Supabase project — using client-provisioned project `vaagbeyvhzgvudxtwkmm` (the `vinsu-tams` org's free-tier cap made creating a dedicated one impossible without a plan upgrade)
- [x] 3 Vercel projects created and **deployed to production 2026-08-21** (`oishii-nori-api`, `oishii-nori-dashboard`, `oishii-nori-staff-clock`)
- [x] `.env.example` (placeholder) + `.env.local` (real, gitignored) for all 3 apps
- [x] Obsidian project note + graphify knowledge graph (1,790 nodes / 4,109 edges)
- [x] Location scope confirmed: single branch, two departments (kitchen, cafe)
- [x] HR/Payroll/Staff-Clock scope confirmed: **in scope** (not deferred)

## Phase 1 — Schema & seed
- [x] 13 migrations (`0001`–`0013`) written and applied live
- [x] Seed script (`seed_from_xlsx.py`) parses xlsx directly, populated live DB
- [x] Independent QA pass — PASS, 2 defects found
- [x] Defect 1 fixed: alias-map swap (Cheese blend ↔ Mozzarella cheese) — verified live
- [x] Defect 2 fixed: missing FK on `inventory_movements.reference_id` (migration `0015`) — verified live
- [x] Orchestrator's own independent re-verification (fresh queries, not agent self-reports) — clean
- [ ] **Open, not blocking**: client confirmation still needed on ambiguous ingredient aliases (e.g. "Special sauce" used across 5 different rolls)
- [x] Sushi Boat "classic flavors" scope question — **resolved 2026-08-21**: excludes premium rolls (Dragon Roll, Oishii Maki). `bundle_components.notes` text itself still says REVIEW (data update deferred to Milestone 6 integration QA), but the decision is final for Milestone 3's Kitchen Display work.

## Phase 2 — Backend API
- [x] FastAPI app scaffolded (`main.py`, `deps.py`, `auth.py`, `schemas.py`, `attendance_utils.py`)
- [x] `products.py`, `recipes.py` — proven live (size-tier resolution correct)
- [x] `transactions.py` — order creation, size-scaled recipe deduction, forward-only kitchen state machine, bundle-fulfillment endpoint, void+restore — all proven live with real requests
- [x] `inventory.py`, `inventory_movements.py` — count-and-reconcile used for test cleanup, proven working
- [x] `discounts.py`, `loss_records.py` — built, not yet exercised with real requests beyond CRUD
- [~] `hr.py`, `kiosk.py` — coded, DOLE-style pay engine ported from SMFC, **blocked**: `hr` Postgres schema not yet exposed to PostgREST (manual Supabase Dashboard step, see `SESSION_HANDOFF.md` Action Needed #2). Confirmed 2026-08-21 via live QA script that it's still genuinely blocked (`PGRST106 Invalid schema: hr`), not a stale note.
- [x] Migration `0014`'s keep/revert decision — **resolved 2026-08-21: kept** (confirmed purely additive, RLS-safe; see `SESSION_HANDOFF.md`)
- [x] Formal QA pass on Phase 2 — **done 2026-08-21**, `services/api-fastapi/scripts/qa_phase2.py`, 22/22 checks passed (discounts role-gating + CRUD, transaction+discount math, both loss-record deduction paths). hr/kiosk portion written but gated behind the schema-exposure blocker above — rerun once unblocked.

## Frontend build architecture (Milestone 0, done 2026-08-21)
- [x] Plan: `C:\Users\vinsu\.claude\plans\ancient-dreaming-lighthouse.md` — port-and-adapt from SMFC's already-built `dashboard-web`/`staff-clock` (Vite+React 19+TS+Tailwind v4+shadcn/ui+wouter / thin PIN-only React), 6 checkpointed milestones.
- [x] Milestone 1 — app scaffolding + shared shell: both apps real and running (`dashboard-web` :3000, `staff-clock` :5174, backend :8000). `lib/api.ts`, `AuthContext`, `Sidebar`/`Header`/`DashboardLayout` (13-item nav, department- not branch-themed) real; Login/Home/Settings real. `staff-clock`'s full state machine wired to real `kiosk.py` (break flow dropped, no backend support) — this turned out to be the *complete* staff-clock build, not just a shell; nothing further was needed for it in Milestone 5. Verified via `tsc --noEmit` + Playwright login.

## Phase 3 — POS Terminal + Order Queue
- [x] Milestone 2 — done 2026-08-21. `POSTerminal.tsx`/`OrderQueue.tsx` built fresh against Milestone 1's conventions (not a literal SMFC port — SMFC's has modifiers/held-ingredients/branch-selector this schema doesn't). Owner's Request PIN re-auth dialog and client-preview/server-authoritative discount+tax pattern ported directly from SMFC. Verified live: multi-size sale with a VAT-exempt discount produced exactly correct `discount_amount`/`tax_amount`, Owner's Request recorded correctly, void works, test data cleaned up.
- [ ] Known backend quirk found (not fixed, out of scope for this milestone): `transactions.py`'s `create_transaction` isn't atomic — an immediate refetch can transiently show `total_amount: 0` before the final UPDATE lands. Flagged for whoever revisits `transactions.py`.

## Phase 4 — Kitchen Display
- [x] Milestone 3 — done and verified live. `KitchenDisplay.tsx` built with the real 5 stations (Sushi Bar, Sushi Bar / Oven, Hot Line, Salad/Cold Bar, Cafe Bar) as a filter (Kanban columns are by `kitchen_status`, matching SMFC's layout). New `BundleFulfillmentChecklist.tsx` is a hard completion gate — a platter/boat ticket can't reach `completed` until it's submitted and matches `total_pieces` exactly. Sushi Boat checklist correctly excludes the two premium rolls, matched by their real catalog names **"Dragon Maki"** and **"Oishii Maki"** (not "Dragon Roll" — the earlier note above was shorthand). Backend gained one additive field: `GET /products` now returns `total_pieces` on a bundle's size (joined from `bundle_components`), so the checklist knows its target before submitting. Verified live via Playwright: full queued→preparing→ready→completed walk, bundle-gate enforcement, premium-roll exclusion, mismatched-total rejection, station filter correctness. Test transaction voided (correctly reversed the bundle-fulfillment ingredient deductions).

## Phase 5 — Inventory UI
- [x] Milestone 4 — done and verified live. `InventoryCount.tsx`, `InventoryMovements.tsx`, `LossLog.tsx` built and wired to the existing `inventory.py`/`inventory_movements.py`/`loss_records.py` endpoints. Cost-check nudge in `InventoryMovements.tsx` gates on the ingredient's live `cost_volatility_tier` field (`high`/`medium_high`) rather than a hardcoded name list — resolves to the same 6 ingredients (exact live names: Salmon, Scallop, **"Tuna (raw, spicy tuna mix)"**, **"Shrimp / Prawn (raw)"**, **"Angus beef (sliced)"**, Crushed pistachio) without one to keep in sync. Verified live: nudge fires only for volatile ingredients on a `delivery` movement, count variance math correct, `skip_stock_deduction` correctly avoids double-deduction. All test stock restored to baseline (0) afterward.
- [x] Utility Log — done and verified live. New `services/api-fastapi/app/routers/utility_logs.py` (mirrors `loss_records.py`'s shape) + `UtilityLog.tsx`. Verified an electricity reading round-trips with correct client-computed consumption/cost.

## Phase 6 — Integration & cross-agent QA
- [x] **Done and verified live 2026-08-21.** Full integrated order-lifecycle test run for real via Playwright against the actual UI: Medium Baked Kani Sushi + Small Sushi Boat rung up together via POS Terminal, recipe deduction confirmed on the scaled item, walked queued→preparing→ready on Kitchen Display, 34-piece rolls-used checklist logged (California Maki ×20, Crazy Maki ×14; Dragon Maki/Oishii Maki correctly excluded, confirmed via a targeted re-test that "Complete" is genuinely unclickable pre-fulfillment), reached `completed`, voided, ingredient stock direct-DB-verified deducted then fully restored. Catalog re-cross-check: 50 products / 60 product_sizes / 73 ingredients / 294 recipe_items / 5 bundle_components, all unchanged from the Phase 1 baseline. `bundle_components.notes` REVIEW text replaced on both Sushi Boat rows with the resolved "classic flavors excludes Dragon Maki/Oishii Maki" decision (direct Supabase `.update()`, user-authorized after the auto-mode classifier initially blocked it — see `SESSION_HANDOFF.md`).

## Phase 7 — HR/Payroll/Staff-Clock (in scope, backend done)
- [x] HR/Payroll/Staff-Clock scope confirmed in (see Phase 0) — schema exists (Phase 1), backend built (Phase 2, blocked on the `hr` schema-exposure step for live verification only, code is correct)
- [x] Milestone 5 — dashboard-web pages built and type-checked 2026-08-21: `HRAttendance.tsx` (attendance log table + per-log payroll-override request — correctly placed here rather than on the aggregated payroll-preview row, since overrides target one `attendance_log_id`), `HRPayroll.tsx` (preview/generate/history/overrides+audit tabs — the pending-overrides list is derived from the audit log since there's no dedicated list-pending endpoint), `HolidayCalendar.tsx`, `PayrollSettings.tsx` (ported from SMFC's shape, adapted off branch model). `Employees.tsx` and the Payroll Overrides+Audit viewer built **fresh** (SMFC's "Users" tab confirmed zero-API mocked state via direct grep). New additive backend endpoint `GET /employees` (nothing previously listed employees — only create/set-PIN existed). Staff Clock needed no further work (see Milestone 1 note above).
- [!] **Live verification still blocked**: the `hr` Postgres schema is still not exposed to PostgREST as of 2026-08-21 (re-tested twice this session with a real bearer token, ~20s apart — `GET /hr/holidays` still 500s while `GET /products`, a public-schema route, succeeds with the same token). Pages render correctly and fail gracefully with an error toast rather than crashing. Once the Supabase Dashboard toggle is confirmed flipped, re-run the full HR live pass: create employee → set PIN → clock in/out via staff-clock → generate payroll → submit/approve an override → CRUD a holiday.
- [ ] Multi-branch — **stays out of scope**, not confirmed needed by the client

---

## Before resuming: decisions the user still needs to make
1. ~~Keep or revert migration `0014`~~ — resolved 2026-08-21, kept.
2. ~~How much autonomy to grant subagents on live DB writes~~ — resolved 2026-08-21, check-in required.
3. ~~GitHub auth~~ — resolved 2026-08-21, user fixed it; repo pushed and all 3 apps deployed to Vercel same day.
4. Add `hr` to Supabase Dashboard → Settings → API → Exposed schemas — **still outstanding**. This is now the only remaining blocker in the whole project — it blocks Phase 7's HR live pass and full live verification of Phase 2's `hr.py`/`kiosk.py`.
