# Oishii Nori — Inventory Management Guide

**Audience:** kitchen staff, cashiers, managers, executives
**Last updated:** 2026-08-25 (this update: Station Items' New Stocks/Beginning/Usage/Ending are now auto-computed from sales, deliveries, and losses — the same automation Recipe Ingredients already had — with a per-field "flag as wrong" correction instead of manual typing; see sections 2 and 4)

This guide explains how inventory now works in the Oishii Nori Command Suite — what the system already tracks automatically, and the few manual touchpoints that remain. The short version: **you no longer need to count every ingredient by hand every day.** The system watches stock levels continuously as sales happen, and manual counting is now a periodic accuracy check, not the primary way stock gets tracked.

---

## 1. The old way vs. the new way

**Old way (fully manual):** someone walks every station once a day with a paper sheet, writes down New Stocks / Beginning / Usage / Ending for every single item, and that's the only record of what's in stock. Mistakes during prep (extra egg, dropped roll, wrong portion) never get recorded anywhere — they just show up later as an unexplained gap between what the sheet says and what's actually on the shelf.

**New way (mostly automatic):** every sale run through POS Terminal or the customer QR menu already knows the recipe for what was sold, so the system deducts the exact ingredients used **the moment the sale happens** — no one has to write anything down for that to happen. The two things a manual count could never see on its own — a customer asking to hold an ingredient, and staff using more than the recipe calls for — are now captured directly at the point they happen, by the person who saw it happen. Physical counting still exists, but its job has shifted: it's a periodic accuracy check, not the day's main event.

**Station Items got the same treatment.** Packaging, supplies, and resale drinks never had a recipe to auto-deduct from, so until now their New Stocks/Beginning/Usage/Ending sheet was still a blank form someone filled in by hand every day. It now works the same way Recipe Ingredients does: a **consumption rule** (set up once, in Manage Catalog) tells the system how much of an item a sale uses — either per unit of a specific product sold (a can of Coke) or once per transaction (a takeout box, optionally scaled by guest count) — and every sale, delivery, and logged loss auto-fills all four numbers. Staff now review an already-completed list instead of typing it from scratch, and only touch a field by flagging it wrong.

---

## 2. What happens automatically (you don't have to do anything)

### Every sale deducts its own ingredients
When an order is rung up on **POS Terminal** or approved from the **QR customer menu**, the system looks up that product's recipe and subtracts the exact quantity of each ingredient from stock — automatically, in real time. Voiding a sale restores exactly what was deducted, no more and no less. You will never need to manually subtract stock for a normal sale.

### Holding an ingredient means it's never deducted
If a customer asks to hold an ingredient (e.g., "no cucumber"), check the box for it in POS Terminal's order editor. That ingredient is excluded from the automatic deduction entirely — the system knows it was never actually used, so it doesn't touch that ingredient's stock at all. This also applies symmetrically to QR/digital orders and to voids: whatever was held is never deducted, and never needs to be "restored" either, since it was never touched.

> Why this matters: before this was wired up correctly, a held ingredient still got silently deducted every time — creating fake shrinkage that only ever showed up later as an unexplained gap during a manual count, with no way to trace where it came from. Now the system's own sales data is accurate at the source, so there's nothing left to "explain away" later.

### Station Items fill themselves in the same way
Once a consumption rule exists for an item (see section 4), a sale of the linked product deducts it automatically — no different from a recipe ingredient. Voiding the sale restores it. A logged delivery (Receive Shipment) counts as that day's New Stocks; a logged loss counts as Usage. Beginning carries forward from yesterday's computed Ending. You'll only ever type a number here by flagging a field as wrong.

### Bundles (Sushi Boat and similar) work differently
Bundle products don't have their own recipe — kitchen staff log which specific rolls fulfilled the bundle from **Kitchen Display**'s "Log rolls used" checklist, and *those* rolls' own recipes are what actually gets deducted.

### Low stock shows up on its own — you don't have to go looking for it
Anything at or below its reorder threshold — recipe ingredients or station items — now shows as a red count badge next to **Stock** in the sidebar, and as a **Low Stock** card on the Home page for non-executive roles (executives already see the full breakdown on Command Center). You no longer need to open Stock and scan the table to notice something's running low; if the badge is there, something needs reordering.

### An in-progress count is never lost
Typing a count into the Recipe Ingredients tab still autosaves your unsaved entries in the browser as you go (nothing is sent to the server until you actually hit Save). If a tab gets closed, the device loses power, or you get pulled away mid-count, reopening the page offers to restore what you'd entered, with a note on when it was saved — just double-check the numbers still look right before saving, since stock may have moved in the meantime. Station Items has nothing left to lose mid-typing this way — its four numbers are computed, not typed — but a flag/correction and its reason are saved to the server the moment you submit them, same as any other Stock action.

---

## 3. What you log yourself (takes seconds, right where the moment happens)

### Log Extra Usage — for when prep goes over the recipe
Recipes assume a standard amount per serving. If staff actually use more than that — an extra egg, a bit more mayo, whatever — that's information the system doesn't know unless someone tells it.

**Where:** Kitchen Display → next to any (non-bundle) item on an order card, click **"Log extra usage."**

**How:**
1. A dialog opens showing that product's recipe ingredients.
2. Pick the ingredient that ran over.
3. Enter the extra quantity used (in the ingredient's own unit).
4. Pick a reason (defaults to **Prep error**; also available: spoilage, breakage, comp, shrinkage).
5. Submit.

That's it — stock is deducted for the extra amount immediately, and it shows up in **Loss Log** with your name, the ingredient, the reason, and the cost impact. This is the same underlying capability as the standalone Loss Log page — the Kitchen Display shortcut just puts it one click away from where the mistake actually happens, instead of requiring a trip to a different page later (when it's easy to forget).

**Loss Log** itself is still there for anything that isn't tied to a specific order on the kitchen board — spoilage discovered in the walk-in, breakage, comps, or shrinkage noticed during a count.

---

## 4. What still needs a physical count — and why

Physical counting still covers two genuinely different jobs — recipe ingredients that drive food cost, and everything else that doesn't have a recipe at all. They now live as **two tabs on one page, Stock**, instead of two separate sidebar items, since staff are doing the same basic task (spot-check what's there) either way. Which tab you want depends on *what* you're checking, not a different page to remember.

