# Oishii Nori Command Suite — Feature List

A flat, scannable list of everything the system does. For *how to use*
each page see `WALKTHROUGH.md`; for the *page/role map* see
`SYSTEM_GUIDE.md`. This file just answers "what can it do."

---

## POS & Checkout

- Product/size grid with large, tablet-friendly category pills; search;
  Available/Low Stock/Unavailable filters; grid or list view.
- Dine In (table picker, high-visibility red control, guest count) and
  Takeout order types.
- Cart with per-line quantity, add-ons, and an ingredient-hold editor
  ("no cucumber") that skips deduction entirely rather than
  deduct-then-restore.
- Discounts (name, %, VAT-exempt flag), managed from POS Management.
- Independent **VAT / Non-VAT** toggle — books an order non-VAT even with
  no VAT-exempt discount applied.
- Payment methods: Cash, GCash, Card (prompts Debit/Credit before
  accepting), Split.
- **Owner's Request** — manager/executive PIN re-verification for
  overrides (e.g. a manual discount).
- **Held Orders** (park a cart, resume later) and **Favorites** (star
  frequent items).
- Upsell rail — up to 6 not-in-cart suggestions.
- **Offline resilience** — a failed Charge from a real network drop
  queues locally and auto-syncs once back online.
- **Start/End Business Day** — a header control that locks POS until the
  cashier's own kiosk credentials confirm the day started; closing is
  one-way per calendar day. **Executives are exempt from this lock.**
- Reservation-aware: a table with a live confirmed reservation shows
  Reserved and blocks Charge until a manager PIN override.

## Kitchen & Order Lifecycle

- Kitchen Display: 5 real stations, queued → preparing → ready →
  completed (strict forward-only), stat cards, sound alert on new orders.
- Bundle fulfillment ("Log rolls used") — a bundle's real ingredient
  consumption is only known once the kitchen logs which specific rolls
  went into it.
- "Log extra usage" — record using more of an ingredient than the recipe
  calls for, right at the point of the mistake.
- Order Queue: every transaction, live status badges, search/filters,
  sound alert on "ready."
- **Void** (queued orders only) restores exactly the stock it deducted.
- **Refund Approval** (WS-12) — for a `preparing`/`ready` order past the
  point of self-service void, a cashier files a refund request; a
  manager/executive approves (performs the real void/stock-restore) or
  rejects. A fully `completed` order can't be touched by either path.
- Human-friendly, per-day sequential order numbers (resets daily).

## Delivery & Pickup (WS-7/WS-8)

- Customer Menu's general link (no `?table=` param) offers **Delivery**
  or **Pickup** instead of dine-in.
- Delivery fee lookup by barangay (26 Santa Cruz, Laguna barangays
  seeded).
- **Delivery Requests** page — staff view of delivery orders.
- **Online Orders** page (manager/executive) — every channel (dine-in QR,
  delivery, pickup) in one view.
- **Rider** role — its own minimal sidebar, a Delivery panel with a
  Google Maps pin link to the drop-off address, marks a delivery done.

## Customer-Facing Ordering

- QR table ordering — no login, browse by category, hold an ingredient,
  add-ons, submit for staff approval (not charged in-app).
- Table reservation form from the same app.
- **Pending Orders** — staff approval queue; Approve converts a QR order
  into a real transaction (auto-flows into Kitchen Display); Decline
  requires a reason and never touches inventory.

## Stock & Inventory

- Sale-driven automatic deduction for both recipe ingredients and
  non-recipe station items (packaging, supplies, resale drinks) — no
  manual daily counting required.
- **Ingredient Stock** — base unit, category, reorder threshold, editable
  fields with a recipe-usage warning before a unit change.
- **Station Items** — computed New Stocks/Beginning/Usage/Ending, per-item
  consumption rules (per-unit or per-transaction, optionally scoped by
  order type/guest count), flag-to-correct (never a silent overwrite).
- **Overview** — low-stock/expiring/verify-needed stat tiles, by-station
  breakdown, recent movements.
- **Alerts** — every real low-stock/expiring/verify-needed item, one
  filterable table, deliberately no snooze/dismiss.
- **Variance Log** — chronological loss + count-adjustment history with
  signed variance and real cost impact.
- **Receive Shipment** — log deliveries (quantity, unit cost, expiry).
- **Loss Log** / **Utility Log** — spoilage/breakage/comp/shrinkage not
  tied to a kitchen order; utility meter readings with computed cost.
- **EOD Stock Count (VS)** — end-of-day physical verification sheet.

## Reservations & Floor Plan

- Requests tab (Pending/Confirmed/Declined/Cancelled), live polling.
- **Floor Plan** — tables as positioned, color-coded shapes (free /
  order-or-reservation active / overdue), drag-and-drop layout editor
  (shape/zone/capacity, incl. bench-seating min–max ranges), click-to-seat
  hands off straight to POS.
- A confirmed reservation blocks its table in POS for
  `[start − prep buffer, end)`; a manager PIN override clears it, logged
  to `reservation_overrides`.

## HR & Payroll

- **Staff Clock** — shared kiosk, Employee Number + PIN, auto-resets
  after 30s idle, offline-queues a punch if the device loses connection.
- **Employees** — profiles, kiosk PIN reset, role assignment (employee,
  manager, executive, stocker, rider).
- **Payroll** — generate a run for a period, preview, PDF payslips
  (single or bulk ZIP).
- **Holiday Calendar** / **Payroll Settings** — holiday dates and
  pay-rate rules that generation calculates against.

## Executive Tools

- **Command Center** — same-day rollup (revenue, discounts, tax, losses,
  low-stock, utility cost, department split, staff clocked-in estimate).
- **P&L Dashboard** — Today/Week/Month, revenue, gross/net profit, food
  cost %, flags data gaps (missing bundle rolls-used, missing ingredient
  costs) rather than hiding them.
- **Trend Analysis** — date-range sales trend + top-sellers table.
- **Menu Editing** — items, per-size pricing, recipes, photos; deactivate
  (not delete) to retire an item without breaking sales history.
- **Business Day Report** — per-day cash-register vs. system-EOD
  variance review.
- **Oishii AI** — answers grounded in real live data (revenue, best
  sellers, loss drivers, stock levels, payroll/pay-rate questions).

## Business Day Cycle (WS-13)

- One row per PH calendar date; POS is locked until it's opened with the
  cashier's own kiosk credentials.
- End-of-Day records a counted cash-register total; the system's own EOD
  total is computed but never shown to a non-manager/executive.
- Closing is one-way — a closed day can't be reopened.
- Executives bypass the lock entirely (both the UI overlay and the
  backend check).

## Roles & Accounts

- Five roles: employee, manager, executive, stocker, rider — each with
  its own sidebar scope.
- Kiosk PIN (bcrypt-hashed) is separate from the dashboard login
  password, shared across Owner's Request, reservation overrides,
  Business Day, and the Staff Clock kiosk.
- A credential mismatch (entering a different account's number/PIN than
  whoever's logged in) surfaces a clear explanatory dialog, not a generic
  error.

## Public / Marketing

- **Landing Page** — server-prerendered, real menu/hours baked into the
  shipped HTML for search/AI-crawler visibility; hero, live best-sellers
  (photographed items only), about, hours/map, FAQ, reservation link.

## Reliability

- Retries once on a transient Supabase connection blip (both at the HTTP
  transport layer and in the auth layer) rather than surfacing a false
  500 or a misleading "invalid token" 401.
- 20s client timeout (vs. the 5s default) to absorb a Vercel cold start
  reaching a cold Supabase connection.
