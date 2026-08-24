# Oishii Nori Command Suite — Complete System Walkthrough

**A screenshot-illustrated, click-by-click guide to every flow in the system.**

This document walks through all four apps that make up the Oishii Nori Command Suite — the customer-facing QR ordering menu, the staff clock-in kiosk, and the internal Command Suite dashboard (POS, kitchen, stock, HR/payroll, and executive tools) — in the order a real business day touches them: a customer orders, staff serve and stock the restaurant, and management reviews the numbers. Every screenshot in this document was captured against the live, running application with real data — nothing here is a mockup.

For a condensed feature-by-feature reference, see `SYSTEM_GUIDE.md`. For the inventory model specifically, see `INVENTORY_SYSTEM_GUIDE.md`. This document goes deeper, with an emphasis on the stock/inventory counting mechanism, per your request.

---

## Contents

1. [System Overview](#1-system-overview)
2. [Customer Menu — QR Table Ordering](#2-customer-menu--qr-table-ordering)
3. [Staff Clock — Kiosk Attendance](#3-staff-clock--kiosk-attendance)
4. [Roles & Access](#4-roles--access)
5. [Command Suite: Selling & Kitchen](#5-command-suite-selling--kitchen)
6. [Command Suite: Stock & Inventory Management](#6-command-suite-stock--inventory-management)
7. [Command Suite: Operations & Executive Pages](#7-command-suite-operations--executive-pages)
8. [Command Suite: HR & Payroll](#8-command-suite-hr--payroll)
9. [Appendix: Architecture Reference](#9-appendix-architecture-reference)

---

## 1. System Overview

Oishii Nori Command Suite is the full digital operations system for a single-location sushi/ramen restaurant. Four apps share one FastAPI backend and one Supabase/Postgres database:

| App | Purpose | Who uses it |
|---|---|---|
| **Customer Menu** | QR-code table ordering, no login | Customers, on their own phone |
| **Staff Clock** | Shared kiosk device for clock-in/clock-out | Every employee |
| **Dashboard (Command Suite)** | POS, kitchen, stock, HR/payroll, executive tools | Staff, managers, executives |
| **Backend API** | Serves all three apps above | (infrastructure) |

Three roles exist — **employee**, **manager**, **executive** — each seeing a different slice of the dashboard, covered in [Section 4](#4-roles--access). Everything downstream of a sale (stock deduction, kitchen tickets, P&L) flows through the *same* code path regardless of whether the sale started at POS Terminal or the Customer Menu, so this walkthrough follows one order end-to-end from the customer's phone through to the kitchen.

---

## 2. Customer Menu — QR Table Ordering

A table's QR code is just a static link to `customer-menu.../?table=N` — no app to install, no account to create. This section follows a real order from scan to kitchen ticket.

### Step 1 — Scan and browse

The customer scans the code at their table and lands directly on the menu: a hero section, a category rail, search, and the item list grouped by category.

![Menu browse](walkthrough-screenshots/01-customer-menu/01-menu-browse.png)

### Step 2 — Open an item

Tapping a dish opens its detail view, showing the real recipe ingredients under "What's inside" and, for multi-size items, a size picker with real prices per size.

![Item detail and size picker](walkthrough-screenshots/01-customer-menu/02-item-detail-size-picker.png)

### Step 3 — Add to the order

Tapping a size row adds that item to the cart — a confirmation toast appears and the modal closes.

![Added to cart](walkthrough-screenshots/01-customer-menu/03-added-to-cart.png)

### Step 4 — Open the cart

The cart sheet shows every line, a quantity stepper per line, an order-note field, and the payment method picker.

![Cart sheet](walkthrough-screenshots/01-customer-menu/04-cart-sheet.png)

### Step 5 — Hold an ingredient

If a customer wants something left out ("no cucumber"), "Edit this recipe" opens a checklist sourced from that item's real recipe — nothing is hardcoded here, it's the same `recipe_items` data the kitchen uses.

![Ingredient-hold checklist](walkthrough-screenshots/01-customer-menu/06-ingredient-hold-checklist.png)

### Step 6 — Choose a payment method

Cash (waiter collects) or GCash (waiter brings the QR) — no payment processing actually happens in the browser; this is just a heads-up for staff.

![Payment method](walkthrough-screenshots/01-customer-menu/07-payment-method.png)

### Step 7 — Submit and track

After tapping "Send to the counter," the whole screen becomes a receipt-styled order ticket. Note the "Hold: Sushi rice (raw)" line — the ingredient hold from Step 5 carried all the way through. The status badge (`PENDING`) polls automatically every 5 seconds until staff act on it in Pending Orders (Section 5).

![Order status / receipt](walkthrough-screenshots/01-customer-menu/08-order-status-receipt.png)

**What happens next:** nothing becomes a real sale until a staff member approves it in Pending Orders. Declining never touches inventory at all; approving runs the order through the *exact same* insert/deduction logic a POS sale uses.

---

## 3. Staff Clock — Kiosk Attendance

A shared physical device, PIN-based, no login screen. This section also documents a real bug found and fixed while producing this walkthrough — see the callout at the end.

### Step 1 — Identify yourself

Employee Number + PIN, numeric keypad-friendly.

![PIN entry](walkthrough-screenshots/02-staff-clock/01-pin-entry.png)

### Step 2 — Confirm

The device shows the matched name/position before doing anything — Cancel or Continue.

![Confirm identity](walkthrough-screenshots/02-staff-clock/02-confirm-identity.png)

### Step 3 — Punch in

If this is the first action of the day, the only option is Punch In.

![Ready to punch in](walkthrough-screenshots/02-staff-clock/03-ready-to-punch-in.png)

### Step 4 — Confirmation

A success screen confirms the punch and auto-dismisses after a couple of seconds — the kiosk is a shared device, so it resets itself for the next person rather than waiting for someone to tap "done."

![Punch-in success](walkthrough-screenshots/02-staff-clock/04-punch-in-success.png)

### Step 5 — Returning later, already clocked in

When the same employee comes back to the kiosk later in their shift (a fresh PIN entry, not a continuation of the same session), they see a live elapsed-time timer and an "End Today's Work" button.

![Active shift timer](walkthrough-screenshots/02-staff-clock/05-active-shift-timer.png)

### Step 6 — Ending the shift

"End Today's Work" shows a confirm screen with a live time-out preview before committing.

![End shift confirm](walkthrough-screenshots/02-staff-clock/06-end-shift-confirm.png)

### Step 7 — Shift summary

A total-hours-worked summary closes out the visit, then auto-dismisses back to the idle PIN screen.

![Shift summary](walkthrough-screenshots/02-staff-clock/07-shift-summary.png)

> **Bug found and fixed while producing this walkthrough.** Step 5's screen used to render completely blank instead of the timer/End button. Root cause: `apps/staff-clock/client/src/App.tsx` hardcoded `log: null` on every PIN verification, but the "Active Work" view only renders when that value is populated — and it was only ever populated by a *fresh* punch-in within the same browser session, never by a later "I'm already clocked in" verification. In practice, this meant an employee who stepped away from the kiosk after punching in (the normal case — nobody clocks in and out in the same instant) would come back later to end their shift and see nothing, with no way to clock out through the UI. The backend already returned an `attendance_log_id` for this exact case; the fix (`services/api-fastapi/app/routers/kiosk.py`, `app/schemas.py`, `apps/staff-clock/client/src/lib/kiosk.ts`, `apps/staff-clock/client/src/App.tsx`) has the `/kiosk/verify` endpoint return the already-fetched attendance log row directly, and the frontend now uses it instead of hardcoding `null`. Verified end-to-end against the real backend — Step 5's screenshot above is the fixed behavior.

---

## 4. Roles & Access

Every staff account has exactly one role, and the dashboard's sidebar is the primary way each role's access differs. Backend `require_role` checks are the real enforcement layer — the sidebar is just the visible reflection of it.

### Employee

The front-of-house/back-of-house toolset: POS, Order Queue, Pending Orders, Kitchen Display, the full Stock counting tools (Recipe Ingredients, Station Items, Receive Shipment), Loss Log, Utility Log, and Settings.

![Employee sidebar](walkthrough-screenshots/03-roles/employee-sidebar.png)

### Manager

Everything an employee has, plus POS Management, the full HR/Payroll suite (Employees, HR Attendance, Payroll, Holiday Calendar, Payroll Settings), and the Stock group's oversight pages — Overview, Alerts, Variance Log.

![Manager sidebar](walkthrough-screenshots/03-roles/manager-sidebar.png)

### Executive

Full access: everything above, plus Command Center (the executive's landing page after login), Trend Analysis, Menu Editing, P&L, Oishii AI, and Help.

![Executive sidebar](walkthrough-screenshots/03-roles/executive-sidebar.png)

---

## 5. Command Suite: Selling & Kitchen

### POS Terminal

The checkout screen: a product grid on the left, the current order on the right.

![POS empty cart](walkthrough-screenshots/04-pos-orders-kitchen/01-pos-empty-cart.png)

Tapping a single-price item (like a drink) adds it straight to the cart:

![Item added](walkthrough-screenshots/04-pos-orders-kitchen/02-pos-item-added.png)

The discount picker pulls from whatever discount types exist in POS Management:

![Discount menu](walkthrough-screenshots/04-pos-orders-kitchen/03-pos-discount-menu.png)

Charging finalizes the sale — this is the same underlying transaction-creation code that an approved QR order also runs through:

![Charge confirm](walkthrough-screenshots/04-pos-orders-kitchen/04-pos-charge-confirm.png)
![Sale complete](walkthrough-screenshots/04-pos-orders-kitchen/05-pos-sale-complete.png)

Other POS Terminal capabilities not pictured step-by-step here: **Held Orders** (park an in-progress cart, resume later in the same shift), **Favorites** (star frequently-sold items), an ingredient-hold editor identical in spirit to the customer menu's, and an "Owner's Request" PIN re-verification flow for manager/executive overrides.

### Order Queue

Every transaction — from POS or an approved QR order — shows up here with live status badges, search, and filters:

![Order Queue](walkthrough-screenshots/04-pos-orders-kitchen/06-order-queue.png)

### Pending Orders

QR orders land here first, staged and unapproved. This is real data from the order placed in Section 2:

![Pending Orders](walkthrough-screenshots/04-pos-orders-kitchen/07-pending-orders.png)

Approving one runs it through the same insert/deduction logic as a POS sale:

![Approve confirm](walkthrough-screenshots/04-pos-orders-kitchen/08-pending-orders-approve-confirm.png)
![Approved](walkthrough-screenshots/04-pos-orders-kitchen/09-pending-orders-approved.png)

### Kitchen Display

A station board of active tickets. Both the POS sale and the just-approved QR order appear here automatically — no special-casing needed on the kitchen side for where an order came from:

![Kitchen Display](walkthrough-screenshots/04-pos-orders-kitchen/10-kitchen-display.png)

Each ticket advances forward-only through its lifecycle (the real button is labeled **Accept**, then **Complete**):

![Status advanced](walkthrough-screenshots/04-pos-orders-kitchen/11-kitchen-display-status-advanced.png)

If prep uses more of an ingredient than the recipe calls for, "Log extra usage" records it immediately, right where the discrepancy happened — the same underlying mechanism as Loss Log, just one click away instead of a trip to a different page:

![Log extra usage](walkthrough-screenshots/04-pos-orders-kitchen/12-kitchen-display-log-extra-usage.png)

---

## 6. Command Suite: Stock & Inventory Management

This is the deepest section of the walkthrough, per your request. The short version of the whole philosophy: **you no longer count everything by hand every day.** Every POS and QR sale already deducts its own recipe ingredients the instant the sale happens — correctly skipping anything a customer held — so physical counting is now a periodic accuracy check, not the primary way stock gets tracked. The two things a manual count could never see on its own (a held ingredient, extra usage during prep) are now captured directly at the point they happen, by the person who saw it happen (Sections 2, 5).

The whole Stock area lives under one collapsible sidebar group: **Overview → Recipe Ingredients → Station Items → Receive Shipment → Alerts → Variance Log.**

### 6.1 Recipe Ingredients — the count sheet

This is the source of truth for anything that goes into a recipe and drives food cost.

![Recipe Ingredients empty](walkthrough-screenshots/05-stock/01-recipe-ingredients-empty.png)

**Expected** is what the system currently believes is on the shelf (its running total, kept accurate automatically by every sale). **Counted** is what a person physically counts and types in. As you type, **Variance** and **Status** compute live, before anything is saved:

![Variance color states](walkthrough-screenshots/05-stock/02-recipe-ingredients-variance-states.png)

The rule: within 5% of Expected is treated as normal counting noise and shown as **Counted** (green). Anything further off is flagged **Overage** (amber — you counted more than expected, often an uncounted delivery) or **Shortage** (red — real loss, or a miscount). Every column header is clickable to sort:

![Sorted](walkthrough-screenshots/05-stock/03-recipe-ingredients-sorted.png)

An "Expiring Soon" card surfaces ingredients whose most recent delivery is nearing its expiry window — advisory only, since this schema tracks a single running stock total, not per-batch/FIFO lots:

![Expiring Soon](walkthrough-screenshots/05-stock/04-recipe-ingredients-expiring-soon.png)

**Editing an ingredient's own fields** (executive-only) opens a full-field dialog — name, category, base unit, suggested reorder unit, reorder threshold, cost volatility tier, notes:

![Edit dialog](walkthrough-screenshots/05-stock/05-recipe-ingredient-edit-dialog.png)

If you change the **base unit** away from its original value (e.g. an ingredient the kitchen actually tracks by the pack, not by weight), a warning appears: current stock and reorder threshold keep their old numeric values — now mislabeled — and there is deliberately **no auto-conversion**, because this schema has no unit-conversion table anywhere. The warning also lists every real recipe line currently using this ingredient, pulled live:

![Base-unit-change warning](walkthrough-screenshots/05-stock/06-recipe-ingredient-unit-change-warning.png)

**Saving a count**: stock is set to exactly what was counted. Anything that came out different from Expected is permanently logged as a stock-count-adjustment movement (see Variance Log, 6.5) — an exact match logs nothing, since there's no discrepancy to record. If anything came up short, an optional follow-up dialog offers to log it as a loss so the cost is tracked. This is never automatic — a shortage might just be a miscount, so it's always the counter's call:

![Shrinkage follow-up dialog](walkthrough-screenshots/05-stock/07-recipe-ingredients-shrinkage-dialog.png)

**Nothing is ever lost mid-count.** Typing into the Counted column autosaves your unsaved entries to the browser as you go (nothing hits the server until you actually hit Save). If a tab closes or a device dies mid-count, reopening the page offers to restore exactly what you'd entered, with a timestamp so you know how stale the numbers might be:

![Draft restore](walkthrough-screenshots/05-stock/08-recipe-ingredients-draft-restore.png)

### 6.2 Station Items — everything without a recipe

The second tab covers the ~200 items on the client's original paper stock sheets that have *no* recipe at all — packaging, supplies, resale beverages — organized by physical station in the same New Stocks / Beginning / Usage / Ending format the paper sheets used:

![Station Items grid](walkthrough-screenshots/05-stock/09-station-items-grid.png)

Rows carried over from the original paper-sheet transcription as ambiguous are flagged **VERIFY** until a human confirms the mapping (none are currently flagged live in this data — every original flag from the 215-row seed has since been resolved through Manage Catalog, described below — but the mechanism is still active for any future ambiguous entry).

For the subset of station items that are *also* real recipe ingredients (tracked in both places), the live stock figure shown here is **read-only**, with a direct link to the one real place that edits it:

![Linked ingredient](walkthrough-screenshots/05-stock/11-station-items-linked-ingredient.png)

A free, client-side-only consistency check compares Beginning + New Stocks − Ending against the typed Usage figure — if they don't match, the Usage field flags a **Mismatch** with the expected value. No backend cost, purely a nudge:

![Mismatch warning](walkthrough-screenshots/05-stock/12-station-items-mismatch-warning.png)

### 6.3 Manage Catalog

A fifth sub-tab, visible only to managers/executives, lists every station item across all four stations in one place:

![Manage Catalog](walkthrough-screenshots/05-stock/13-station-items-manage-catalog.png)

Editing an item lets you change its name/category/unit/reorder threshold, and — critically — link it to a real ingredient. Linking is what makes a station item's Ending/New Stocks feed directly into that ingredient's real stock, the same mechanism Receive Shipment and Recipe Ingredients already use:

![Manage Catalog edit dialog](walkthrough-screenshots/05-stock/14-station-items-manage-catalog-edit.png)

### 6.4 Overview

A read-only landing page aggregating everything above into one glance: low-stock count, expiring-soon items, per-station verification counts, and recent movements — all real, aggregated data, zero fabricated figures:

![Stock Overview](walkthrough-screenshots/05-stock/15-stock-overview.png)

### 6.5 Alerts

A dedicated, filterable/sortable table combining every real low-stock, expiring, and verify-needed item in one place. Each row's "Count now" action deep-links straight to the right tab (and, for a station item, the right station) instead of leaving you to find it yourself:

![Stock Alerts](walkthrough-screenshots/05-stock/16-stock-alerts.png)

Filtering by type narrows the list instantly:

![Alerts filtered](walkthrough-screenshots/05-stock/17-stock-alerts-filtered.png)

### 6.6 Variance Log

A chronological, filterable reconciliation view combining two real data sources: loss records (spoilage/breakage/comp/shrinkage) and count-adjustment movements (the audit trail every non-matching count from 6.1 produces). Variance is signed (+overage / −shortage), cost impact is real where known, and "Recorded by" shows an actual employee name via a live join — not a raw ID:

![Variance Log](walkthrough-screenshots/05-stock/18-stock-variance-log.png)

No server-side date-range filter exists today — this reflects the most recent 50 records of each kind, not a full history search, and the page says so rather than implying otherwise.

---

## 7. Command Suite: Operations & Executive Pages

### Receive Shipment

A batch delivery-logging form — a row per ingredient (quantity, unit cost, optional expiry date), one shared supplier/invoice note applied to every line:

![Receive Shipment](walkthrough-screenshots/06-other-pages/01-receive-shipment.png)

A second tab handles one-off, non-delivery movements (transfers, write-offs, manual adjustments):

![Log Other Movement](walkthrough-screenshots/06-other-pages/02-log-other-movement.png)

A third tab is the full movement history, including expiry dates:

![Movements History](walkthrough-screenshots/06-other-pages/03-movements-history.png)

### Loss Log

For spoilage/breakage/comps/shrinkage not tied to a specific kitchen-board order (order-tied prep overages use Kitchen Display's "Log extra usage" instead — same underlying endpoint):

![Loss Log](walkthrough-screenshots/06-other-pages/04-loss-log.png)

### Utility Log

Electricity/water/gas meter readings, with consumption and cost computed automatically:

![Utility Log](walkthrough-screenshots/06-other-pages/05-utility-log.png)

### POS Management

Discount-type CRUD (manager/executive) — name, percentage, VAT-exempt flag, active toggle. These populate the discount picker on POS Terminal:

![POS Management](walkthrough-screenshots/06-other-pages/06-pos-management.png)

### Command Center (executive)

The executive's landing page after login — a same-day rollup: revenue, discounts, tax, losses, low-stock, utility cost, department split, and a best-effort staff-clocked-in count:

![Command Center](walkthrough-screenshots/06-other-pages/07-command-center.png)

### Trend Analysis (executive)

A date-range sales-trend chart and a top-products table, computed from real transaction data:

![Trend Analysis](walkthrough-screenshots/06-other-pages/08-trend-analysis.png)

### Menu Editing (executive)

Full CRUD over the catalog — items, per-size prices, recipe/ingredient components, and real photo uploads:

![Menu Editing](walkthrough-screenshots/06-other-pages/09-menu-editing.png)

### P&L (executive)

Revenue, gross/net profit, food cost %, a cost breakdown, and margin by department — computed live from the same recipe/BOM data and ingredient unit costs that power the Stock section above, with on-screen callouts for known data gaps (e.g. how many ingredients still need a cost entered):

![P&L](walkthrough-screenshots/06-other-pages/10-pnl.png)

### Oishii AI (executive)

A chat assistant grounded in real, live business data — revenue, best sellers, loss drivers, stock levels, payroll — not a generic chatbot:

![Oishii AI](walkthrough-screenshots/06-other-pages/11-oishii-ai.png)

### Help

An in-app FAQ (executive-only, positioned under Oishii AI in the sidebar) summarizing how every subsystem works, for quick client/staff reference without leaving the app:

![Help](walkthrough-screenshots/06-other-pages/12-help.png)

### Settings

Account info and logout for everyone; executives additionally see Business Settings, where the VAT rate is configured (a single admin-editable value, replacing what used to be two hardcoded, manually-synced constants):

![Settings](walkthrough-screenshots/06-other-pages/13-settings.png)

---

## 8. Command Suite: HR & Payroll

### Employees

Roster CRUD — name, role, department, position, pay rate, and setting a kiosk clock-in PIN (the same PIN used at the Staff Clock kiosk in Section 3):

![Employees](walkthrough-screenshots/07-hr/01-employees.png)

### HR Attendance

The attendance log, plus manual payroll-override entry for edge cases:

![HR Attendance](walkthrough-screenshots/07-hr/02-hr-attendance.png)

### Payroll

Preview & Generate: pick a period, load a preview before committing to a real generated run:

![Payroll Preview & Generate](walkthrough-screenshots/07-hr/03-payroll-preview-generate.png)

A loaded preview shows summary cards and a per-employee breakdown:

![Payroll preview loaded](walkthrough-screenshots/07-hr/04-payroll-preview-loaded.png)

History holds every past generated run, with real PDF payslip downloads — single or a bulk ZIP for everyone in the period:

![Payroll History](walkthrough-screenshots/07-hr/05-payroll-history.png)

Overrides & Audit tracks manual payroll-override requests and their approval trail:

![Overrides & Audit](walkthrough-screenshots/07-hr/06-payroll-overrides-audit.png)

### Holiday Calendar

Regular/special-non-working/special-working holidays by year — these feed the pay-multiplier rules payroll generation calculates against:

![Holiday Calendar](walkthrough-screenshots/07-hr/07-holiday-calendar.png)

### Payroll Settings

The actual DOLE pay-rule percentages per work-day scenario:

![Payroll Settings](walkthrough-screenshots/07-hr/08-payroll-settings.png)

---

## 9. Appendix: Architecture Reference

**Tech stack:** React 19 + Vite + TypeScript + Tailwind + shadcn/ui on every frontend; FastAPI + Supabase/Postgres on the backend; all four apps deploy to Vercel on push to `main`. No websockets anywhere — every page that needs to feel "live" polls on an interval, by design.

**Backend surface:** 18 routers (`products`, `recipes`, `menu_admin`, `inventory`, `inventory_movements`, `stock_items`, `discounts`, `loss_records`, `hr`, `kiosk`, `transactions`, `utility_logs`, `digital_menu`, `dashboard_summary`, `analytics`, `pnl`, `oishi_ai`, `settings`), zero new endpoints added for the Overview/Alerts/Variance Log pages in this walkthrough — everything reuses what already existed.

**Access control, three layers:** Sidebar visibility (what a role is shown), in-page checks (what a role is blocked from if they navigate there directly), and backend `require_role` (the real, unbypassable boundary).

**Full technical detail:** `SYSTEM_GUIDE.md` (system-wide reference), `INVENTORY_SYSTEM_GUIDE.md` (inventory model), `SESSION_HANDOFF.md` and `PROGRESS.md` (build history).

---

*Screenshots captured against the live local development environment (dashboard on port 3003, backend on ports 8000/8010, staff-clock on 5174, customer-menu on 5175) using real seeded data. All test data created during capture (the sample order, the sample POS sale) was left in place as real records, consistent with how this system has been verified throughout its development — nothing here is staged or faked. The one exception, noted inline, is the two ingredients whose stock was intentionally over/undercounted to demonstrate the variance states in Section 6.1 — both were reverted to their original values immediately after capture.*
