# Oishii Nori Command Suite — Client Demo Walkthrough

**A presenter's script for a live, end-to-end demo of the whole system.**

This is a *demo runbook*, not a feature reference — it's the order to click through things in front of a client, what to say at each screen, and where to slow down. The centre of gravity is **Section 6: Stock & Inventory** and the **variance discussion** — everything before it is scene-setting so the inventory story lands.

For the screenshot-illustrated reference see `WALKTHROUGH.md`; for feature-by-feature detail see `SYSTEM_GUIDE.md` and `INVENTORY_SYSTEM_GUIDE.md`.

---

## 0. Before the client arrives — setup checklist

| # | Check | How |
|---|---|---|
| 1 | Backend is up | `GET https://oishii-nori-api.vercel.app/health` → `{"status":"ok"}` |
| 2 | All 5 apps load | open the 5 URLs below, confirm no error screens |
| 3 | Demo employees + attendance exist | Dashboard → Employees shows Maria Santos, Juan Dela Cruz, Ana Reyes, Mark Villanueva, Rico Bautista, Liza Fernandez |
| 4 | A bookable table is active | Dashboard → Reservations → Tables → at least one table `Active = Yes` |
| 5 | Two browser windows ready | one logged in as **executive**, one incognito for **customer menu / kiosk** |
| 6 | Pick your variance demo ingredient | e.g. *Sushi rice* or *Salmon* — you'll deliberately miscount it in Section 6 and revert it after |

### URLs

| App | URL | Demo login |
|---|---|---|
| Landing Page | `https://oishii-nori-landing.vercel.app` | none (public) |
| Customer Menu | `https://oishii-nori-menu.vercel.app/?table=1` | none |
| Staff Clock kiosk | `https://oishii-nori-staff-clock.vercel.app` | `EMP-5059` / PIN `1234` (Maria Santos) |
| Command Suite dashboard | `https://oishii-nori-dashboard.vercel.app` | `qa.tester@oishiinori.com` / `oishii1234-qa` (executive) |
| Backend API | `https://oishii-nori-api.vercel.app/health` | — |

Other logins if asked: `qa.manager@oishiinori.com` / `oishii1234` (manager), `qa.employee@oishiinori.com` / `oishii1234-qa` (employee), `admin` / `admin123` (executive, literal-username login).

**One-liner for the client:** *"Five apps, one backend, one database. A customer, a cashier, and the owner are all looking at the same numbers in real time — nothing is typed twice."*

---

## 1. The pitch in 30 seconds

Say this first, before touching anything:

> "Today Oishii Nori runs on paper stock sheets and a separate POS. The gap between the two is where money leaks — you find out weeks later that rice is short and there's no way to know why. This system closes that gap. Every sale deducts its own ingredients the moment it happens, the two things a paper count can never see are captured the second they occur, and the manual count becomes a quick accuracy check instead of the whole job. Let me show you a full business day."

Demo path: **discover → reserve → order → serve → clock in → count stock → read the variance → see the P&L → ask the AI.**

---

## 2. Landing Page — the public front door

Open `https://oishii-nori-landing.vercel.app`.

- **Hero** — brand mark, tagline, "Reserve a table" and "View menu".
- **Menu highlights** — *"These are pulled live from the same database the kitchen uses. Change a price once and it changes here, on the customer's phone, and on the POS."*
- **Visit** — hours come from the same endpoint the reservation engine enforces, so they can't drift. Click "Visit us" to expand the map.
- **FAQ → Reserve** — click **"Reserve now"**. Point out it deep-links into the *one* reservation portal — there's no second copy to maintain.

Keep this short — 60 seconds. It's the wrapper, not the product.

---

## 3. Customer Menu — QR ordering + reservation

Open `https://oishii-nori-menu.vercel.app/?table=1` in the incognito window. *"This is what the customer sees after scanning the QR code on table 1. No app, no login."*

### 3a. Place an order (this feeds Section 6 — do it for real)

