# Oishii Nori Command Suite — Progress / Task Board

Status as of 2026-08-22 (this update covers everything since the last doc sync: menu photos, the 11-milestone order-lifecycle/executive-tier overhaul, a 5-milestone bugfix pass, payroll demo data + system health check, the Generate Payroll bugfix + SMFC-parity payroll UX + PDF payslips + Oishii AI launch, the Inventory Count rebuild + sortable columns, Oishii AI's full-business data expansion, shipment-receiving reactivation + unit cost/expiry tracking, and switching Oishii AI from xAI to Groq + fixing a real rate-limit bug this surfaced). All 4 apps remain live in production. Update this file as work advances.

**Overall: functionally complete, everything verified live, no open items.** The two blockers documented across this project's history are both resolved: the Supabase `hr` schema not being exposed to PostgREST (confirmed repeatedly this session — `GET /hr/holidays`, `/attendance`, `/payroll`, `/employees` all live; a 71/71-check system health script passes against both dev and prod), and Oishii AI's LLM provider having no working billing (switched from an unbilled xAI account to Groq's free tier, then fixed a real rate-limit issue the switch surfaced — the full context payload exceeded Groq's per-organization TPM cap). HR/Payroll is fully live: real generated payroll runs, real PDF payslips, real demo data (6 employees across two periods). Oishii AI is fully live: verified with real questions (revenue, best seller, loss drivers, an individual employee's pay rate, ingredient stock) through both the API and the actual chat UI on production, all answers correct against live data.

Live URLs: dashboard `https://oishii-nori-dashboard.vercel.app`, staff clock `https://oishii-nori-staff-clock.vercel.app`, API `https://oishii-nori-api.vercel.app`, customer menu `https://oishii-nori-menu.vercel.app`.

---

## Latest work blocks (newest first — see `SESSION_HANDOFF.md` for full detail on each)

1. **Oishii AI: switched xAI → Groq, fixed a real rate-limit bug** — the configured xAI account had no billing (a second key from the same team hit the identical wall); switched to Groq (free, no card required, OpenAI-compatible so the swap was small). That surfaced a real issue: the full context payload (~9,200 tokens) exceeded Groq's free-tier 8000 TPM cap, which turned out to be per-organization across all models, not per-model. Fixed by trimming the biggest offender (`all_ingredients`, previously over half the payload) from 6 fields to 3, and reducing two other list limits. Verified fully live: 5+ real questions answered correctly through both the API directly and the actual chat UI on production.
2. **Shipment receiving reactivated + unit cost + expiry tracking** — `InventoryMovements.tsx` had no Sidebar link (delisted mid-consolidation, never relinked); re-added as "Receive Shipment", rebuilt as a 3-tab page with a new batch-entry receiving form. `ingredients.unit_cost` (migration `0021`) now auto-populates from delivery cost snapshots, backfilled historically, and loss records fall back to it when no cost is supplied. Advisory expiry tracking added (`GET /inventory/expiring-soon`, a new "Expiring Soon" card on Inventory Count). Verified live end-to-end on production (stock, unit_cost, and expiry all correctly updated via a real UI submission).
3. **Oishii AI: full-business data context** — expanded from 7 to 13 context sections (employee roster + pay rates, payroll history, full inventory, recent movements, 30-day top products, revenue totals, discounts, digital-order counts, utility costs), each documented in the system prompt's field guide. All 13 sections verified returning real data (this is the payload that item 1 above later had to trim to fit Groq's rate limit).
4. **Inventory Count rebuild** — one-at-a-time count dialog replaced with a live batch count-sheet (SMFC structure, adapted), summary cards, a post-save shrinkage-to-loss-record flow, and sortable columns (Item/Category/Expected/Variance/Status, live-value-aware). No backend changes needed for the rebuild itself.
5. **Payroll: Generate bugfix + SMFC-parity UX + PDF payslips + Oishii AI launch** — root-caused and fixed "Generate Payroll does nothing" (Preview tab never refreshed after Generate; an empty period rendered with no explanation). Layered on summary cards, a per-employee drawer, real PDF payslips (single + bulk ZIP, reportlab), and launched Oishii AI (originally on xAI Grok, modeled on SMFC's Malaya AI — see item 1 for the later Groq switch). Payroll demo data seeded (6 employees, 2 real generated periods) and a 71/71-check system health script added.
6. **Order-lifecycle cross-compare + executive-tier overhaul** — 11 milestones cross-comparing POS Terminal/Order Queue/Kitchen Display/Pending Orders against SMFC, plus reopening the executive tier (Command Center, Trend Analysis, POS Management) previously deferred as out of scope. Includes: uniform held-ingredients tracking across POS and QR-order origins, backend-persisted bundle-fulfillment status, Held Orders/Favorites/upsell rail on POS Terminal, richer Order Queue filtering, Kitchen Display stat cards, sound alerts.
7. **Code review + 5-milestone bugfix pass** — an `xhigh` review of the above found 15 findings, all fixed and verified live: a migration guard, a real Escape-key-wipes-cart bug (needed a second fix attempt — Radix's own capture-phase listener beat a naive bubble-phase guard), a UTC-vs-PH-timezone bug present in 3 separate places fixed once and shared, several POS Terminal cart-integrity fixes, an Order Queue pagination-clamp fix, and 3 backend correctness/defensive-limit fixes.

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
| 10 — Oishii AI (business analyst chatbot) | **Done, fully live** — switched to Groq after the xAI account's billing gap, rate-limit issue fixed, verified via real chat UI queries |

Legend: `[x]` done & QA-passed · `[~]` in progress / partially done · `[ ]` not started · `[!]` blocked

---

## Outstanding items

No blockers remain. Everything below is minor and non-blocking:

1. **Local dev port 8000 has an orphaned, unkillable process** on the user's machine (worked around this session by moving the local dev backend to port 8010 — `apps/dashboard-web/.env.local` already points there). A reboot would likely reclaim 8000 if wanted.
2. Documented-but-not-built inventory backlog (purely a future-improvements list from this session's brainstorm): supplier/vendor tracking, purchase orders with expected-vs-received reconciliation, ingredient usage-trend analytics, real food-cost-% rollup per recipe (now unlocked in principle since `unit_cost` exists), low-stock notification/digest, and wiring the now-available `unit_cost` data into Inventory Count's summary cards / Oishii AI's inventory context (both were deliberately left as-is when `unit_cost` didn't exist yet).
3. Minor, long-flagged items: `CORSMiddleware` still allows `allow_origins=["*"]`; two unused dependency entries in `requirements.txt`.
4. Groq's free tier has real rate limits (8000 TPM per-organization, across all models) — Oishii AI's payload was trimmed to fit comfortably under this, but if the business grows enough that the context payload grows significantly again (many more ingredients/employees/history), this may need revisiting (either trim further or move to a paid Groq tier).

Full technical detail on every item above lives in `SESSION_HANDOFF.md`.
