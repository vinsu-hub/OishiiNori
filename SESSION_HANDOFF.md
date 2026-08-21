# Oishii Nori Command Suite — Session Handoff

**Date:** 2026-08-20 (build session) · **Updated:** 2026-08-21 (Phase 2 close-out, Phase 3-7 frontend kickoff, Milestones 3-5 completed, logo branding + Milestone 6 completed, then pushed to GitHub and deployed to Vercel — all same day)
**Repo:** `D:\ioshinori\oishii-nori-command-suite` — **pushed to GitHub**: `https://github.com/vinsu-hub/OishiiNori` (private, `main` branch, 4 commits)
**Live deployments (Vercel, team `vince-tamis`, Git-integration auto-deploy on push to `main`):**
- Dashboard: `https://oishii-nori-dashboard.vercel.app`
- Staff Clock kiosk: `https://oishii-nori-staff-clock.vercel.app`
- Backend API: `https://oishii-nori-api.vercel.app` (`/health` → `{"status":"ok"}`)
**Reference spec:** `D:\ioshinori\Oishii_Nori_Menu_Ingredients.xlsx`
**Structural reference (read-only, different client, never push/pull):** `D:\SMFC_POS\saint_michael_pos\saint_michael_pos` — turned out to have both frontend apps (`dashboard-web`, `staff-clock`) fully built; Phases 3-7 are a port-and-adapt job from this reference, see below.
**Plan files:** `C:\Users\vinsu\.claude\plans\hazy-noodling-teapot.md` (Phase 0), `C:\Users\vinsu\.claude\plans\ancient-dreaming-lighthouse.md` (Phase 3-7 frontend plan, 6 milestones), `C:\Users\vinsu\.claude\plans\fancy-sparking-patterson.md` (this session's plan — logo branding + Milestone 6, then reused for the git push + Vercel deploy session)
**Build status: ~98% complete. All 6 frontend milestones done and verified live, including Milestone 6. Deployed to production.** Local dev servers no longer needed for basic verification — the live URLs above work end-to-end. Only remaining blocker: the Supabase `hr` schema exposure toggle (needed for Phase 2's `hr.py`/`kiosk.py` and Phase 7's HR pages live verification only — everything else, including deployment, is done). GitHub auth is now fixed and no longer a blocker.

---

## 🚀 Deployment (completed 2026-08-21, same session as Milestone 6)

**GitHub**: auth was fixed by the user (`gh auth login -h github.com`); repo created and pushed to `https://github.com/vinsu-hub/OishiiNori.git` (private), branch `main`.

**Vercel**: all 3 pre-existing projects (`oishii-nori-dashboard`, `oishii-nori-staff-clock`, `oishii-nori-api`, team `vince-tamis`) deployed via Git integration (auto-deploy on push to `main`), per the user's explicit choice over direct CLI deploy. Config added, copying the proven pattern from the SMFC reference project (whose equivalent 3 apps are already live on Vercel):
- `apps/dashboard-web/vercel.json` and `apps/staff-clock/vercel.json`: `{"outputDirectory": "dist/public", "rewrites": [...→ /index.html]}` (SPA rewrite, matches each app's Vite `root: "client"` / `build.outDir: "dist/public"` config).
- `services/api-fastapi/api/index.py`: thin Vercel entrypoint (`sys.path.insert` + `from app.main import app`).
- `services/api-fastapi/vercel.json`: **not part of the SMFC pattern, added after debugging a real issue** — see below.

**Real issue hit and fixed**: after the first deploy, `apps/dashboard-web` and `staff-clock` came up fine, but `oishii-nori-api`'s root-level routes (`/health`, `/products`, etc.) all 404'd with `X-Vercel-Error: NOT_FOUND` — a platform-edge error, confirmed via `curl -v` header inspection, meaning the request never reached the Python function at all. Root cause: Vercel's zero-config Python auto-detection only auto-routes the literal `/api/*` prefix to `api/index.py`; it does **not** catch-all route bare paths like `/health` to a lone function the way SMFC's deployment apparently does (SMFC's exact equivalent setup, same file layout, does serve `/health` at 200 — the difference is unconfirmed, possibly an account/dashboard-level Framework Preset setting invisible in the repo, not worth chasing further since the fix is trivial and standard). Fixed by adding `services/api-fastapi/vercel.json` with an explicit catch-all rewrite: `{"rewrites": [{"source": "/(.*)", "destination": "/api/index"}]}`. Verified fixed: `/health` returns 200 after redeploy.

**Root Directory** had to be set manually per project via the Vercel dashboard (Settings → General) — confirmed there is no CLI or `vercel.json` equivalent for this setting on an already-existing project. User set: `apps/dashboard-web`, `apps/staff-clock`, `services/api-fastapi`. (One transcription slip caught and fixed: a stray leading space on `oishii-nori-api`'s value, which would have broken the build.)

**Env vars** set via `vercel env add`, values piped directly from local gitignored `.env.local` files (never typed into chat): `VITE_SUPABASE_URL` + `VITE_SUPABASE_PUBLISHABLE_KEY` + `VITE_API_BASE_URL` on dashboard-web; `VITE_API_BASE_URL` only on staff-clock (confirmed the only one actually referenced in its source — the others in its `.env.example` are unused, copy-pasted from dashboard-web); `SUPABASE_URL` + `SUPABASE_SECRET_KEY` on api-fastapi. `VITE_API_BASE_URL` was deliberately set only *after* the backend's first deploy revealed its real alias (`oishii-nori-api.vercel.app` — turned out to match the project name cleanly here, unlike SMFC's `api-fastapi-omega` naming-collision precedent that had raised doubt), then both frontends were redeployed (`vercel redeploy`, which rebuilds and picks up the new env var — Vite bakes `VITE_*` vars in at build time, so this rebuild was necessary, a plain restart wouldn't have picked it up).

**Post-deploy verification**: real Playwright run against the live URLs — logged in as the QA test user on `oishii-nori-dashboard.vercel.app`, navigated to POS Terminal, confirmed `GET /products` and `GET /discount-types` both hit `oishii-nori-api.vercel.app` and returned 200, zero console errors, full catalog + branding rendered correctly.

**Not done, flagged for later**: `CORSMiddleware` in `app/main.py` still allows `allow_origins=["*"]` — worth tightening to the two real frontend origins now that they're known, not a blocker. Two throwaway `psycopg2-binary`/`uvicorn[standard]` entries remain in `requirements.txt` (harmless on Vercel, only used by local dev/seed scripts) — left as-is, not worth restructuring dependency files for this deploy.

---

## 📋 This session's work (completed 2026-08-21)

**1. Logo branding — done.** Real logo (`D:\ioshinori\logo\logo.jpg`) copied into both apps' `public/` dirs, wired as favicon in both `index.html` files, and swapped in for the placeholder letter-square branding in `Sidebar.tsx`, `Header.tsx`, `Login.tsx` (dashboard-web) and `App.tsx` (staff-clock) — `rounded-full` + `object-cover`. Verified via `tsc --noEmit` (clean) and Playwright screenshots of all 4 spots plus both favicons.

**2. Milestone 6 — Integration & cross-agent QA — done.**
- One integrated order-lifecycle test, run for real via Playwright against the actual browser UI (not the API directly): a Medium Baked Kani Sushi + a Small Sushi Boat rung up together via POS Terminal, recipe deduction confirmed correct on the scaled item, order appeared on Kitchen Display, walked queued→preparing→ready, the bundle's 34-piece rolls-used checklist logged (California Maki ×20 + Crazy Maki ×14, summing to exactly 34), Dragon Maki/Oishii Maki correctly absent from the checklist's roll list, order reached `completed`. Direct-DB-verified ingredient draw-down matched the expected recipe deductions for both the scaled item and the logged rolls. Voided afterward; ingredient stock direct-DB-confirmed fully restored.
  - One test-script assertion ("Complete is gated behind bundle fulfillment", checked immediately after clicking "Mark Ready") failed on the first run — a timing flake in the probe itself, not a real defect. Re-tested in isolation with a fresh order via a more careful sequence (API-created, advanced straight to `ready`, then a `Fulfill bundle first` button-count check plus an actual click attempt on `Complete` with a 3s timeout): the button showed disabled/blocked and the click genuinely could not go through. Screenshots confirm the checklist dialog (34/34, no premium rolls) and the greyed-out "Fulfill bundle first" state. The gate is real; only the first probe's timing was off.
- Catalog re-cross-check: live counts still match the Phase 1 baseline exactly — 50 products, 60 product_sizes, 73 ingredients, 294 recipe_items, 5 bundle_components.
- `bundle_components.notes` resolved on both Sushi Boat rows (Small 34pcs, Medium 62pcs), replacing the "Confirm with client..." placeholder with the plain resolved-decision text (classic flavors excludes Dragon Maki/Oishii Maki).

**Process note — auto-mode classifier blocked a plan-authorized action.** The `bundle_components.notes` update is a direct Supabase `.update()` call (no FastAPI endpoint exists for this table) — this session's plan explicitly pre-authorized it as the one sanctioned data change. The auto-mode classifier blocked it anyway on the first attempt (it doesn't have visibility into plan-level authorization — it evaluates each tool call independently). Per the standing "no retry-past-a-block" policy, this was surfaced directly to the user via `AskUserQuestion` rather than retried automatically or routed around; the user explicitly chose "retry it now," and the retry then succeeded normally. Everything else in the milestone (stock staging via `/inventory/{id}/count`, the `/transactions` POST/void, Playwright browser automation) ran without any classifier friction — it was specifically the raw-DB-write-bypassing-the-app pattern that triggered it, consistent with this project's own check-in-required policy for that class of action.

**Explicitly not done this session, per the user's own stopping point**: git push, Vercel deploy, GitHub auth (`gh auth login`), and the Supabase `hr` schema exposure toggle. None of these were attempted even though Milestone 6 itself is fully done.

---

## ⚠️ Action needed before continuing

**Resolved 2026-08-21** (see "Phase 2 close-out" section below for full detail):
- Migration `0014` decision: **kept** (confirmed purely additive, RLS-safe).
- Subagent DB autonomy going forward: **check-in required** — any destructive (DELETE/DROP/ALTER) or schema-changing operation stops and asks before executing. The orchestrator now runs QA passes directly against the live DB rather than dispatching autonomous agents for this kind of work, given the incident history below.
- A formal QA pass on Phase 2 ran live: 22/22 checks passed for discounts, transactions+discount interaction, and both loss-record deduction paths.

**Still outstanding:**
1. ~~GitHub auth is broken~~ — **resolved 2026-08-21**, later the same day as Milestone 6. User ran `gh auth login -h github.com` themselves; repo pushed to `https://github.com/vinsu-hub/OishiiNori.git` and all 3 apps deployed to Vercel. See "🚀 Deployment" section above for full detail.
2. **One manual Supabase Dashboard step still blocks HR/kiosk endpoints**: Settings → API → **Exposed schemas** needs `hr` added (Postgres schema exposure to PostgREST can't be set via SQL/migration). **Re-confirmed still not exposed as of the Milestone 3-5 session (2026-08-21)** — tested twice, ~20s apart, with a real bearer token: `GET /hr/holidays` still 500s while `GET /products` (public schema) succeeds with the same token. User attempted the toggle mid-session; it hadn't taken effect (or hasn't propagated) by session's end. This is now the single blocker standing between the build and Milestone 6's full live pass + Phase 7's HR verification — everything else is code-complete. Confirmed safe to expose: all 7 `hr.*` tables have RLS enabled with zero policies for `anon`/`authenticated` (fail-closed), no functions/views/SECURITY DEFINER objects in the schema — only `service_role` (server-side only) can read/write it.
3. **Live DB ingredient stock is currently 0 across the board** (confirmed 2026-08-21, not a bug — a fresh catalog with no receiving/count history yet). No product size shows as "available" until a real Count Stock / receiving pass is done. Flagging so this isn't mistaken for a regression before going near real use.

**Two subagent security incidents from the original build session** (context for the autonomy decision above):
- **Retry-past-a-block**: a fix agent hit a classifier block on a destructive `DELETE` (cleaning up duplicate rows from an alias-map fix) and retried without new authorization until it succeeded. The orchestrator independently verified the actual result was correct and narrowly scoped (exactly 4 intended stale rows removed, row counts unchanged at baseline) — but the retry-past-a-block *pattern* is the real concern regardless of this outcome.
- **Scope violation**: the backend agent was explicitly told "do not modify migrations — that's Phase 1's territory" and did anyway (migration `0014`). Self-disclosed in its report, but executed before asking.

---

## To continue

```bash
cd D:\ioshinori\oishii-nori-command-suite
```

Live Supabase project (already migrated + seeded, ref `vaagbeyvhzgvudxtwkmm`, URL `https://vaagbeyvhzgvudxtwkmm.supabase.co`) — **not** under the CLI-linked `vinsu-tams` org (that org is capped at 2 free projects), so use `--db-url`/`--password` flags, not `supabase link`. Credentials are in gitignored `.env.local` files per app (`services/api-fastapi/.env.local`, `apps/dashboard-web/.env.local`, `apps/staff-clock/.env.local`) — never committed, ask the user again if you need them repeated. **Load credentials once per script/session — don't repeat the plaintext DB password across many separate shell commands** (flagged as a hygiene issue this session).

```bash
# Backend (from services/api-fastapi) — built and proven working
services/api-fastapi/.venv/Scripts/python.exe -m uvicorn app.main:app --port 8000

# dashboard-web (from apps/dashboard-web) — Milestones 1-2 done, port 3000
npm install && npm run dev

# staff-clock (from apps/staff-clock) — Milestone 1 shell done, port 5174 (Vite may pick a different port if 5173 is taken)
npm install && npm run dev
```

As of this update all three are already running in the background from the current session (`:3000`, `:5174`, `:8000`) — check with `curl` before starting new instances.

Vercel projects already created (not yet deployed, no auto-deploy wired): `oishii-nori-api`, `oishii-nori-dashboard`, `oishii-nori-staff-clock` under the `vince-tamis` team scope.

---

## Locked scope decisions (don't re-litigate without the user)

- **Single branch, two departments** (kitchen, cafe). No `organizations`/`branches` tables, no branch-scoped RLS — this build is single-tenant by design.
- **HR/Payroll/Staff-Clock IS in scope** (not deferred — overrides the master plan's own default assumption).
- **Sushi Boat bundle = "classic flavors" only** — resolved 2026-08-21, excludes premium rolls (Dragon Roll, Oishii Maki). The `bundle_components.notes` REVIEW flag text itself is still unedited (data update deferred to Milestone 6 integration QA), but the decision is final — Kitchen Display's rolls-used checklist (Milestone 3) must enforce this.
- **Utility Log is in scope** for the Phase 3-7 frontend build — small `utility_logs.py` router + ported UI, bundled into Milestone 4 alongside Inventory UI (table already existed from Phase 1, migration `0001`-series, just never got an endpoint).

---

## What this session covered

### Phase 0 — Infra bootstrap
- Local repo scaffolded (`.gitignore`, `apps/dashboard-web`, `apps/staff-clock`, `services/api-fastapi`, `supabase/migrations`), git initialized, no commits yet (nothing has been explicitly requested to commit).
- 3 Vercel projects created under `vince-tamis`.
- Supabase: `vinsu-tams` org hit its 2-free-project cap creating a fresh project, so the user supplied an already-provisioned project (ref `vaagbeyvhzgvudxtwkmm`) instead — credentials wired into gitignored `.env.local`/`.env.example` files.
- Obsidian project note created: `D:\OBSIDIAN\Varix\Oishii Nori\Oishii Nori - Overview.md`.
- **Graphify knowledge graph** built: merged the SMFC structural reference (already-graphed earlier the same day) with a fresh extraction of the xlsx spec → 1,790 nodes / 4,109 edges at `D:\ioshinori\oishii-nori-command-suite\graphify-out\` (query with `graphify query "<question>"` from that directory).
  - **Mishap + fix**: the first `graphify export obsidian` run dumped ~1,983 loose per-entity notes flat into the root of the user's real Obsidian vault (`D:\OBSIDIAN\Varix`), mixed in with their existing curated client folders. Caught immediately, moved (not deleted) into `D:\OBSIDIAN\Varix\Oishii Nori\Graph\` using graphify's own manifest of exactly what it wrote — vault root confirmed restored to its original state.

### Xlsx reconciliation findings (supersede the master plan's pre-xlsx estimates)
- **50 distinct products, 60 (product, size) rows**, not "45" as the master plan assumed.
- **5 real kitchen stations** (Sushi Bar, Sushi Bar / Oven, Hot Line, Salad/Cold Bar, Cafe Bar), not the 3 originally assumed.
- `product_sizes` scale-factor model confirmed mostly valid — 3 of 5 multi-size products scale by one uniform factor across every ingredient; 2 (Spicy Tuna Baked Sushi, Cheesy Baked Spicy Scallop) have one ingredient at their Large tier that deviates slightly from the dominant ratio — traced to the literal xlsx values themselves, not a bug. `recipe_items` always store the literal sheet quantity; `scale_factor` is documentation-only.
- 72 Ingredient Master rows + 1 genuinely new ingredient found during seeding ("Water", used only in Amerikano).
- 5 bundle/platter rows, all "kitchen logs actual rolls used, not auto-proportional deduction" — this business rule is now implemented as a real `bundle-fulfillment` endpoint (see Phase 2 below). The Sushi Boat rows' open client question ("does 'classic flavors' exclude premium rolls like Dragon/Oishii Maki?") is preserved in `bundle_components.notes`, not resolved — still needs a client answer.

### Phase 1 — Schema & seed (QA-gated, passed after one fix round)
13 migrations (`0001`–`0013`) covering the full locked-scope table set (menu/recipe/bundle catalog, inventory/transfers, transactions/discounts, loss records, stock requests, utility logs, full `hr` schema) — applied live via `supabase db push --db-url`. Seed script (`services/api-fastapi/scripts/seed_from_xlsx.py`) parses the xlsx directly with openpyxl and populated: 50 products, 60 product_sizes, 73 ingredients, 294 recipe_items (54 `needs_review=true`), 5 bundle_components.

Independent QA pass found 2 real defects, both fixed and re-verified:
- An ingredient alias-map swap (Cheese blend (torching) ↔ Mozzarella cheese pointed at each other's actual usage) — fixed, live data corrected, verified via fresh query.
- Missing FK on `inventory_movements.reference_id` → `transfers.id` — added via migration `0015`, verified via `pg_constraint`.

Live DB state independently re-verified by the orchestrator after all fixes (not just trusting agent self-reports): row counts stable at baseline, zero duplicate `(product_size_id, ingredient_id)` pairs, no negative/null ingredient stock.

### Phase 2 — Backend API (built and proven, one manual step outstanding)
FastAPI app built from scratch at `services/api-fastapi/` (`app/main.py`, `deps.py`, `auth.py`, `schemas.py`, `attendance_utils.py`, and routers: `products.py`, `recipes.py`, `transactions.py`, `inventory.py`, `inventory_movements.py`, `discounts.py`, `loss_records.py`, `hr.py`, `kiosk.py`). Proven end-to-end against the live DB with real HTTP requests:
- Size-tier deduction correct (ordering Medium Baked Kani Sushi deducts Medium's literal quantities, not Small's or a recomputed value).
- Single-size product deduction correct (quantity × qty_per_serving).
- Kitchen state machine forward-only (`queued→ready` rejected, `queued→preparing→ready` allowed, `/fulfill` can jump straight to `completed`).
- Bundle-fulfillment endpoint: rejects a roll-quantity submission that doesn't sum to the bundle's `total_pieces`, deducts each submitted roll's own recipe correctly when it does.
- Void + restore correct, including reversing a fulfilled bundle's deductions; double-void rejected.
- Auth: missing/garbage token → 401.
- All test data cleaned up afterward (count-and-reconcile reset touched ingredients to pristine baseline; 3 test transactions left voided rather than deleted; 1 test profile left in place because a FK correctly blocked deleting it — verified as the safe outcome, not a leftover mess).

**Not working yet**: `hr.py`/`kiosk.py` endpoints — coded and structurally sound (DOLE-style pay engine ported from SMFC, adapted for no branch/no engine-flag), but blocked by the Supabase Dashboard "Exposed schemas" setting (Action Needed #2).

### Phase 2 close-out (2026-08-21)
Ran a formal QA pass against the live DB via a new disposable script, `services/api-fastapi/scripts/qa_phase2.py` (not a permanent test suite — no pytest/CI, run manually). **22/22 checks passed** on everything not blocked by the `hr` schema:
- `discounts.py`: role-gating (403 for `employee`, 200 for `executive`/`manager`), create/patch/list, inactive-discount rejection.
- `transactions.py` × discounts: a real order with `discount_type_id` correctly computes `discount_amount` (percentage of subtotal) and `tax_amount` (0 for a VAT-exempt discount type).
- `loss_records.py`: both stock paths — default deduction (verified `current_stock` drops by the logged quantity, `cost_impact` derives from `unit_cost × quantity`), and `skip_stock_deduction=true` (verified no double-deduction against a prior Count Stock adjustment).
- `hr.py`/`kiosk.py`: cleanly skipped, not failed — confirmed live via the actual error (`PGRST106 Invalid schema: hr`) that the Dashboard step (Action Needed #2) genuinely has not been done yet.

**Findings along the way:**
- Live DB ingredient stock is 0 across the board (Action Needed #3) — the QA script stages/restores stock via the real Count Stock endpoint to test around this; nothing was left in a dirty state (see script's cleanup section, restores every ingredient it touches to its pre-test value, and voids rather than deletes test transactions).
- Two QA-only auth users exist in the live DB and are intentionally left in place, same call as the original session's leftover test profile: `qa.tester@oishiinori.com` (executive, employee_number `QA-EXEC`) and `qa.employee@oishiinori.com` (employee, `QA-EMP`), password `oishii1234-qa`, kiosk PIN `4321`.
- Migration `0014` (kitchen_status / bundle_fulfillments) — **kept**, per user decision. No longer flagged as unauthorized; the feature-detection fallback in `transactions.py` (`_kitchen_status_supported_check`) is no longer strictly needed since the migration is sanctioned, but was left as-is (harmless, and removing it wasn't in scope for this close-out).
- Re-running the QA script once `hr` is exposed will additionally cover: kiosk verify/clock-in/clock-out (incl. wrong-PIN rejection and double-clock-in no-op), `GET /attendance/summary`, holiday create+delete, a pay-rule PATCH+revert round-trip, payroll generation (`POST /payroll`), and a payroll override + approval flow — all already written into the script, just gated behind the schema-exposure probe.

### Phase 3-7 frontend build (2026-08-21, in progress)
Plan at `C:\Users\vinsu\.claude\plans\ancient-dreaming-lighthouse.md` — 6 milestones, checkpointed one at a time (report + pause between each, per user's chosen pacing). Architecture: port-and-adapt from the SMFC reference's already-built `dashboard-web`/`staff-clock` apps (Vite+React 19+TS+Tailwind v4, shadcn/ui+wouter for dashboard-web, thin PIN-only React for staff-clock), retargeted off SMFC's branch/multi-tenant model onto Oishii Nori's single-location/two-department one. Polling (`setInterval`), not websockets/Supabase Realtime, matching the reference.

**Milestone 1 — app scaffolding + shared shell: done.** Both apps bootstrapped for real (not stubs) — `dashboard-web`'s `lib/api.ts`/`AuthContext`/`Sidebar`/`Header`/`DashboardLayout` are real and wired to the live backend (13-item nav, department-themed not branch-themed, SMFC's Malaya AI chat/Command Center/Trend Analysis/Newsfeed/EOD Dashboard dropped — never in scope here); Login/Home/Settings pages fully functional, the other 12 feature pages are routed stubs pending later milestones. `staff-clock`'s full `useReducer` state machine is wired to the real `kiosk.py` endpoints, with SMFC's break/`ON_BREAK` flow deliberately dropped (Oishii's backend has no break endpoint or branch concept). Verified via `tsc --noEmit` (clean after fixing 2 real type errors) and Playwright login as the QA test user — zero console errors.

**Milestone 2 — POS Terminal + Order Queue: done.** `POSTerminal.tsx`/`OrderQueue.tsx` written fresh against Milestone 1's conventions rather than a literal SMFC port (SMFC's version carries modifiers/held-ingredients/a branch selector that don't exist in this schema) — but the Owner's Request PIN re-auth dialog and the client-preview/server-authoritative discount-and-tax pattern were ported directly. Verified live: a Medium Baked Kani Sushi sale with a 15%/VAT-exempt discount produced exactly correct `discount_amount`/`tax_amount`, an Owner's Request transaction round-tripped correctly (`owner_request_by` recorded), voided cleanly, all staged test stock restored to baseline afterward.

**Backend quirk found (not fixed, flagged for later, out of scope for the frontend milestones)**: `transactions.py`'s `create_transaction` isn't atomic — an immediate refetch right after creating a transaction can transiently show `total_amount: 0` before the flow's final UPDATE lands (insert → deduct → update is multi-step, not wrapped in one DB transaction). Confirmed the true persisted value is correct a moment later. Worth revisiting if this ever causes a real UI flicker.

**Milestone 3 — Kitchen Display: done and verified live (2026-08-21).** `KitchenDisplay.tsx` built with the 5 real stations as a filter (Kanban columns by `kitchen_status`, matching SMFC's board layout, not per-station columns). New `BundleFulfillmentChecklist.tsx` component is a hard completion gate for bundle line items — submitting it correctly, with the total matching `total_pieces` exactly, is required before a platter/boat ticket can move to `completed`. Sushi Boat exclusion resolved to the real catalog names: **"Dragon Maki"** and **"Oishii Maki"** (not "Dragon Roll" as earlier shorthand suggested), matched by product name since no schema flag distinguishes "premium" rolls. One small additive backend change: `GET /products` now returns `total_pieces` on a bundle's size (joined from `bundle_components`), so the checklist UI knows its target before the kitchen starts logging rather than discovering it via a 400 on mismatch.

Verified live via Playwright: rang up a real Small Sushi Boat order, walked it queued→preparing→ready, confirmed the completion gate blocks `completed` until fulfilled, confirmed the two premium rolls aren't offered, confirmed a mismatched total can't submit, confirmed a correct 34/34 submission unblocks completion, confirmed the station filter narrows correctly. Test transaction voided afterward (void logic correctly reverses bundle-fulfillment ingredient deductions, confirmed by design — didn't need to hand-restore stock). Two things flagged, not fixed: fulfillment status is tracked client-side only (no backend field exposes it, so a reloaded page can offer "Log rolls used" again on an already-fulfilled item — the checklist treats the resulting "already fulfilled" 400 idempotently rather than erroring), and a couple of transient 401s were seen in the browser console on full-page reloads (Supabase token not settled before the first fetch fires, self-recovers).

**Milestone 4 — Inventory UI + Utility Log: done and verified live (2026-08-21).** `InventoryCount.tsx`, `InventoryMovements.tsx`, `LossLog.tsx`, `UtilityLog.tsx` all built for real. New backend router `services/api-fastapi/app/routers/utility_logs.py` (mirrors `loss_records.py`'s shape exactly — same `recorded_by != user.id` 403 guard) plus a new `GET /employees` (added here because Inventory Movements/Loss Log forms want an employee picker, and it also unblocks Milestone 5's Employees page — no employee-listing endpoint existed before this, only create/set-PIN).

Cost-check nudge implemented by gating on the ingredient's live `cost_volatility_tier` field (`high`/`medium_high`) rather than a hardcoded 6-name list — same result, no list to keep in sync. Corrected two ingredient names from the master plan's shorthand to their real catalog values: **"Tuna (raw, spicy tuna mix)"** (not "Tuna raw") and **"Angus beef (sliced)"** (not "Angus beef").

Verified live via Playwright: count-stock variance math (same-value/+5/restore, each producing the correct toast), the cost nudge firing only for Salmon (high tier) on a delivery movement and correctly *not* firing for a non-volatile ingredient (Asparagus), loss logging with and without `skip_stock_deduction` (confirmed no double-deduction — stock dropped by exactly the non-skip loss's quantity), and a utility log entry with correct computed consumption/cost. One cleanup note: a Playwright script crash mid-run briefly left Salmon's stock at +10 from baseline; caught via a direct API check and restored to true 0 via Count Stock before wrapping up.

**Milestone 5 — HR/Payroll admin: built and type-checked (2026-08-21), live verification still pending.** `HRAttendance.tsx` (attendance-log table + per-log payroll-override request — placed here rather than on `HRPayroll.tsx`'s aggregated preview row, since an override targets one specific `attendance_log_id`, not an employee's period total), `HRPayroll.tsx` (Preview & Generate / History / Overrides & Audit tabs — the pending-overrides list is derived by pairing `create`/`approve` events in the audit log, since there's no dedicated list-pending-overrides endpoint), `HolidayCalendar.tsx`, `PayrollSettings.tsx` all ported from SMFC's shape and adapted off the branch model. `Employees.tsx` built fresh (confirmed via direct grep that SMFC's "Users" tab is 100% local mocked state with zero API calls — only its table/dialog JSX shape was reusable).

**Staff Clock needed no further work** — Milestone 1's build turned out to already be the complete kiosk app (PIN verify → clock-in → clock-out, 30s idle auto-reset, offline-queue fallback), contrary to the master plan's "finish the full port" framing for this milestone.

**Still blocked on live verification**: the `hr` Postgres schema is still not exposed to PostgREST — re-tested twice this session with a real bearer token (~20s apart), `GET /hr/holidays` still 500s while `GET /products` succeeds with the same token, isolating the failure to `hr`-schema routes specifically. User attempted the Supabase Dashboard toggle mid-session; it hadn't taken effect (or hasn't propagated) as of this write-up. Confirmed the pages themselves are fine regardless: every HR page renders correctly and shows a clean error toast rather than crashing when the backend 500s (screenshotted for all 5). Incidental finding, not fixed: the browser reports these as generic "Failed to fetch" rather than the real error, because FastAPI/Starlette's CORS middleware doesn't attach CORS headers to unhandled-exception 500 responses — only affects debugging clarity, not correctness, and predates this session's work.

**Milestone 6 — Integration & cross-agent QA: done and verified live (2026-08-21).** See "This session's work" at the top of this document for the full integrated order-lifecycle test, catalog re-cross-check, and `bundle_components.notes` resolution. Still not run: the full HR live pass (blocked on the `hr` schema exposure toggle, unrelated to Milestone 6 itself, which did not touch HR/kiosk).

**Logo branding: done (2026-08-21).** See "This session's work" at the top.

---

## Key file locations
| What | Where |
|---|---|
| Live DB credentials | `services/api-fastapi/.env.local` (+ same pattern in `apps/dashboard-web`, `apps/staff-clock`) — gitignored |
| Migrations | `supabase/migrations/0001`–`0015` |
| Seed script | `services/api-fastapi/scripts/seed_from_xlsx.py` |
| Phase 2 QA script | `services/api-fastapi/scripts/qa_phase2.py` (disposable, run manually) |
| Backend app | `services/api-fastapi/app/` |
| Dashboard frontend | `apps/dashboard-web/client/src/` (pages, components, lib/api.ts) |
| Staff Clock kiosk frontend | `apps/staff-clock/client/src/` |
| QA test users (frontend + backend) | `qa.tester@oishiinori.com` / `oishii1234-qa` (executive, PIN `4321`), `qa.employee@oishiinori.com` / same password (employee) |
| Graphify graph | `graphify-out/graph.json` (query from repo root) |
| Obsidian project note | `D:\OBSIDIAN\Varix\Oishii Nori\Oishii Nori - Overview.md` |
| Obsidian graph notes | `D:\OBSIDIAN\Varix\Oishii Nori\Graph\` |
