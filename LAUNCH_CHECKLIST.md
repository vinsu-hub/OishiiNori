# Launch Checklist — before opening for real business

The system itself is functionally complete (see `SYSTEM_GUIDE.md`), but the **data in it right now is mostly development/QA data**, not real business data. This is a checklist of what to fix before the restaurant actually relies on this system for a live shift — not a list of missing features.

Every count below was pulled live from production (`oishii-nori-api.vercel.app`) on 2026-08-25 — re-check them yourself before opening if time has passed, since the numbers will have moved as items get filled in.

---

## 1. Menu photos — 35 of 52 products have no photo

Real product photos exist for only 17 of the 52 active menu items (mostly Baked Sushi, Ramen, and Torched Maki). Everywhere a photo is missing, the system falls back to a plain numbered placeholder tile — functional, but not what you want customers or Google seeing.

- **Where to fix it:** dashboard-web → Menu Editing (executive only) → upload a real photo per product.
- **Why it matters beyond POS/Customer Menu:** the Landing Page's "best sellers" section only ever shows *photographed* items (by design — an unphotographed item can't be a visual pick), so categories with zero photos today (Cafe drinks, Maki & Gyoza Platters, Oishii Maki Rolls, Oishii Platter, Rice Meals besides Cheesy Katsu) are **entirely absent** from the public marketing page's menu grid until photographed.

## 2. Ingredient unit costs — 70 of 73 ingredients have no cost entered

`unit_cost` drives COGS/food-cost-% on the P&L Dashboard and the recipe-cost math behind it. With 70 of 73 ingredients still null, P&L numbers today are not meaningful — COGS is effectively $0 for almost everything.

- **Where to fix it:** dashboard-web → Stock → Recipe Ingredients → Edit, per ingredient. (`unit_cost` gets set automatically going forward once a delivery is logged with a cost via Receive Shipment — but the *existing* 70 need a first value entered manually.)

## 3. Stock counts — reconcile before opening, don't trust the current numbers

`current_stock` for all 73 ingredients reflects months of development/testing activity (POS test sales, voided transactions, QA scripts), not a real physical count. None of it is negative or obviously broken, but none of it should be trusted as-is either.

- **Do a real physical count** on Recipe Ingredients and Station Items (Stock sidebar group) the morning you open, so the running totals start from ground truth. After that, the system tracks deductions automatically — this is a one-time reset, not an ongoing chore.

## 4. Station Items consumption rules — none are set up yet

Station Items' Usage now auto-fills from sales the same way Recipe Ingredients does, but only for an item that has a **consumption rule** (Stock → Station Items → Manage Catalog → Consumption Rules). Right now, zero of the ~200 items have one — every station item's Usage will show 0 no matter how many sell, until a rule tells the system what a sale actually consumes.

- **Where to fix it:** dashboard-web → Stock → Station Items → Manage Catalog, per item — pick "per product sold" (e.g. 1 can per Coke) or "per transaction" (e.g. 1 box per takeout order) and set the quantity.
- This is expected to happen gradually as the client works through the real ~200-item list, not all before day one — an item with no rule yet just needs a manual **Log Loss**/flag entry if something moves, same as before this automation existed.

## 5. Reservation tables — verify the seeded roster on-site

The `tables` roster was seeded on 2026-08-29 with 12 tables (Booth 1–4 + Table 1–7 + Round 1, POS numbers 1–12) estimated from two on-site photos — **every one is flagged "not verified on-site."** Reservations and the floor plan work, but positions, zones, and capacities are guesses.

- **Where to fix it:** dashboard-web → Reservations → **Floor Plan** tab → **Edit Layout** (manager/executive). Walk the physical room: drag each table to where it actually is, confirm its zone (Booth Row / Main Dining), and set its real capacity (a single number, or a min–max range for the benches). Saving a table clears its unverified flag. Confirm the round table's real seat count and whether Booth 4 is a bench or fixed chairs. Also set each table's **POS table number** to whatever the staff actually call it, so the POS reservation-block matches.
- Two inactive rows (`QA-FloorPlan`, `QA-POS-Block`) are leftover verification-script scratch tables; they're deactivated and never shown to staff, and can't be deleted because past test reservations reference them. Leave them or have a developer clean them up — they don't affect operation.

## 6. Business hours — confirm they're actually correct

Currently set to **10:00 AM – 10:00 PM, every day, no closed days** (`Settings` → Business Hours, executive-only). This gates both the reservation system and the Landing Page's displayed hours — if this doesn't match reality, fix it before launch, not after the first wrong reservation comes in.

## 7. Landing Page footer — placeholder contact info

`apps/landing-page`'s footer currently has:
- A fake phone number (`+63 000 000 0000`)
- A generic `instagram.com` link, not a real handle

These also feed the page's `Restaurant` structured data (JSON-LD) that search engines and AI answer engines read — wrong/fake contact info there actively hurts local SEO trust signals (NAP consistency), it's not just cosmetic. Provide the real phone number and Instagram handle and these get swapped in.

## 8. Remove test/QA accounts from the employee roster

Five non-real accounts are currently in the system alongside the 6 real staff members (Ana Reyes, Juan Dela Cruz, Liza Fernandez, Maria Santos, Mark Villanueva, Rico Bautista):

- `Admin` (executive), `QA Employee`, `QA Executive`, `QA Manager`, `Test Executive` — all ₱0 pay rate, no real position.

These are harmless to leave (they'll just sit at ₱0 in payroll runs), but they're login-capable accounts with no real owner and will clutter Employees/HR Attendance/Payroll reports. Deactivate or remove them via Employees (manager/executive) before real staff start using the system day to day.

## 9. Staff login credentials — review before real use

Every seeded/test account uses this project's known development defaults (a shared default password and a shared default PIN, set at account-creation time). Before real staff start relying on these accounts for POS/payroll access, have each real employee set their own real password and kiosk PIN rather than continuing to use the defaults they were created with.

## 10. Outside this codebase: Google Business Profile

Not something any of this can set up automatically — a free Google Business Profile listing (separate from this system, needs the restaurant's own Google account) is typically the single highest-impact local-SEO lever for a physical restaurant, well beyond what on-page work alone can achieve. Recommended before/alongside launch, not required for the system itself to function.

## 11. Vercel: finish wiring the Landing Page's short domain

`https://oishii-nori-landing.vercel.app` currently needs to be manually re-pointed after every deploy (it's an ad-hoc alias, not a real project Domain). One-time fix: Vercel dashboard → `oishii-nori-landing` project → Settings → Domains → add `oishii-nori-landing.vercel.app` as a proper domain. Until then, `https://oishii-nori-landing-vince-tamis.vercel.app` always resolves correctly and can be used/shared safely in the meantime.

---

None of the above blocks using the system for further development, testing, or a soft/staff-only trial run — it only matters for the day real customers and real money start flowing through it.
