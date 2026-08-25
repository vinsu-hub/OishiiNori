# Oishii Nori Command Suite — Complete System Walkthrough

**A screenshot-illustrated, click-by-click guide to every flow in the system.**

This document walks through the five apps that make up the Oishii Nori Command Suite — the public marketing website, the customer-facing QR ordering menu (which also hosts the table-reservation flow), the staff clock-in kiosk, and the internal Command Suite dashboard (POS, kitchen, reservations, stock, HR/payroll, and executive tools) — in the order a real business day touches them: a visitor discovers the restaurant and reserves or walks in, a customer orders, staff serve and stock the restaurant, and management reviews the numbers. Every screenshot in this document was captured against the live, running application with real data — nothing here is a mockup.

For a condensed feature-by-feature reference, see `SYSTEM_GUIDE.md`. For the inventory model specifically, see `INVENTORY_SYSTEM_GUIDE.md`. This document goes deeper, with an emphasis on the stock/inventory counting mechanism, per your request.

---

## Contents

1. [System Overview](#1-system-overview)
2. [Landing Page — Public Website](#2-landing-page--public-website)
3. [Customer Menu — QR Table Ordering](#3-customer-menu--qr-table-ordering)
4. [Staff Clock — Kiosk Attendance](#4-staff-clock--kiosk-attendance)
5. [Roles & Access](#5-roles--access)
6. [Command Suite: Selling & Kitchen](#6-command-suite-selling--kitchen)
7. [Command Suite: Stock & Inventory Management](#7-command-suite-stock--inventory-management)
8. [Command Suite: Operations & Executive Pages](#8-command-suite-operations--executive-pages)
9. [Command Suite: HR & Payroll](#9-command-suite-hr--payroll)
10. [Appendix: Architecture Reference](#10-appendix-architecture-reference)

---

## 1. System Overview

Oishii Nori Command Suite is the full digital operations system for a single-location sushi/ramen restaurant. Five apps share one FastAPI backend and one Supabase/Postgres database:

| App | Purpose | Who uses it |
|---|---|---|
| **Landing Page** | Public marketing site — menu preview, hours/location, FAQ, reservation CTA | Anyone, public web visitor |
| **Customer Menu** | QR-code table ordering, no login — also hosts the reservation flow | Customers, on their own phone |
| **Staff Clock** | Shared kiosk device for clock-in/clock-out | Every employee |
| **Dashboard (Command Suite)** | POS, kitchen, reservations, stock, HR/payroll, executive tools | Staff, managers, executives |
| **Backend API** | Serves all four apps above | (infrastructure) |

Three roles exist — **employee**, **manager**, **executive** — each seeing a different slice of the dashboard, covered in [Section 5](#5-roles--access). Everything downstream of a sale (stock deduction, kitchen tickets, P&L) flows through the *same* code path regardless of whether the sale started at POS Terminal or the Customer Menu, so this walkthrough follows one order end-to-end from the customer's phone through to the kitchen, and one reservation end-to-end from the public website through to staff confirming it.

---

## 2. Landing Page — Public Website

The public front door: a single-page marketing site at the restaurant's public URL, unauthenticated, built to be found by search engines and AI crawlers (prerendered at build time, with `Restaurant`/`FAQPage` structured data — see `SYSTEM_GUIDE.md` §3.16 for the SEO mechanics). It reads real data from the same backend every other app uses — nothing here is hand-typed content that can drift from the real menu or hours.

### Hero

The landing view: brand mark, tagline, and two calls to action — "Reserve a table" (jumps straight to the Reserve section) and "View menu" (jumps to the menu grid).

![Landing page hero](walkthrough-screenshots/08-landing-page/01-hero.png)

### Menu — curated best sellers

Not the full catalog: up to 3 photographed items per category, live-pulled via the same `fetchMenu()` call the Customer Menu app uses. An item without a photo can't appear here — this is a visual showcase, not the ordering menu.

![Best-sellers menu grid](walkthrough-screenshots/08-landing-page/02-menu-grid.png)

### About

Two short copy blocks (Sushi/Rolls, Ramen/Hot Line) either side of a kitchen photo — static brand copy, not backend-driven.

![About section](walkthrough-screenshots/08-landing-page/03-about.png)

### Visit — hours and map

The hours card pulls from the same `GET /public/business-hours` endpoint the reservation flow uses, so the displayed hours can never drift from what the reservation slot engine actually enforces (a static fallback string covers the rare case the request fails). "Visit us" expands an embedded map panel in place, with a link out to Google Maps.

![Visit section with map open](walkthrough-screenshots/08-landing-page/04-visit-hours-map.png)

### FAQ

Four static questions, including "Do you take reservations?" — answered "Yes — reserve a table online and we'll confirm it in real time," setting up the Reserve section below.

![FAQ section](walkthrough-screenshots/08-landing-page/05-faq.png)

### Reserve

A single "Reserve now" button — deliberately not a second reservation form. It links straight to `{customer-menu URL}/?reserve=1`, which deep-links into the *same* reservation flow documented in [Section 3](#3-customer-menu--qr-table-ordering), skipping Customer Menu's own welcome screen. There is one canonical reservation portal in the whole system, not a copy per app.

![Reserve section](walkthrough-screenshots/08-landing-page/06-reserve-cta.png)

### Contact

A general-inquiry form (Name, Email, Message). This one is **local-only** — submitting just flips the button to "Sent — arigato" client-side; there is no backend endpoint behind it and no email is actually sent. It's a placeholder for a future integration, not a live inquiry channel — don't rely on it operationally yet (see `LAUNCH_CHECKLIST.md`).

![Contact form](walkthrough-screenshots/08-landing-page/07-contact-form.png)

---

## 3. Customer Menu — QR Table Ordering

A table's QR code is just a static link to `customer-menu.../?table=N` — no app to install, no account to create. This section follows a real order from scan to kitchen ticket, then covers the reservation flow this same app hosts.

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

After tapping "Send to the counter," the whole screen becomes a receipt-styled order ticket. Note the "Hold: Sushi rice (raw)" line — the ingredient hold from Step 5 carried all the way through. The status badge (`PENDING`) polls automatically every 5 seconds until staff act on it in Pending Orders (Section 6).

![Order status / receipt](walkthrough-screenshots/01-customer-menu/08-order-status-receipt.png)

**What happens next:** nothing becomes a real sale until a staff member approves it in Pending Orders. Declining never touches inventory at all; approving runs the order through the *exact same* insert/deduction logic a POS sale uses.

### Reserving a table

This same app hosts the reservation flow — it isn't a separate site. There are two entry points:

- **No `?table=` param at all** (someone opens Customer Menu directly, not from a table's QR code): a welcome screen appears — "Scan the QR code on your table to order, or reserve a table for later" — with a "Reserve a Table" button.
- **The Landing Page's "Reserve now" link** (`?reserve=1`): skips the welcome screen and drops straight into the reservation form. This is the one canonical reservation portal in the system — the Landing Page doesn't run its own copy.

![Reservation entry — welcome screen](walkthrough-screenshots/01-customer-menu/09-reservation-welcome-choice.png)

**Party size, date, and time.** A stepper (default 2) and a date picker (can't pick a date before today) drive a live time-slot grid, computed by the backend's slot-availability engine (`SYSTEM_GUIDE.md` §3.15) — every 30-minute slot within business hours is checked against real table capacity and existing bookings for that exact window. A slot with no table free for that party size shows greyed-out and labeled "Full" rather than being hidden, so it's clear the restaurant just has no room right then, not that something's broken. If the chosen date falls on a closed weekday, the whole grid is replaced with "We're closed on this day — please pick another date."

![Party size, date, and time slots](walkthrough-screenshots/01-customer-menu/10-reservation-party-size-date-slots.png)

**Your details.** Picking a slot reveals Name, Phone, and an optional note field. "Request this table" is disabled until name and phone are filled in.

![Reservation details form](walkthrough-screenshots/01-customer-menu/11-reservation-details-form.png)

**Confirmation.** Submitting creates the reservation as `pending` — this already holds the slot exactly like a `confirmed` reservation would, so a second overlapping request made a moment later gets routed to a different table or rejected outright, not double-booked. The screen shows a reservation number, party size/date/time, and a status badge that polls automatically every 5 seconds until staff act on it in the Reservations tab ([Section 6](#6-command-suite-selling--kitchen)).

![Pending confirmation](walkthrough-screenshots/01-customer-menu/12-reservation-pending-confirmation.png)

Once staff confirm the request, the same screen updates in place — no reload needed — to "You're all set! Please arrive on time to hold your table."

![Confirmed reservation](walkthrough-screenshots/01-customer-menu/13-reservation-confirmed.png)

If staff decline instead, the screen shows the reason they gave and a "Book another table" button that resets the whole form. There is deliberately no customer-side cancel or edit — changes to an existing reservation are staff-initiated only.

---

## 4. Staff Clock — Kiosk Attendance

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

## 5. Roles & Access

Every staff account has exactly one role, and the dashboard's sidebar is the primary way each role's access differs. Backend `require_role` checks are the real enforcement layer — the sidebar is just the visible reflection of it.

### Employee

The front-of-house/back-of-house toolset: POS, Order Queue, Pending Orders, Kitchen Display, Reservations (the Requests tab in full; the Tables tab is visible but read-only — no Add-table button, no Edit button, and Active is shown as plain Yes/No text instead of a toggle), the full Stock counting tools (Recipe Ingredients, Station Items, Receive Shipment), Loss Log, Utility Log, and Settings.

![Employee sidebar](walkthrough-screenshots/03-roles/employee-sidebar.png)

### Manager

Everything an employee has, plus full CRUD on the Reservations' Tables tab (add/edit tables, toggle active), POS Management, the full HR/Payroll suite (Employees, HR Attendance, Payroll, Holiday Calendar, Payroll Settings), and the Stock group's oversight pages — Overview, Alerts, Variance Log.

![Manager sidebar](walkthrough-screenshots/03-roles/manager-sidebar.png)

### Executive

Full access: everything above, plus Command Center (the executive's landing page after login), Trend Analysis, Menu Editing, P&L, Oishii AI, and Help.

![Executive sidebar](walkthrough-screenshots/03-roles/executive-sidebar.png)

---

## 6. Command Suite: Selling & Kitchen

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

QR orders land here first, staged and unapproved. This is real data from the order placed in Section 3:

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

### Reservations

Sits in the sidebar right alongside the pages above — Reservations is visible to every role, not gated to managers/executives. Two tabs, both mounted at once so switching between them is instant and never re-fetches or loses in-progress work:

**Requests.** Filtered by status (Pending / Confirmed / Declined / Cancelled — defaults to Pending), polling on the same interval as the rest of the dashboard's live pages. Each pending request shows the party, assigned table, date/time, and contact info exactly as the customer entered it in [Section 3](#3-customer-menu--qr-table-ordering).

![Reservations — Requests tab](walkthrough-screenshots/04-pos-orders-kitchen/13-reservations-requests-panel.png)

**Confirm** simply flips the request to `confirmed`. **Decline** requires a reason — both the button and the backend reject an empty string — which is what the customer sees on their polling confirmation screen. A confirmed reservation can later be **Cancelled** (this frees its table+time slot for other bookings); a pending one cannot be cancelled directly, only confirmed or declined.

![Decline dialog — reason required](walkthrough-screenshots/04-pos-orders-kitchen/14-reservations-requests-decline-dialog.png)

**Tables.** The real table roster behind the availability engine — label, capacity, and an active toggle. Every role can see this list; only managers and executives get the "Add table" button and per-row "Edit," matching [Section 5](#5-roles--access)'s access rules.

![Reservations — Tables tab](walkthrough-screenshots/04-pos-orders-kitchen/16-reservations-tables-panel.png)

Adding or editing a table just takes a label and a capacity greater than 0 — this is the roster the slot-availability engine reads from, so a table marked inactive (or simply not created yet) can never be offered to a customer, which is exactly what kept the reservation flow from being demoable until a real table was activated here.

![Add/edit table dialog](walkthrough-screenshots/04-pos-orders-kitchen/17-reservations-tables-add-dialog.png)

---

## 7. Command Suite: Stock & Inventory Management

This is the deepest section of the walkthrough, per your request. The short version of the whole philosophy: **you no longer count everything by hand every day.** Every POS and QR sale already deducts its own recipe ingredients the instant the sale happens — correctly skipping anything a customer held — so physical counting is now a periodic accuracy check, not the primary way stock gets tracked. The two things a manual count could never see on its own (a held ingredient, extra usage during prep) are now captured directly at the point they happen, by the person who saw it happen (Sections 3, 6).

The whole Stock area lives under one collapsible sidebar group: **Overview → Recipe Ingredients → Station Items → Receive Shipment → Alerts → Variance Log.**

### 7.1 Recipe Ingredients — the count sheet

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

**Saving a count**: stock is set to exactly what was counted. Anything that came out different from Expected is permanently logged as a stock-count-adjustment movement (see Variance Log, 7.6) — an exact match logs nothing, since there's no discrepancy to record. If anything came up short, an optional follow-up dialog offers to log it as a loss so the cost is tracked. This is never automatic — a shortage might just be a miscount, so it's always the counter's call:

![Shrinkage follow-up dialog](walkthrough-screenshots/05-stock/07-recipe-ingredients-shrinkage-dialog.png)

**Nothing is ever lost mid-count.** Typing into the Counted column autosaves your unsaved entries to the browser as you go (nothing hits the server until you actually hit Save). If a tab closes or a device dies mid-count, reopening the page offers to restore exactly what you'd entered, with a timestamp so you know how stale the numbers might be:

![Draft restore](walkthrough-screenshots/05-stock/08-recipe-ingredients-draft-restore.png)

### 7.2 Station Items — everything without a recipe

The second tab covers the ~200 items on the client's original paper stock sheets that have *no* recipe at all — packaging, supplies, resale beverages — organized by physical station in the same New Stocks / Beginning / Usage / Ending format the paper sheets used:

![Station Items grid](walkthrough-screenshots/05-stock/09-station-items-grid.png)

Rows carried over from the original paper-sheet transcription as ambiguous are flagged **VERIFY** until a human confirms the mapping (none are currently flagged live in this data — every original flag from the 215-row seed has since been resolved through Manage Catalog, described below — but the mechanism is still active for any future ambiguous entry).

For the subset of station items that are *also* real recipe ingredients (tracked in both places), the live stock figure shown here is **read-only**, with a direct link to the one real place that edits it:

![Linked ingredient](walkthrough-screenshots/05-stock/11-station-items-linked-ingredient.png)

A free, client-side-only consistency check compares Beginning + New Stocks − Ending against the typed Usage figure — if they don't match, the Usage field flags a **Mismatch** with the expected value. No backend cost, purely a nudge:

![Mismatch warning](walkthrough-screenshots/05-stock/12-station-items-mismatch-warning.png)

### 7.3 Manage Catalog

A fifth sub-tab, visible only to managers/executives, lists every station item across all four stations in one place:

![Manage Catalog](walkthrough-screenshots/05-stock/13-station-items-manage-catalog.png)

Editing an item lets you change its name/category/unit/reorder threshold, and — critically — link it to a real ingredient. Linking is what makes a station item's Ending/New Stocks feed directly into that ingredient's real stock, the same mechanism Receive Shipment and Recipe Ingredients already use:

![Manage Catalog edit dialog](walkthrough-screenshots/05-stock/14-station-items-manage-catalog-edit.png)

### 7.4 Overview

A read-only landing page aggregating everything above into one glance: low-stock count, expiring-soon items, per-station verification counts, and recent movements — all real, aggregated data, zero fabricated figures:

![Stock Overview](walkthrough-screenshots/05-stock/15-stock-overview.png)

### 7.5 Alerts

A dedicated, filterable/sortable table combining every real low-stock, expiring, and verify-needed item in one place. Each row's "Count now" action deep-links straight to the right tab (and, for a station item, the right station) instead of leaving you to find it yourself:

![Stock Alerts](walkthrough-screenshots/05-stock/16-stock-alerts.png)

Filtering by type narrows the list instantly:

![Alerts filtered](walkthrough-screenshots/05-stock/17-stock-alerts-filtered.png)

### 7.6 Variance Log

A chronological, filterable reconciliation view combining two real data sources: loss records (spoilage/breakage/comp/shrinkage) and count-adjustment movements (the audit trail every non-matching count from 7.1 produces). Variance is signed (+overage / −shortage), cost impact is real where known, and "Recorded by" shows an actual employee name via a live join — not a raw ID:

![Variance Log](walkthrough-screenshots/05-stock/18-stock-variance-log.png)

No server-side date-range filter exists today — this reflects the most recent 50 records of each kind, not a full history search, and the page says so rather than implying otherwise.

---

## 8. Command Suite: Operations & Executive Pages

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

## 9. Command Suite: HR & Payroll

### Employees

Roster CRUD — name, role, department, position, pay rate, and setting a kiosk clock-in PIN (the same PIN used at the Staff Clock kiosk in Section 4):

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

## 10. Appendix: Architecture Reference

**Tech stack:** React 19 + Vite + TypeScript + Tailwind + shadcn/ui on every frontend (the Landing Page additionally prerenders at build time for SEO — see `SYSTEM_GUIDE.md` §3.16); FastAPI + Supabase/Postgres on the backend; all five apps deploy to Vercel on push to `main`. No websockets anywhere — every page that needs to feel "live" polls on an interval, by design.

**Backend surface:** 19 routers (`products`, `recipes`, `menu_admin`, `inventory`, `inventory_movements`, `stock_items`, `discounts`, `loss_records`, `hr`, `kiosk`, `transactions`, `utility_logs`, `digital_menu`, `dashboard_summary`, `analytics`, `pnl`, `oishi_ai`, `settings`, `reservations`). The `reservations` router serves both the public booking flow (`/public/*`, unauthenticated) and the staff review dashboard (`/tables`, `/reservations/*`, authenticated) from one module — see `services/api-fastapi/app/routers/reservations.py`.

**Access control, three layers:** Sidebar visibility (what a role is shown), in-page checks (what a role is blocked from if they navigate there directly), and backend `require_role` (the real, unbypassable boundary). Reservations is a case where a page is visible to every role but its *actions* are gated in-page — the Tables tab renders for everyone, but only managers/executives get working Add/Edit controls.

**Full technical detail:** `SYSTEM_GUIDE.md` (system-wide reference), `INVENTORY_SYSTEM_GUIDE.md` (inventory model), `SESSION_HANDOFF.md` and `PROGRESS.md` (build history).

---

*Screenshots captured against the live local development environment using real seeded data, plus one table (previously inactive test data, per `LAUNCH_CHECKLIST.md`) activated with a real capacity specifically so the reservation flow had a table to book against — left active afterward as a real record, consistent with how the rest of this system has been verified throughout its development. All other test data created during capture (the sample order, the sample POS sale, the sample reservation) was likewise left in place as real records — nothing here is staged or faked. The one exception, noted inline, is the two ingredients whose stock was intentionally over/undercounted to demonstrate the variance states in Section 7.1 — both were reverted to their original values immediately after capture.*