### Stock → Recipe Ingredients tab — the source of truth for recipe ingredients
**Who:** everyone can log a count; only manager/executive can edit an ingredient's other fields.
**What it's for:** the definitive place to correct a recipe ingredient's stock level after a physical spot-check, and to edit fields like base unit, category, or reorder threshold.
**When to use it:** periodically (not necessarily daily anymore), or whenever something looks off and you want to reconcile the system's running total against what's physically on the shelf.

### Stock → Station Items tab — an already-done list, not a blank form
**Who:** everyone can review and flag a field, or log a loss; manager/executive manage the catalog and set up **Consumption Rules** via the tab's own **Manage Catalog** sub-tab.
**What it's for:** the ~200 items on the client's real paper stock sheets that have no recipe at all — packaging, supplies, resale beverages — organized by physical station (Tako-Snack, Cafe-Drinks, Sushi-Kitchen Main, Ramen-Hot Line).

**How the four numbers get filled in now:**
- **New Stocks** sums that item's deliveries logged today (via Receive Shipment).
- **Beginning** carries forward from yesterday's computed Ending (or, on an item's first day, backs into a consistent number from the live stock).
- **Usage** sums that item's sales (via its consumption rule — see below) plus any logged losses.
- **Ending** is the item's live running stock — the same number the other three are built from, so all four are always consistent with each other.

**Setting up a consumption rule (Manage Catalog → Consumption Rules, manager/executive):** this is what tells the system a sale should deduct this item at all — without one, a station item's Usage just stays at 0 no matter how many are sold, same as a product with no recipe. Two shapes:
- **Per product sold** — e.g. "1 can deducted per Coke sold." Pick the exact product and size.
- **Per transaction** — e.g. "1 box deducted per takeout order," optionally scoped to dine-in or takeout only, and optionally scaled by guest count (for napkins, chopsticks, etc.).

A rule can be switched active/inactive or deleted at any time; populating real rules for all ~200 items is expected to happen gradually, not all at once — an item with no rule yet just shows Usage = 0 and needs a manual **Log Loss** or flag if something moved anyway.

