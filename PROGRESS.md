# Oishii Nori Command Suite — Progress / Task Board

Status as of 2026-08-22 (this update covers everything since the last doc sync: menu photos, the 11-milestone order-lifecycle/executive-tier overhaul, a 5-milestone bugfix pass, payroll demo data + system health check, the Generate Payroll bugfix + SMFC-parity payroll UX + PDF payslips + Oishii AI launch, the Inventory Count rebuild + sortable columns, Oishii AI's full-business data expansion, and shipment-receiving reactivation + unit cost/expiry tracking). All 4 apps remain live in production. Update this file as work advances.

**Overall: functionally complete, in active refinement.** The one long-standing blocker documented across this project's history — the Supabase `hr` schema not being exposed to PostgREST — **is resolved**, confirmed repeatedly this session (`GET /hr/holidays`, `/attendance`, `/payroll`, `/employees` all live and working; a 71/71-check system health script passes against both dev and prod). HR/Payroll is fully live: real generated payroll runs, real PDF payslips, real demo data (6 employees across two periods). The **only open item is external**: the xAI API key for Oishii AI has no billing/credits yet (`console.x.ai`) — the entire request pipeline up to that call is verified correct.

Live URLs: dashboard `https://oishii-nori-dashboard.vercel.app`, staff clock `https://oishii-nori-staff-clock.vercel.app`, API `https://oishii-nori-api.vercel.app`, customer menu `https://oishii-nori-menu.vercel.app`.

---

## Latest work blocks (newest first — see `SESSION_HANDOFF.md` for full detail on each)

1. **Shipment receiving reactivated + unit cost + expiry tracking** — `InventoryMovements.tsx` had no Sidebar link (delisted mid-consolidation, never relinked); re-added as "Receive Shipment", rebuilt as a 3-tab page with a new batch-entry receiving form. `ingredients.unit_cost` (migration `0021`) now auto-populates from delivery cost snapshots, backfilled historically, and loss records fall back to it when no cost is supplied. Advisory expiry tracking added (`GET /inventory/expiring-soon`, a new "Expiring Soon" card on Inventory Count). Verified live end-to-end on production (stock, unit_cost, and expiry all correctly updated via a real UI submission).
2. **Oishii AI: full-business data context** — expanded from 7 to 13 context sections (employee roster + pay rates, payroll history, full inventory, recent movements, 30-day top products, revenue totals, discounts, digital-order counts, utility costs), each documented in the system prompt's field guide. All 13 sections verified returning real data; the LLM call itself is blocked only on xAI billing (external, not a code issue).
3. **Inventory Count rebuild** — one-at-a-time count dialog replaced with a live batch count-sheet (SMFC structure, adapted), summary cards, a post-save shrinkage-to-loss-record flow, and sortable columns (Item/Category/Expected/Variance/Status, live-value-aware). No backend changes needed for the rebuild itself.
4. **Payroll: Generate bugfix + SMFC-parity UX + PDF payslips + Oishii AI launch** — root-caused and fixed "Generate Payroll does nothing" (Preview tab never refreshed after Generate; an empty period rendered with no explanation). Layered on summary cards, a per-employee drawer, real PDF payslips (single + bulk ZIP, reportlab), and launched Oishii AI (xAI Grok, modeled on SMFC's Malaya AI). Payroll demo data seeded (6 employees, 2 real generated periods) and a 71/71-check system health script added.
5. **Order-lifecycle cross-compare + executive-tier overhaul** — 11 milestones cross-comparing POS Terminal/Order Queue/Kitchen Display/Pending Orders against SMFC, plus reopening the executive tier (Command Center, Trend Analysis, POS Management) previously deferred as out of scope. Includes: uniform held-ingredients tracking across POS and QR-order origins, backend-persisted bundle-fulfillment status, Held Orders/Favorites/upsell rail on POS Terminal, richer Order Queue filtering, Kitchen Display stat cards, sound alerts.
6. **Code review + 5-milestone bugfix pass** — an `xhigh` review of the above found 15 findings, all fixed and verified live: a migration guard, a real Escape-key-wipes-cart bug (needed a second fix attempt — Radix's own capture-phase listener beat a naive bubble-phase guard), a UTC-vs-PH-timezone bug present in 3 separate places fixed once and shared, several POS Terminal cart-integrity fixes, an Order Queue pagination-clamp fix, and 3 backend correctness/defensive-limit fixes.

---

## Phase table

| Phase | Status |
|---|---|
| 0 — Infra bootstrap | Done — all 4 apps deployed to Vercel |
| 1 — Schema & seed | Done — 21 migrations applied live |
| 2 — Backend API | **Done, fully live** — `hr`/`kiosk` schema exposure blocker resolved |
| 3 — POS Terminal + Order Queue | Done, richly extended (11-milestone cross-compare pass, Held Orders/Favorites/upsell/filtering/sound alerts) |
| 4 — Kitchen Display | Done, extended (stat cards, delayed thresholds, sound alerts, backend-persisted bundle-fulfillment) |
| 5 — Inventory UI + Utility Log | Done, rebuilt (batch count-sheet, sortable columns, unit cost tracking, expiry tracking, shipment receiving reactivated) |
| 6 — Integration & cross-agent QA | Done, verified live |
| 7 — HR/Payroll/Staff-Clock | **Done, fully live** — real payroll generation, PDF payslips, demo data, 71/71 health check |
| 8 — Executive tier (Command Center, Trend Analysis, POS Management) | **Done, live** — reversal of the original "out of scope" call, built and verified this session |
| 9 — Digital menu (QR ordering) | Done, live — redesigned visually, add-ons/holds, product photos |
| 10 — Oishii AI (business analyst chatbot) | **Data pipeline done and verified; LLM call blocked on external xAI billing only** |

Legend: `[x]` done & QA-passed · `[~]` in progress / partially done · `[ ]` not started · `[!]` blocked

---

## Outstanding items

1. **xAI billing** (external, user action only) — add credits/a plan at `console.x.ai` for the account behind `XAI_API_KEY`. No code changes needed once resolved; the key is already configured everywhere (local `.env.local` + Vercel Production/Preview for `oishii-nori-api`).
2. **Local dev port 8000 has an orphaned, unkillable process** on the user's machine (worked around this session by moving the local dev backend to port 8010 — `apps/dashboard-web/.env.local` already points there). A reboot would likely reclaim 8000 if wanted.
3. Documented-but-not-built inventory backlog (not blocking anything, purely a future-improvements list from this session's brainstorm): supplier/vendor tracking, purchase orders with expected-vs-received reconciliation, ingredient usage-trend analytics, real food-cost-% rollup per recipe (now unlocked in principle since `unit_cost` exists), low-stock notification/digest, and wiring the now-available `unit_cost` data into Inventory Count's summary cards / Oishii AI's inventory context (both were deliberately left as-is when `unit_cost` didn't exist yet).
4. Minor, non-blocking, long-flagged items: `CORSMiddleware` still allows `allow_origins=["*"]`; two unused dependency entries in `requirements.txt`.

Full technical detail on every item above lives in `SESSION_HANDOFF.md`.
