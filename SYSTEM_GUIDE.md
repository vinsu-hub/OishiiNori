# Oishii Nori Command Suite — Full System Guide

**Audience:** anyone who needs a top-to-bottom map of the system — new staff, the client, or a developer picking this up cold.
**Scope:** every app, every page, every role, and how to actually use each one. For chronological build history see `SESSION_HANDOFF.md`/`PROGRESS.md`; for inventory-specific depth see `INVENTORY_SYSTEM_GUIDE.md`.
**Status:** functionally complete, all 4 apps live in production (see [Deployment & local dev](#6-deployment--local-dev) for URLs).

---

## 1. Overview

Oishii Nori Command Suite is the full digital operations system for a single-location sushi/ramen restaurant (kitchen + cafe departments). It replaces paper-based ordering, inventory counting, and payroll with four connected web apps sharing one backend and one database.

**The four apps:**
- **Dashboard / Command Suite** (`dashboard-web`) — the internal app staff/managers/executives log into: POS, kitchen display, inventory, HR/payroll, executive analytics, AI assistant. This is "the command suite" referenced throughout this doc.
- **Staff Clock** (`staff-clock`) — a shared kiosk device for PIN-based clock-in/clock-out.
- **Customer Menu** (`customer-menu`) — a QR-code table-ordering menu customers use on their own phones, no login.
- **Backend API** (`api-fastapi`) — one FastAPI service all three frontends talk to.

**Tech stack:** React 19 + Vite + TypeScript + Tailwind + shadcn/ui on the frontend (wouter for routing on dashboard-web; staff-clock and customer-menu are single-screen state machines with no router). FastAPI + Supabase/Postgres on the backend. All 4 apps deploy to Vercel automatically on push to `main`. No websockets — everything that needs to feel "live" polls on an interval by design.

**Roles:** every staff account has exactly one role — `employee`, `manager`, or `executive` — stored in the `profiles` table and checked on login. There's no branch/location dimension (single-location by design); `department` (kitchen/cafe) is just a display/filter tag, never an access boundary.

**How access control actually works (three layers):**
1. **Sidebar visibility** — the nav only shows links a role is meant to use (see [section 4](#4-role--navigation-reference)).
2. **In-page checks** — some pages (Employees, HR pages, POS Management, Command Center, P&L) explicitly check `user.role` and show an access-denied message if you land there anyway (e.g. via a typed URL). Others (Menu Editing, Oishii AI, Trend Analysis) rely only on the Sidebar being hidden — no in-page block.
3. **Backend enforcement (the real boundary)** — every sensitive endpoint calls `require_role(user, ...)` server-side regardless of what the frontend shows. This is the layer that actually can't be bypassed.

---

## 2. System map

| App | Purpose | Who uses it | Live URL | Local dev |
|---|---|---|---|---|
| Dashboard (Command Suite) | POS, kitchen, inventory, HR, executive tools | Staff, managers, executives | `oishii-nori-dashboard.vercel.app` | `npm run dev` in `apps/dashboard-web`, port 3000 |
| Staff Clock | Clock in/out kiosk | All employees, at a shared device | `oishii-nori-staff-clock.vercel.app` | `npm run dev` in `apps/staff-clock`, port 5174 |
| Customer Menu | QR table ordering | Customers, own phone, no login | `oishii-nori-menu.vercel.app` | `npm run dev` in `apps/customer-menu`, port 5175 |
| Backend API | Serves all 3 apps above | (infrastructure) | `oishii-nori-api.vercel.app` (`/health`) | uvicorn in `services/api-fastapi`, port 8010 |

---

## 3. Subsystem walkthroughs

### 3.1 Digital Menu — QR customer ordering

**Who:** customers, no login. **App:** `customer-menu`.

A table's QR code is just a static link to `customer-menu.../?table=N` (printed once, no in-app QR generation). If the URL is missing/invalid the app blocks with "scan the QR code" instead of guessing a table.

**Customer flow:**
1. Scan → land on the menu, browsed by category, with search.
2. Tap an item → detail view shows its real recipe ingredients ("What's inside") and a size picker if it comes in more than one size → Add to order.
3. Open the cart (slide-over sheet):
   - Add optional **add-ons** (a separate flat-priced catalog, e.g. extra sauce) via +/- steppers.
   - Optionally enter **"Edit order"** mode to open a per-line **ingredient-hold** checklist (e.g. "no cucumber") — sourced from that item's real recipe, not a hardcoded list.
   - Add an optional note, pick a payment method — **Cash** (waiter collects) or **GCash** (waiter brings the QR) — no actual payment processing happens in-app.
   - Submit.
4. The app switches to a **receipt/status view**: order number, table, itemized lines with any held ingredients, total, and a status badge that polls every 5 seconds until staff act (`PENDING` → `CONFIRMED` or `DECLINED`, with the staff's rejection reason shown if declined). A "Start a new order" button resets after a decline.

**Staff side:** every submitted order lands in **Pending Orders** (see 3.2) for approval — nothing becomes a real sale until a staff member approves it. Approving runs it through the exact same code path a POS sale uses, so it flows into Kitchen Display and inventory deduction automatically.

Prices are always recomputed server-side from the live catalog — never trusted from the customer's device.

### 3.2 POS Terminal, Order Queue & Pending Orders

**Who:** all roles. **Pages:** `/pos`, `/order-queue`, `/pending-orders`.

**POS Terminal** is the checkout screen: a product/size grid, a cart, discount selection, and a Charge button. To hold an ingredient on a line ("no cucumber"), open the order editor and check the box for it — that ingredient is excluded from automatic stock deduction entirely, not deducted-then-restored. Other POS Terminal features: **Held Orders** (park a cart mid-sale, F4, resumes later from the same shift, sessionStorage-scoped), **Favorites** (star items, persists across sessions), an **upsell rail** suggesting up to 6 not-in-cart drinks/dessert/light-side items, and an **Owner's Request** flow (a manager/executive PIN re-verification for actions like a manual discount override).

**Order Queue** (`/order-queue`) is the live list of transactions: status + kitchen-status badges, search by order id/item, date/status filters, and a sound alert (mutable) when an order reaches "ready." Voiding a transaction here restores exactly the stock it deducted — no more, no less — and never restores anything that was held (since holds were never deducted).

**Pending Orders** (`/pending-orders`) is the staff approval queue for customer QR orders (3.1): each card shows table number, order number, items, and a gold payment-method badge. **Approve** converts it into a real transaction (flows into Kitchen Display automatically); **Decline** requires a reason.

### 3.3 Kitchen Display

**Who:** all roles. **Page:** `/kitchen-display`.

A station board (5 real kitchen stations: Sushi Bar, Sushi Bar/Oven, Hot Line, Salad/Cold Bar, Cafe Bar) showing queued/preparing/ready/completed tickets, with stat cards (Delayed count, Avg Prep Time, Longest Order) and a sound alert (mutable) on new orders.

- **Advancing status** is a strict forward-only state machine — no skipping backward.
- **Bundle items** (e.g. Sushi Boat) don't have their own recipe — click **"Log rolls used"** to check off which specific rolls fulfilled the bundle; those rolls' own recipes are what actually deduct stock. A page reload correctly shows "Logged" instead of re-prompting once fulfilled (this is backend-persisted, not just client state).
- **"Log extra usage"** — next to any non-bundle item, opens a dialog to record using more of an ingredient than the recipe calls for (an extra egg, more mayo). Pick the ingredient, the extra quantity, a reason (defaults to Prep error), submit — stock is deducted immediately and it shows up on Loss Log with your name attached. This is the same underlying mechanism as Loss Log, just one click closer to where the mistake happens.
- A "QR order · Table N" badge and any add-ons appear automatically on tickets that originated from the Digital Menu.

### 3.4 Stock — inventory (Recipe Ingredients + Station Items)

**Who:** everyone can log counts; manager/executive edit catalog fields. **Page:** `/stock` (legacy links `/inventory-count` and `/stock-count` still work and land on the correct tab).

**The core idea:** you mostly don't need to count anything by hand anymore. Every POS/QR sale already knows its recipe and deducts the exact ingredients the moment the sale happens — including correctly skipping anything a customer held. Physical counting is now a periodic accuracy check, not the primary tracking method.

**Tab 1 — Recipe Ingredients:** the source of truth for ingredients that go into recipes and drive food cost.
- Log a count any time to reconcile the system's running total against what's physically on the shelf — everyone can do this.
- **Edit** (manager/executive only) opens a full-field dialog: name, category, base unit, suggested reorder unit, reorder threshold, cost volatility tier, notes. If you change the base unit away from its original value, a warning lists every recipe that references the ingredient plus its current stock/threshold in the *old* unit — there's deliberately **no auto-conversion**, since this schema has no unit-conversion table; nothing gets silently corrupted.
- Shows Expiring Soon (advisory, based on the most recent delivery's expiry date — not true per-batch FIFO) and cost-volatility nudges.

**Tab 2 — Station Items:** everything on the client's real paper stock sheets that has *no* recipe at all — packaging, supplies, resale beverages (~200 items) — organized by physical station (Tako-Snack, Cafe-Drinks, Sushi-Kitchen Main, Ramen-Hot Line) in the same New Stocks/Beginning/Usage/Ending format as the old paper sheets. Rows flagged from the original paper transcription as ambiguous carry a **VERIFY** flag until confirmed. A 5th **Manage Catalog** sub-tab (manager/executive) adds/edits items and links them to a real ingredient where applicable. If an item is *also* a recipe ingredient, its stock figure shows read-only here with an "Edit in Recipe Ingredients →" link — there is exactly one place that ever mutates that number.

**Everywhere on Stock:** a live client-side consistency check flags Beginning+NewStocks−Ending mismatches against reported Usage; typing in either tab autosaves your in-progress entries to the browser (nothing hits the server until you hit Save), so a closed tab or dead device doesn't lose a count.

**Low stock:** anything at or below its reorder threshold — recipe ingredient or station item — shows as a red badge next to Stock in the sidebar and a card on Home (executives see the full breakdown on Command Center instead). You don't need to go looking for it.

### 3.5 Receive Shipment, Loss Log, Utility Log

**Who:** all roles. **Pages:** `/inventory-movements` (sidebar label "Receive Shipment"), `/loss-log`, `/utility-log`.

- **Receive Shipment** — a repeating-row batch form: add a row per ingredient (quantity, unit cost, optional expiry date) under one shared supplier/invoice note, submitted together. This is the same mechanism that drives a linked Station Item's "New Stocks" field under the hood. A second tab, **Log Other Movement**, handles non-delivery adjustments (transfers, write-offs). A third, **History**, lists past movements including expiry.
- **Loss Log** — records spoilage, breakage, comps, or shrinkage that isn't tied to a specific kitchen-board order (for order-tied prep overages, use Kitchen Display's "Log extra usage" instead — same underlying endpoint). If no cost is supplied, it falls back to the ingredient's own unit cost automatically.
- **Utility Log** — log electricity/water/gas meter readings or quantities; the system computes consumption and cost per entry.

### 3.6 Menu Editing (executive)

**Who:** executive only. **Page:** `/menu-editing`.

Full CRUD over the catalog — previously read-only since the original spreadsheet seed. From here you can: create a new menu item (name/category/station/department + at least one size), edit item details and per-size prices, edit a recipe's ingredient components, and upload a real product photo (stored in a Supabase Storage bucket, not a static repo file). **Deactivate/reactivate** is how "delete" works for a product or size that has sales history — a true hard delete would break foreign-key-referenced transaction/loss records; the only real hard-deletes are brand-new, never-sold sizes/recipe lines (and a product's last remaining size can't be removed — deactivate the product instead).

### 3.7 P&L Dashboard (executive)

**Who:** executive only. **Page:** `/pnl`.

A Today/Week/Month toggle showing revenue, gross/net profit, food cost %, a cost breakdown (COGS/payroll/utilities/losses), and margin by department — computed live from existing recipe/BOM data and ingredient unit costs, no separate snapshot job. The page is upfront about its own known gaps via on-screen callouts: COGS for a past period uses **today's** ingredient costs (no historical cost snapshot exists), a bundle sale with no logged roll-fulfillment contributes ₱0 COGS until logged, and it flags how many ingredients still have no unit cost entered.

### 3.8 Command Center & Trend Analysis (executive)

**Who:** executive only (this is also where executives land on login instead of Home). **Pages:** `/command-center`, `/trends`.

**Command Center** — a same-day rollup: revenue, discounts, tax, losses, low-stock count, utility cost, department split, and a best-effort staff-clocked-in count.
**Trend Analysis** — a date-range sales-trend chart and a top-products table, computed from real transaction data (not a mock).

### 3.9 POS Management (manager+)

**Who:** manager, executive. **Page:** `/pos-management`.

CRUD for discount types: name, percentage, VAT-exempt flag, active toggle. These are what populate the discount picker on POS Terminal.

### 3.10 Settings

**Who:** all roles for account/logout; executive-only for business settings. **Page:** `/settings`.

Every role sees their account info and a logout control. Executives additionally see a **Business Settings** card to change the VAT rate — this used to be two hardcoded, manually-synced `0.12` constants (backend + frontend); now it's one admin-editable value that both POS tax calculation and the customer-menu add-on tax top-up read live.

### 3.11 Oishii AI (executive)

**Who:** executive only. **Page:** `/oishii-ai`.

A chat assistant grounded in real, live business data (not a generic chatbot) — it can answer questions about revenue, best sellers, loss drivers (including by reason, e.g. spoilage), individual employee pay rates, current ingredient stock, payroll history, and more, with optional generated bar/line charts for comparison/trend questions. Example questions it can answer correctly: "What's my revenue today?", "What's driving my losses?", "What's Liza Fernandez's pay rate?", "What's my current stock of Sushi rice (raw)?" Responses take roughly 10–55 seconds (free-tier LLM queueing). Note: employee pay rates are included in the data sent to the LLM provider on every query — this endpoint is executive-only specifically because of that.

### 3.12 HR & Payroll suite (manager+/executive)

**Who:** manager, executive (holiday and pay-rule *edits* are executive-only within these pages). **Pages:** `/employees`, `/hr/attendance`, `/hr/payroll`, `/hr/holiday-calendar`, `/hr/payroll-settings`.

- **Employees** — roster CRUD: name, role, department, position, pay rate, and setting a kiosk PIN (used at the Staff Clock, see 3.13).
- **HR Attendance** — attendance log table; managers/executives can also create a manual payroll-override entry (regular/OT/night-diff hours, day scenario) for edge cases.
- **HR Payroll** — generate a payroll run for a period (semimonthly or full-month), preview before committing, summary cards (Total Payroll/Overtime/Night Diff/Holiday), a per-employee drawer (Overview/Breakdown/Payslip), and real **PDF payslips** — download one employee's or a bulk ZIP of everyone's for the period. Includes an override-approval flow and an audit log.
- **Holiday Calendar** — CRUD of holidays by year and type (regular / special non-working / special working) — these feed the pay-multiplier logic for payroll generation.
- **Payroll Settings** — the actual pay-rule percentages per work-day scenario (regular day, holiday combinations, rest day, etc.) — this is what "generate payroll" computes against.

### 3.13 Staff Clock kiosk

**Who:** any employee, at a shared physical device. **App:** `staff-clock` (separate app, no login screen — PIN only).

1. Enter your **Employee Number + PIN** on the shared device.
2. Confirm your name/position on screen.
3. Depending on today's status: **Punch In**, or if already clocked in, see a live elapsed timer and **End Today's Work**, or if already completed today, a done message.
4. Ending your shift shows a confirm screen with a live time-out preview, then a total-hours-worked summary.

Every screen after PIN entry auto-resets to idle after 30 seconds of no activity, since this is a shared device that must always be ready for the next person. If the device loses network mid clock-in/out, the action queues locally and shows "Offline — queued, will sync automatically," auto-flushing once the connection returns (a genuinely rejected request, like a wrong PIN, is never queued — that fails immediately). Each physical kiosk has its own persistent device id so clock events can be traced to which device was used.

---

## 4. Role & navigation reference

Sidebar sections on the dashboard, exactly as gated:

**All roles:**
POS Terminal (`/pos`) · Order Queue (`/order-queue`) · Pending Orders (`/pending-orders`) · Kitchen Display (`/kitchen-display`) · Stock (`/stock`) · Receive Shipment (`/inventory-movements`) · Loss Log (`/loss-log`) · Utility Log (`/utility-log`) · Settings (`/settings`)

**Manager + Executive:**
POS Management (`/pos-management`) · Employees (`/employees`) · HR Attendance (`/hr/attendance`) · Payroll (`/hr/payroll`) · Holiday Calendar (`/hr/holiday-calendar`) · Payroll Settings (`/hr/payroll-settings`)

**Executive only:**
Command Center (`/command-center`) · Trend Analysis (`/trends`) · Menu Editing (`/menu-editing`) · P&L (`/pnl`) · Oishii AI (`/oishii-ai`)

Executives are auto-redirected to Command Center on login rather than landing on Home.

---

## 5. Backend API reference

One FastAPI service (`services/api-fastapi`), 18 routers, all registered in `app/main.py`. `require_role` is a manual in-handler check, not middleware — every meaningful write is gated server-side regardless of what the frontend shows.

| Router | Covers | Gating |
|---|---|---|
| `products.py` | Catalog listing, image set/clear | Read: open. Image: manager+ |
| `recipes.py` | Recipe/BOM lookup by size | Open |
| `menu_admin.py` | Full product/size/recipe/image CRUD | Executive only |
| `inventory.py` | Ingredient list, low-stock, expiring-soon, edit, recipe-usage reverse lookup, physical count | Edit: executive. Rest open |
| `inventory_movements.py` | Log/list stock movements (delivery, transfer, count adjustment) | Open |
| `stock_items.py` | Station items (packaging/supplies/resale) + count entries | Catalog CRUD: manager+. Counting: open |
| `discounts.py` | Discount-type list/CRUD | CRUD: manager+ |
| `loss_records.py` | Log/list losses | Open |
| `hr.py` | Attendance, payroll generation/records/PDFs, holidays, pay rules, overrides/audit, employee admin | Manager+/executive throughout |
| `kiosk.py` | Staff Clock PIN verify/clock-in/clock-out | **Public** (PIN-authenticated per call) |
| `transactions.py` | POS sale create/list/void/kitchen-status/bundle-fulfillment | Mostly open; void/status gated by ownership or manager+ |
| `utility_logs.py` | Log/list utility readings | Open |
| `digital_menu.py` | QR menu, add-ons, order submit/poll, staff approve/reject | `/public/*` open; staff endpoints authenticated, no extra role gate |
| `dashboard_summary.py` | Command Center daily rollup | Executive only |
| `analytics.py` | Sales trend, top products | Executive only |
| `pnl.py` | P&L rollup | Executive only |
| `oishi_ai.py` | AI business-analyst chat | Executive only |
| `settings.py` | Business/VAT settings | Read: open. Write: executive |

Plus `GET /health` (liveness, no auth).

**Auth model:** a Bearer token is validated via Supabase Auth (`get_current_user`), then role/department/name is loaded from `profiles`. The backend uses a service-role Supabase client for every query — authorization lives entirely in FastAPI, not in Postgres row-level-security policies.

**Database:** Supabase/Postgres, 23 applied migrations. Core tables: `profiles`, `products`/`product_sizes`/`bundle_components`, `ingredients`/`recipe_items`, `inventory_movements`, `transactions`/`transaction_items`/`bundle_fulfillments`, `discount_types`, `loss_records`, `utility_logs`, `stock_items`/`stock_count_entries`, `digital_orders`/`digital_order_items`/`digital_order_addons`, `menu_addons`, `attendance_logs`, `kiosks`, `holidays`, `pay_multiplier_rules`, `payroll_records`/`payroll_items`/`payroll_overrides`/`payroll_audit_log`, `ai_query_log`, `business_settings`.

---

## 6. Deployment & local dev

**Live (Vercel, team `vince-tamis`, auto-deploy on push to `main`):**
- Dashboard: `https://oishii-nori-dashboard.vercel.app`
- Staff Clock: `https://oishii-nori-staff-clock.vercel.app`
- Backend API: `https://oishii-nori-api.vercel.app`
- Customer Menu: `https://oishii-nori-menu.vercel.app`

**Local dev:**
```bash
# Backend (from services/api-fastapi)
services/api-fastapi/.venv/Scripts/python.exe -m uvicorn app.main:app --port 8010 --reload

# Dashboard (from apps/dashboard-web), port 3000
npm install && npm run dev

# Staff Clock (from apps/staff-clock), port 5174
npm install && npm run dev

# Customer Menu (from apps/customer-menu), port 5175
npm install && npm run dev
```

**Locked scope decisions** (established, don't re-litigate without the client):
- Single branch, two departments (kitchen, cafe) — no multi-location/branch model.
- Polling throughout, by design — no websockets/Realtime.
- Sushi Boat bundle = "classic flavors" only, excludes Dragon Maki/Oishii Maki.
- Inventory expiry tracking is advisory (most-recent-delivery based), not true per-batch/FIFO.

---

## 7. Known gaps / not yet built

Non-blocking backlog, not required for day-to-day operation:
- Supplier/vendor tracking, purchase orders with expected-vs-received reconciliation, ingredient usage-trend analytics, low-stock notification/digest.
- No historical cost snapshot for P&L — past-period COGS always reflects today's ingredient costs.
- `CORSMiddleware` still allows `allow_origins=["*"]`.
- No audit trail for unlinked Station Items' count history (only the current running total).
- Groq (the AI provider)'s free tier has a real per-organization token-per-minute cap — the context payload was trimmed to fit comfortably, but may need revisiting if the business scales up significantly (more ingredients/employees/history).