**Flagging a field as wrong:** each of the four numbers has a small flag icon. Click it, enter the corrected value and a reason (required), and save — this writes a real audited correction (same underlying mechanism as a Recipe Ingredients count-adjustment), not a silent overwrite. A flagged field shows the correction and its reason right in the grid, and shows up in Variance Log too.

**Log Loss:** each row has its own Log Loss action — spoilage, breakage, comps, or shrinkage for that specific item, same reasons as the standalone Loss Log page, deducted immediately.

**Important:** for the small set of items that are *also* real recipe ingredients (tracked in both places), a flag/correction on New Stocks or Ending routes through to that same ingredient's real stock number — the Recipe Ingredients tab is still the single place that number ultimately lives; Station Items just gives it a station-organized view. This isn't two competing systems doing the same job; it avoids exactly that.

**Receive Shipment** is the fourth piece of this: logging a delivery there adds directly to an item's stock (and its own audit trail) — for an unlinked station item, it's the only way New Stocks gets real delivery data to sum, so its picker covers both recipe ingredients and unlinked station items.

---

## 5. Putting it together: a manager's daily/weekly rhythm now

- **Continuously, no action needed:** every POS and QR sale deducts recipe ingredients automatically, correctly skipping anything a customer held.
- **As it happens, one click:** if kitchen staff use more of an ingredient than the recipe calls for, they log it from Kitchen Display right then — no waiting for count day to discover it.
- **As it happens, standalone:** spoilage, breakage, comps, and shrinkage noticed off the kitchen board get logged in Loss Log.
- **On delivery:** log what came in via Receive Shipment.
- **Periodically (not daily):** run Stock's Recipe Ingredients tab as a spot-check/reconciliation. Station Items no longer needs a walk-and-count at all — review its per-station list and flag anything that looks wrong.
- **Proactively, no action needed:** a red badge next to Stock in the sidebar (and a card on Home) tells you when something's hit its reorder threshold, in either tab, before you'd otherwise notice.
- **As needed:** adjust an ingredient's base unit, category, reorder threshold, or the VAT rate from the Recipe Ingredients tab's edit dialog / Settings — executive-only, since these affect how the whole system computes cost and tax.

The net effect: the system's own numbers are trustworthy enough, day to day, that a full manual walk-the-building count is no longer the thing making inventory accurate — it's a periodic check on top of numbers that are already mostly right.

---

## 6. Quick reference — where everything lives

| Task | Page | Who |
|---|---|---|
| Ring up a sale (auto-deducts stock) | POS Terminal | everyone |
| Hold an ingredient on an order | POS Terminal (order editor) | everyone |
| Approve a QR/digital order (auto-deducts stock) | Pending Orders | everyone |
| Log rolls used for a bundle | Kitchen Display | everyone |
| Log extra ingredient usage during prep | Kitchen Display ("Log extra usage") | everyone |
| Log spoilage/breakage/comp/shrinkage | Loss Log | everyone |
| Log a delivery | Receive Shipment | everyone |
| Spot-check/correct a recipe ingredient's stock | Stock → Recipe Ingredients tab | everyone (edit fields: manager/executive) |
| Review auto-filled packaging/supplies/resale stock by station | Stock → Station Items tab | everyone |
| Flag/correct a Station Items field | Stock → Station Items tab (flag icon) | everyone |
| Log a loss for a station item | Stock → Station Items tab ("Log Loss") | everyone |
| Set up a sale-deduction rule for a station item | Stock → Station Items → Manage Catalog → Consumption Rules | manager/executive |
| Edit ingredient base unit, category, reorder threshold | Stock → Recipe Ingredients tab → Edit | manager/executive |
| See what's running low before it becomes a problem | Sidebar badge / Home card (any page); full detail on Command Center | everyone (detail: executive) |
| Change the VAT rate | Settings → Business Settings | executive |
| See true food cost (COGS) from all of the above | P&L | executive |

Note: `/inventory-count` and `/stock-count` still work as direct links — they open Stock on the matching tab — but the sidebar now only shows the one **Stock** entry.
