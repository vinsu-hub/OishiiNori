# Oishii Nori — Inventory Management Guide

**Audience:** kitchen staff, cashiers, managers, executives
**Last updated:** 2026-08-24 (this update: Inventory Count and Stock Count (Stations) are now one page — **Stock**, with a Recipe Ingredients tab and a Station Items tab — plus automatic low-stock alerts and count-entry autosave; see sections 2 and 4)

This guide explains how inventory now works in the Oishii Nori Command Suite — what the system already tracks automatically, and the few manual touchpoints that remain. The short version: **you no longer need to count every ingredient by hand every day.** The system watches stock levels continuously as sales happen, and manual counting is now a periodic accuracy check, not the primary way stock gets tracked.

---

## 1. The old way vs. the new way

**Old way (fully manual):** someone walks every station once a day with a paper sheet, writes down New Stocks / Beginning / Usage / Ending for every single item, and that's the only record of what's in stock. Mistakes during prep (extra egg, dropped roll, wrong portion) never get recorded anywhere — they just show up later as an unexplained gap between what the sheet says and what's actually on the shelf.

**New way (mostly automatic):** every sale run through POS Terminal or the customer QR menu already knows the recipe for what was sold, so the system deducts the exact ingredients used **the moment the sale happens** — no one has to write anything down for that to happen. The two things a manual count could never see on its own — a customer asking to hold an ingredient, and staff using more than the recipe calls for — are now captured directly at the point they happen, by the person who saw it happen. Physical counting still exists, but its job has shifted: it's a periodic accuracy check (and the only tracking method for things that have no recipe, like packaging and resale drinks), not the day's main event.

---

## 2. What happens automatically (you don't have to do anything)

### Every sale deducts its own ingredients
When an order is rung up on **POS Terminal** or approved from the **QR customer menu**, the system looks up that product's recipe and subtracts the exact quantity of each ingredient from stock — automatically, in real time. Voiding a sale restores exactly what was deducted, no more and no less. You will never need to manually subtract stock for a normal sale.

### Holding an ingredient means it's never deducted
If a customer asks to hold an ingredient (e.g., "no cucumber"), check the box for it in POS Terminal's order editor. That ingredient is excluded from the automatic deduction entirely — the system knows it was never actually used, so it doesn't touch that ingredient's stock at all. This also applies symmetrically to QR/digital orders and to voids: whatever was held is never deducted, and never needs to be "restored" either, since it was never touched.

> Why this matters: before this was wired up correctly, a held ingredient still got silently deducted every time — creating fake shrinkage that only ever showed up later as an unexplained gap during a manual count, with no way to trace where it came from. Now the system's own sales data is accurate at the source, so there's nothing left to "explain away" later.

### Bundles (Sushi Boat and similar) work differently
Bundle products don't have their own recipe — kitchen staff log which specific rolls fulfilled the bundle from **Kitchen Display**'s "Log rolls used" checklist, and *those* rolls' own recipes are what actually gets deducted.

### Low stock shows up on its own — you don't have to go looking for it
Anything at or below its reorder threshold — recipe ingredients or station items — now shows as a red count badge next to **Stock** in the sidebar, and as a **Low Stock** card on the Home page for non-executive roles (executives already see the full breakdown on Command Center). You no longer need to open Stock and scan the table to notice something's running low; if the badge is there, something needs reordering.

### An in-progress count is never lost
Typing counts into either tab of **Stock** now autosaves your unsaved entries in the browser as you go (nothing is sent to the server until you actually hit Save). If a tab gets closed, the device loses power, or you get pulled away mid-count, reopening the page offers to restore what you'd entered, with a note on when it was saved — just double-check the numbers still look right before saving, since stock may have moved in the meantime.

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

Physical counting still covers two genuinely different jobs — recipe ingredients that drive food cost, and everything else that doesn't have a recipe at all. They now live as **two tabs on one page, Stock**, instead of two separate sidebar items, since staff are doing the same basic task (walk around, count what's there) either way. Which tab you want depends on *what* you're counting, not a different page to remember.

### Stock → Recipe Ingredients tab — the source of truth for recipe ingredients
**Who:** everyone can log a count; only manager/executive can edit an ingredient's other fields.
**What it's for:** the definitive place to correct a recipe ingredient's stock level after a physical spot-check, and to edit fields like base unit, category, or reorder threshold.
**When to use it:** periodically (not necessarily daily anymore), or whenever something looks off and you want to reconcile the system's running total against what's physically on the shelf.

### Stock → Station Items tab — for everything that isn't a recipe ingredient
**Who:** everyone can log a count; manager/executive manage the catalog (adding/editing items) via the tab's own **Manage Catalog** sub-tab.
**What it's for:** the ~200 items on the client's real paper stock sheets that have no recipe at all — packaging, supplies, resale beverages — organized by physical station (Tako-Snack, Cafe-Drinks, Sushi-Kitchen Main, Ramen-Hot Line) in the same New Stocks / Beginning / Usage / Ending format as the old paper sheets.
**Important:** for the small set of items that are *also* real recipe ingredients (tracked in both places), the Station Items tab shows that item's live stock as **read-only** with an "Edit in Recipe Ingredients →" link that jumps straight to the other tab — the Recipe Ingredients tab is the single place that actually edits that number. This isn't two competing systems doing the same job; it avoids exactly that. Beginning/Usage/Notes/Flag-for-verification stay editable everywhere, since those are informational and don't change the tracked stock figure.

Both tabs stay loaded once you've opened them, so switching back and forth to cross-check something doesn't lose your in-progress count or re-fetch from scratch.

**Receive Shipment** is the third piece of this: logging a delivery here adds directly to a recipe ingredient's stock (and its own audit trail) — the same mechanism the Station Items tab's "New Stocks" field uses under the hood for a linked item.

---

## 5. Putting it together: a manager's daily/weekly rhythm now

- **Continuously, no action needed:** every POS and QR sale deducts recipe ingredients automatically, correctly skipping anything a customer held.
- **As it happens, one click:** if kitchen staff use more of an ingredient than the recipe calls for, they log it from Kitchen Display right then — no waiting for count day to discover it.
- **As it happens, standalone:** spoilage, breakage, comps, and shrinkage noticed off the kitchen board get logged in Loss Log.
- **On delivery:** log what came in via Receive Shipment.
- **Periodically (not daily):** run Stock's Recipe Ingredients tab as a spot-check/reconciliation for recipe ingredients, and its Station Items tab per station for packaging/supplies/resale items that have no other tracking mechanism.
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
| Count packaging/supplies/resale items by station | Stock → Station Items tab | everyone (manage catalog: manager/executive) |
| Edit ingredient base unit, category, reorder threshold | Stock → Recipe Ingredients tab → Edit | manager/executive |
| See what's running low before it becomes a problem | Sidebar badge / Home card (any page); full detail on Command Center | everyone (detail: executive) |
| Change the VAT rate | Settings → Business Settings | executive |
| See true food cost (COGS) from all of the above | P&L | executive |

Note: `/inventory-count` and `/stock-count` still work as direct links — they open Stock on the matching tab — but the sidebar now only shows the one **Stock** entry.