1. Browse, open a dish — show **"What's inside"** (real recipe ingredients) and the size picker with real per-size prices.
2. Add an item to the cart.
3. Open the cart → **"Edit this recipe"** → **hold an ingredient** (e.g. "no cucumber").
   - **Say:** *"Watch this — I'm telling the kitchen to leave the cucumber out. Remember this for the stock section: the system will NOT deduct cucumber for this order, because it was never used. On the old paper system that cucumber still 'disappeared' and showed up as a mystery shortage later."*
4. Choose a payment method (Cash / GCash — no real processing, it's a staff heads-up).
5. **"Send to the counter."** The screen becomes a receipt-style ticket with a `PENDING` badge that polls every 5s.
6. **Say:** *"Nothing is a sale yet. It's staged. A staff member has to approve it — we'll do that in a minute from the dashboard."*

### 3b. Reserve a table (optional, if the client cares about reservations)

From the landing page's "Reserve now" (or the welcome screen if opened without `?table=`):
- Party size + date → live time-slot grid computed against real table capacity and existing bookings. Full slots show greyed-out and labelled "Full", not hidden.
- Pick a slot → Name / Phone / note → "Request this table".
- Confirmation shows a reservation number and a `pending` badge — **and the slot is already held**, so a second overlapping request can't double-book it.

---

## 4. Staff Clock — kiosk attendance

Open `https://oishii-nori-staff-clock.vercel.app`. *"Shared device by the back door. No login screen — just employee number and PIN."*

1. Enter `EMP-5059` / `1234` → **Continue**.
2. Confirm screen shows **Maria Santos / Cashier** → **Continue**.
3. First action of the day → **Punch In** → success screen auto-dismisses (shared device, resets for the next person).
4. **Say:** *"If Maria comes back later in her shift and enters her PIN again, she gets a live hours-worked timer and an 'End Today's Work' button. That clock-out is what payroll reads — we'll see it in the HR section."*

Keep it to ~45 seconds. The point is "attendance flows straight into payroll with no re-keying."

---

## 5. Command Suite — selling & kitchen

Switch to the executive window: `https://oishii-nori-dashboard.vercel.app`, logged in as `qa.tester@oishiinori.com`.

### 5a. Roles (10 seconds)

*"Three roles — employee, manager, executive — each sees a different slice of this sidebar. I'm logged in as the owner, so I see everything. Backend checks are the real enforcement; the sidebar just reflects it."*

### 5b. Pending Orders — approve the QR order from Section 3

- Sidebar → **Pending Orders**. The order Maria's customer placed is sitting here, unapproved.
- Click **Approve**.
- **Say:** *"This is the moment stock moves. Approving runs the exact same deduction code a POS sale uses — and notice it deducts every ingredient in the recipe EXCEPT the cucumber we held. That accuracy is now baked in at the source."*

### 5c. POS Terminal — ring a sale directly

- Sidebar → **POS Terminal**. Tap a drink (single price) → it's in the cart.
- Show the **discount picker** (populated from POS Management).
- **Charge** → sale complete.
- **Say:** *"Whether the order starts on the customer's phone or here on the till, it goes through one code path. Stock, kitchen tickets, the P&L — all downstream of the same event."*
- Mention without clicking: Held Orders (park a cart), Favorites, "Owner's Request" PIN override for manager/exec approvals.

### 5d. Kitchen Display — where prep happens (important for variance)

- Sidebar → **Kitchen Display**. Both the approved QR order and the POS sale are on the board — no special-casing for where they came from.
- Advance a ticket: **Accept** → **Complete**.
- Click **"Log extra usage"** on an item. Open the dialog, pick an ingredient, enter an over-amount, reason defaults to **Prep error**.
  - **Say — slow down here:** *"This is the second thing a paper count can never see. The recipe says 200g of rice; the cook actually used 250. Instead of that 50g becoming a mystery shortage three weeks from now, the cook logs it right here, in five seconds, at the exact moment it happened. It deducts stock immediately and lands in the Loss Log with their name, the amount, and the peso cost."*
- Submit it (or cancel if you'd rather not move real stock — but submitting makes Section 6 richer).

### 5e. Reservations review (skip if you skipped 3b)

- Sidebar → **Reservations** → **Requests** tab → the pending request from 3b.
- **Confirm** → the customer's polling screen flips to "You're all set" with no reload.
- **Decline** requires a reason — that reason is what the customer sees.
- **Tables** tab — the roster the availability engine reads from. An inactive table can never be offered.

---

## 6. Command Suite — Stock & Inventory ★ THE CORE OF THE DEMO

Spend the most time here. This is the section the client is buying.

### 6.0 Frame it first (say this before clicking anything)

> "Here's the philosophy in one sentence: **you no longer count everything by hand every day.** Every sale you just watched already deducted its own recipe ingredients, in real time, correctly skipping the held cucumber. The two blind spots of a paper count — a held ingredient and over-use during prep — are now captured the second they happen. So the physical count changes jobs: it goes from being *the* record of what's in stock to being a periodic **spot-check** on numbers that are already mostly right. And when the count and the system disagree, that disagreement is now **traceable** — that's the variance story."

The Stock area is one collapsible sidebar group:
**Overview → Recipe Ingredients → Station Items → Receive Shipment → Alerts → Variance Log.**

### 6.1 Recipe Ingredients — the live count sheet

Sidebar → **Stock** → **Recipe Ingredients**.

Walk the columns:
- **Expected** — *"What the system currently believes is on the shelf. This isn't a number someone typed — it's the running total, kept accurate automatically by every single sale."*
- **Counted** — what a person physically counts and types in.
- **Variance** and **Status** — *"Compute live, as I type, before anything is saved."*

**The 5% rule — explain it clearly:**
- Within **5%** of Expected → treated as normal counting noise → shows green as **Counted**.
- More than 5% **over** → amber **Overage** → *"you found more than expected — usually an uncounted delivery."*
- More than 5% **under** → red **Shortage** → *"real loss, or a miscount. Either way, worth a look."*

**Do the live variance demo:**
1. Pick your chosen ingredient (e.g. Sushi rice). Note its Expected value out loud.
2. Type a **Counted** value clearly below Expected (enough to break the 5% band).
3. **Say:** *"Watch the row — Variance goes negative and red, Status flips to Shortage, and this all happened before I saved anything. The counter sees the problem while they're still standing at the shelf."*
4. Now type a value **above** Expected on another ingredient → amber Overage.
5. Point at the **"Expiring Soon"** card — advisory, surfaces ingredients whose most recent delivery is nearing expiry.

**Saving a count — the audit point:**
- **Say:** *"When I save, stock is set to exactly what was counted. And here's the part that matters: anything that came out different from Expected is permanently logged as a stock-count-adjustment — an audit record. An exact match logs nothing, because there's nothing to explain."*
- If the count came up **short**, an **optional** follow-up dialog offers to log it as a **loss** so the peso cost is tracked. *"Never automatic — a shortage might just be a miscount, so it's always the counter's call."*
- Mention: typing autosaves to the browser as you go; if the tab dies mid-count, reopening offers to restore exactly what was entered, with a timestamp.

> **After the demo:** revert your test ingredient(s) to their original Expected values — enter the original number as the Counted value and save, or note them and fix via API. Say to the client: *"I'll put that back — I just broke it on purpose to show you the states."*

### 6.2 Station Items — the ~200 items with no recipe

Sidebar → **Stock** → **Station Items**.

- **Say:** *"These are the items from your real paper stock sheets that have no recipe — packaging, napkins, chopsticks, resale drinks — organised by physical station: Tako-Snack, Cafe-Drinks, Sushi-Kitchen Main, Ramen-Hot Line."*
- **The key change:** *"New Stocks, Beginning, Usage, Ending used to be a blank form somebody filled in by hand every day. Now all four are computed — from sales, deliveries, and logged losses — the same way Recipe Ingredients already worked. Staff review a finished list instead of writing one."*
- Point out the arithmetic is consistent by construction: **Beginning + New Stocks − Usage = Ending**, always. So there's no mismatch check — instead each field has a small **flag icon**.
- Click a flag icon → correction dialog → requires a **reason** before saving → writes a real audited adjustment (same mechanism as a Recipe Ingredients count-adjustment), *never* a silent overwrite. The reason then shows in the grid and in Variance Log.
- **VERIFY flag:** rows carried over from the paper-sheet transcription as ambiguous stay flagged VERIFY until a human confirms the mapping.
- **Linked items:** for the few station items that are also real recipe ingredients, a correction here routes through to that ingredient's real stock number — *"one place that number lives, not two competing systems."*

### 6.3 Consumption Rules — how a station item learns to auto-deduct

Sidebar → **Stock** → **Station Items** → **Manage Catalog** (manager/executive only) → a row's **Consumption Rules** button.

- **Say:** *"Without a rule, a station item's Usage stays at zero no matter how many are sold — same as a product with no recipe. A rule is what turns the automation on."*
- Two shapes:
  - **Per product sold** — "1 can deducted per Coke sold" (pick the exact product + size).
  - **Per transaction** — "1 takeout box per takeout order", optionally scoped to dine-in/takeout, optionally scaled by guest count (napkins, chopsticks).
- **Set expectations honestly:** *"Populating rules for all ~200 items happens gradually as you work through the catalogue. An item with no rule yet just shows Usage = 0 until you add one — nothing breaks, it just isn't automated yet."*

### 6.4 Overview & Alerts — you don't go looking for problems

- **Overview** — read-only glance: low-stock count, expiring-soon, per-station verification counts, recent movements. All real aggregated data.
- **Alerts** — one filterable table of every low-stock, expiring, and verify-needed item. Each row's **"Count now"** deep-links straight to the right tab and station.
- Mention the **red badge** next to "Stock" in the sidebar and the **Low Stock card** on Home — *"if something hits its reorder threshold, the badge appears. You don't have to open Stock and scan for it."*

### 6.5 Variance Log ★ the payoff — spend real time here

Sidebar → **Stock** → **Variance Log**.

> "This is the page that didn't exist before, in any form. It's the reconciliation view — every discrepancy in one chronological, filterable list, from two real sources:
> 1. **Loss records** — spoilage, breakage, comps, shrinkage, and the 'Log extra usage' entries from Kitchen Display.
> 2. **Count-adjustment movements** — the audit record every non-matching physical count produces.
>
> Variance is **signed** — plus for an overage, minus for a shortage. Cost impact is a real peso figure wherever the unit cost is known. And 'Recorded by' is an actual employee name via a live join — not a raw ID, not a guess."

Walk through the entries the demo just created:
- The **"Log extra usage"** rice entry from Section 5d — *"here's that 50g of rice, with the cook's name, timestamped to when it happened, costed."*
- The **count-adjustment** from Section 6.1 — *"here's my deliberate miscount. It's logged as an adjustment, with my name, so three weeks from now nobody's asking 'where did the rice go?' — the answer is right here."*
- Any Station Items flag correction from 6.2, with its reason.

**The closing line for this section:**

> "Old world: the paper sheet says one thing, the shelf says another, and there is no third document that explains the gap — so it just becomes 'wastage' in a spreadsheet. New world: every gap has a name, a time, a reason, and a cost, on one page. That's the difference between knowing you lost money and knowing *why*."

Caveat to state plainly: *"There's no date-range search yet — this shows the most recent 50 records of each kind, and the page says so. That's on the roadmap."*

### 6.6 Receive Shipment & Loss Log (brief — the inputs)

- **Receive Shipment** — batch delivery form: a row per ingredient (qty, unit cost, optional expiry), one shared supplier/invoice note. Tab 2: one-off movements (transfers, write-offs). Tab 3: full movement history.
- **Loss Log** — standalone spoilage/breakage/comp/shrinkage not tied to a kitchen ticket. *"Order-tied overages use Kitchen Display's 'Log extra usage' — same endpoint, closer to the moment."*

---

## 7. Command Suite — operations & executive pages

Move faster here — these support the story rather than being the story.

- **Utility Log** — electricity/water/gas meter readings; consumption and cost computed automatically.
- **POS Management** — discount-type CRUD (name, %, VAT-exempt, active). Populates the POS discount picker.
- **Command Center** (executive landing page) — same-day rollup: revenue, discounts, tax, losses, low-stock, utility cost, department split, staff-clocked-in count.
- **Trend Analysis** — date-range sales-trend chart + top-products table from real transactions.
- **Menu Editing** — full catalogue CRUD: items, per-size prices, recipe/ingredient components, real photo uploads. *"This is where the price change I mentioned on the landing page actually happens — once, here."*
- **P&L** ★ — *"This is Section 6 turned into money."* Revenue, gross/net profit, food cost %, cost breakdown, margin by department — computed live from the same recipe/BOM data and ingredient unit costs that drive the Stock section. On-screen callouts flag known data gaps (e.g. ingredients still missing a cost). **Say:** *"Every loss you logged, every variance, every held ingredient — it all lands here as true food cost. The inventory system isn't a chore that sits to the side; it's the input to this number."*
- **Oishii AI** ★ — chat assistant grounded in real live business data. Ask it something in front of the client: *"What were my biggest loss drivers this month?"* or *"Which ingredients are running low?"* — *"Not a generic chatbot. It's reading revenue, best sellers, loss records, stock levels, payroll — the same data on every page we've looked at."*
- **Settings** — account + logout for everyone; executives also get Business Settings where the VAT rate is a single editable value.

---

## 8. Command Suite — HR & Payroll

Close the loop from Section 4.

- **Employees** — roster CRUD: name, role, department, position, pay rate, and **set kiosk PIN** (the same PIN used at the Staff Clock kiosk). *"New hire, one form, and they can clock in at the kiosk immediately."*
- **HR Attendance** — the attendance log. Find **Maria Santos** — *"here's the punch-in we did at the kiosk earlier, no re-keying."* Manual payroll-override entry exists for edge cases.
- **Payroll → Preview & Generate** — pick a period, load a preview (summary cards + per-employee breakdown) before committing a real run. *"There's seeded attendance history for June 1–15 — pick that period."*
- **Payroll → History** — every past run, with real PDF payslip downloads (single or a bulk ZIP for the period).
- **Payroll → Overrides & Audit** — manual override requests and their approval trail.
- **Holiday Calendar** — regular / special-non-working / special-working holidays by year; these feed the pay-multiplier rules.
- **Payroll Settings** — the actual DOLE pay-rule percentages per work-day scenario.

**Say:** *"Kiosk punch → attendance log → payroll preview → generated run → PDF payslip. One chain, no spreadsheet in the middle."*

---

## 9. Closing — tie it back together

> "One business day: the customer found you on the website, ordered from their phone, held an ingredient — and the system knew not to deduct it. The cook logged an over-use in five seconds instead of it becoming a mystery. Maria clocked in at the kiosk and that flowed straight to payroll. And every discrepancy from the whole day — the held ingredient, the extra rice, my deliberate miscount — is sitting on the Variance Log with a name, a time, a reason, and a peso cost, and it rolls up into the P&L as true food cost.
>
> You're not buying a POS. You're buying the thing that sits between the POS and the paper sheet and makes the gap visible."

### Q&A anticipations

| Client asks | Answer |
|---|---|
| "Does this replace our POS?" | It *is* the POS (POS Terminal) plus everything downstream. One system. |
| "How much manual counting is left?" | Recipe ingredients: a periodic spot-check, not daily. Station items: review a finished list, no walk-and-count. |
| "What if the internet goes down at the kiosk?" | Clock-ins queue offline and sync automatically when it's back. |
| "Can staff see the P&L / payroll?" | No — role-gated. Employees see POS/kitchen/stock-counting; managers add HR + oversight; only executives see P&L, Command Center, AI. |
| "Are the ~200 station rules set up?" | Not yet — that's a gradual data-entry task in Manage Catalog. Items without a rule show Usage 0 until one's added; nothing breaks. |
| "Can I search variance history by date?" | Not yet — currently the latest 50 of each record type. On the roadmap. |
| "Is the contact form on the website live?" | No — it's a client-side placeholder, no email is sent. Flagged in `LAUNCH_CHECKLIST.md`. |

---

*Demo accounts and seeded data (payroll-demo employees, June attendance history, an activated reservation table) are real persistent records, not staged mockups. If you run the variance demo in Section 6.1 against production, revert the test ingredient(s) afterward.*
