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

## 4. Reservation tables — zero active tables right now

The `tables` roster currently has 5 entries, all inactive, all leftover from feature testing (`Table 1`, `Table 2`, `Table 3`, `VIP Table 1`, plus one more). **No reservation can be confirmed until at least one table is active** — the availability engine has nothing to assign a party to.

- **Where to fix it:** dashboard-web → Reservations → Tables tab (manager/executive). Either repurpose the existing test rows (rename, set the real capacity, toggle active) or add fresh ones — either way, make sure the final active roster matches your actual floor plan and seat counts.

## 5. Business hours — confirm they're actually correct

Currently set to **10:00 AM – 10:00 PM, every day, no closed days** (`Settings` → Business Hours, executive-only). This gates both the reservation system and the Landing Page's displayed hours — if this doesn't match reality, fix it before launch, not after the first wrong reservation comes in.

## 6. Landing Page footer — placeholder contact info

`apps/landing-page`'s footer currently has:
- A fake phone number (`+63 000 000 0000`)
- A generic `instagram.com` link, not a real handle

These also feed the page's `Restaurant` structured data (JSON-LD) that search engines and AI answer engines read — wrong/fake contact info there actively hurts local SEO trust signals (NAP consistency), it's not just cosmetic. Provide the real phone number and Instagram handle and these get swapped in.

## 7. Remove test/QA accounts from the employee roster

Five non-real accounts are currently in the system alongside the 6 real staff members (Ana Reyes, Juan Dela Cruz, Liza Fernandez, Maria Santos, Mark Villanueva, Rico Bautista):

- `Admin` (executive), `QA Employee`, `QA Executive`, `QA Manager`, `Test Executive` — all ₱0 pay rate, no real position.

These are harmless to leave (they'll just sit at ₱0 in payroll runs), but they're login-capable accounts with no real owner and will clutter Employees/HR Attendance/Payroll reports. Deactivate or remove them via Employees (manager/executive) before real staff start using the system day to day.

## 8. Staff login credentials — review before real use

Every seeded/test account uses this project's known development defaults (a shared default password and a shared default PIN, set at account-creation time). Before real staff start relying on these accounts for POS/payroll access, have each real employee set their own real password and kiosk PIN rather than continuing to use the defaults they were created with.

## 9. Outside this codebase: Google Business Profile

Not something any of this can set up automatically — a free Google Business Profile listing (separate from this system, needs the restaurant's own Google account) is typically the single highest-impact local-SEO lever for a physical restaurant, well beyond what on-page work alone can achieve. Recommended before/alongside launch, not required for the system itself to function.

## 10. Vercel: finish wiring the Landing Page's short domain

`https://oishii-nori-landing.vercel.app` currently needs to be manually re-pointed after every deploy (it's an ad-hoc alias, not a real project Domain). One-time fix: Vercel dashboard → `oishii-nori-landing` project → Settings → Domains → add `oishii-nori-landing.vercel.app` as a proper domain. Until then, `https://oishii-nori-landing-vince-tamis.vercel.app` always resolves correctly and can be used/shared safely in the meantime.

---

None of the above blocks using the system for further development, testing, or a soft/staff-only trial run — it only matters for the day real customers and real money start flowing through it.
