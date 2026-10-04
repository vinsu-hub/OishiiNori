# Brag Plan: Oishii Nori Command Suite

> Prepared for `/brag` (Step 2 output). **Not rendered yet** — this is the
> finalized creative brief and storyboard. To produce the video later, run
> `/brag --tone app-store` from the repo root; Step 3 (Hyperframes
> composition) and Step 4 (render) pick up from this file.

## Step 1 — rubric answers (from reading the code)

1. **What is the app?** The whole operating system of a Filipino-owned Japanese restaurant in Sta. Cruz, Laguna: a customer scans the QR on their table and orders from their phone, the cashier's tablet chimes, one tap sends it to the kitchen tablet where a ticket prints, the TV calls the number, and every ingredient in the order is deducted from stock on its own.
2. **Most impressive claim:** *"Every sale deducts its own ingredients."* (from `INVENTORY_SYSTEM_GUIDE.md`, implemented in `transactions.py` `_adjust_ingredients_for_size`) — no one counts what was sold; voids give it back; held ingredients ("no cucumber") are never touched.
3. **Visual hook:** the 58 mm thermal ticket sliding out of the kitchen printer with a giant order number, and the same number jumping on the TV board from **PREPARING** to **NOW SERVING** — paper and screen agreeing in real time.
4. **What to show from the actual UI:** the customer QR menu on a phone (`apps/customer-menu`, "TABLE 5" banner), the cashier toast "New table order — Table 5" with **Review** (`TableOrderAlertsContext.tsx`), the Kitchen Display card with **Accept / Mark Ready** (`KitchenDisplay.tsx`), the order slip / kitchen ticket (`Receipt.tsx`, `kitchenTicket.ts`), Ingredient Stock numbers ticking down, the TV board (`TvDisplay.tsx`), and the real dining-room Floor Plan (`DiningRoomBackdrop.tsx`, tables 1–12).
5. **Shortest satisfying video:** ~20 s — one order's journey from table to TV, with the stock deduction as the twist.
6. **Tone:** preset `app-store`; creative direction *"one order's journey through a busy Japanese kitchen — calm, warm, precise."*
7. **Audio:** warm, upbeat business bed (≈110–120 BPM), restrained motion-matched SFX: a soft chime for the new order, a tap on Approve/Accept, a thermal-printer whirr for the ticket, gentle ticks for stock counters, a clean hit on NOW SERVING.
8. **Share caption:** "Scan, chime, ticket, served — and the stock counts itself. The Oishii Nori Command Suite runs our whole kitchen. 🍣"
9. **User flow worth showing:** customer scans the table QR and orders → cashier hears the chime and taps Approve → kitchen taps Accept, ticket prints → stock deducts itself → TV calls the number, Now Serving.

## What is this app?
A restaurant operating system that carries one order from a customer's phone to the kitchen printer to the TV — and quietly subtracts every grain of rice it used from stock.

## The angle
**"One order, zero paperwork."** We follow a single real order — Table 5's two California Maki — through every screen it touches in about 20 seconds. Each beat is a different device in the actual restaurant (phone → cashier tablet → kitchen tablet + printer → stock → TV), so the video *is* the system diagram. The twist lands in the middle: while the kitchen is cooking, the stock already knows.

## Hook (first 2-3 seconds)
A phone over a wooden table. A QR sticker reading **TABLE 5 · Scan to order**. Thumb taps, the Oishii Nori menu opens with the banner **OISHII NORI · TABLE 5**, an item is added, **Place order** → the line **"Table 5 just ordered."** slams in (Archivo Black, vermilion).

## Key moments (the middle)
- The cashier tablet **chimes**: toast "New table order — Table 5 · Order #1012 · ₱468 · waiting for approval" → cursor taps **Review** → **Approve**.
- Kitchen Display card under **Queued** → tap **Accept** → the card moves to **Preparing** and a 58 mm ticket feeds out: `ORDER #1012 · TABLE 5 · 2x California Maki (8pcs) · - NO cucumber`.
- Split-second stock moment: Ingredient Stock rows tick down — **Nori −2 · Rice −240 g · Kani −4 · Cucumber −0** (held, untouched) — caption **"Every sale deducts its own ingredients."**
- TV board: **#1012** slides from PREPARING to **NOW SERVING**.

## Outro / punchline
Pull back to the real dining-room floor plan (tables 1–12); Table 5 glows. Logo **OISHII NORI · おいしいのり** with the line **"Counter to kitchen to stock. One system."**

## User flow worth showing
1. Entry — scan the table QR, order on the phone (customer menu, `?table=5`).
2. Key action — cashier Approve → kitchen Accept → ticket prints.
3. Result — stock deducted automatically, number called on the TV.

## Tone
- Preset: app-store
- Creative direction: one order's journey through a busy Japanese kitchen — calm, warm, precise
- Interpretation: feature-forward but human; clean card reveals, confident holds, no frantic cuts; the ticket printing and the counters ticking are the only "busy" moments.

## Format: landscape — 1920x1080
## Duration: 20 seconds

## Visual identity (from the project)
- Background: #F4EFE6 (warm paper — `--ws-color-bg`, dashboard `index.css`)
- Accent: #D42A2A (vermilion — `--ws-color-accent`); deep red #9F1D20 for print-style headers
- Text: #0F0D0C (`--ws-color-text-primary`); cards #FFFFFF; soft accent #F6DEDD
- Display font: Archivo Black (`.font-corp-display`)
- Body font: Inter (`.font-corp-body`); numbers/tickets: IBM Plex Mono / thermal monospace
- Strongest visual element: the thermal ticket + TV "NOW SERVING" number; supporting: `apps/landing-page/client/public/hero/` sushi-boat photos and `logo.jpg` / `logo-badge.png`; the dining-room floor plan (`components/reservations/DiningRoomBackdrop.tsx`)

## Share copy (draft)
Scan, chime, ticket, served — and the stock counts itself. The Oishii Nori Command Suite runs our whole kitchen. 🍣

## Audio direction
- Role: warm bed with sparse professional accents
- Music: `happy-beats-business-moves-vol-1-by-ende-dot-app.mp3` (≈120 BPM, upbeat business mood); alternative vol-9 (≈110 BPM) if a calmer feel is wanted
- Music treatment: start at 0 with a quick fade-in under the hook; steady bed at moderate volume; small lift into the TV reveal; fade out over the last 1.5 s under the logo
- Music cue guidance: preset cue file read (`assets/music/cues/…vol-1…music-cues.md`). Strong cues at 16.02 s, 17.02 s, 18.52 s — align the **NOW SERVING** jump (~15.9 s) toward 16.02 s and the logo lock-up toward 18.52 s. Beat grid every ~0.5 s from 3.02 s: use it for accents (toast pop, Accept tap, counter ticks), not for readable text.
- Audio-reactive treatment: subtle — the vermilion glow on the Table 5 marker and the NOW SERVING number may breathe with the bass; no waveforms
- SFX posture: moderate, motion-matched
- Audio-coupled moments: QR tap; order-sent swoosh; cashier chime (rising two-note, like the real `playTableOrderBeep`); taps on Review/Approve/Accept; thermal-printer feed under the ticket; soft ticks on each stock counter; a clean hit on NOW SERVING; quiet logo hit
- Restraint rule: no sound effect for every text line; nothing louder than the music bed except the NOW SERVING hit

## Storyboard

### Scene 1 — The table — 3.0s
Phone over a wooden table; QR sticker "OISHII NORI · TABLE 5 · Scan to order". Thumb tap → customer menu opens (warm paper, "OISHII NORI · TABLE 5" eyebrow, "Simple. Fresh. Japanese."), "California Maki" added, **Place order** tapped. Headline lands and holds ≥1.2 s: **"Table 5 just ordered."**
Sequential/interaction: yes — simulated tap on the QR, tap on the item, tap on Place order
Audio intent: open bright and curious
Audio-coupled idea: tap ticks on each touch; small swoosh on order sent
Music: bed fades in
Transition mood: clean → Scene 2 (the order "flies" right into the cashier tablet)

### Scene 2 — The counter chimes — 3.5s
Cashier tablet showing POS Terminal (product grid, red "Charge"). A toast slides in from the corner: **"New table order — Table 5"** / "Order #1012 · ₱468.00 · waiting for approval" with a **Review** button. Cursor taps Review → Table Orders card → taps **Approve**. Sidebar badge "Table Orders 1" clears to 0.
Sequential/interaction: yes — toast arrives, cursor taps Review, then Approve
Audio intent: a friendly "you've got an order" moment
Audio-coupled idea: two-note rising chime on the toast; soft click on each tap
Music: steady bed
Transition mood: clean → Scene 3

### Scene 3 — Kitchen: Accept, ticket prints — 4.5s
Kitchen Display: four columns Queued / Preparing / Ready / Completed; card **#1012 · TABLE 5 · 2x California Maki (8pcs) · – hold: cucumber** in Queued. Tap **Accept** → card moves to Preparing; status pill "Kitchen tablet — tickets print here". Cut-in: a 58 mm ticket feeds out of the printer: `ORDER #1012` / `TABLE 5` / `7:41 PM` / `2x California Maki (8pcs)` / `  - NO cucumber`. Caption (hold 1.2 s): **"Accept. The ticket prints itself."**
Sequential/interaction: yes — tap Accept, card slides between columns, ticket feeds line by line (quick feed, then the full ticket holds)
Audio intent: satisfying mechanical moment
Audio-coupled idea: thermal-printer whirr under the feed; small tap on Accept
Music: steady bed
Transition mood: hard cut → Scene 4

### Scene 4 — The stock already knows — 4.0s
Ingredient Stock table (white card on warm paper). Four rows tick down one after another and then hold together: **Nori sheets 120 → 118**, **Japanese rice 9,000 g → 8,760 g**, **Kani sticks 60 → 56**, **Cucumber 2,000 g → 2,000 g** with a small "held — not deducted" tag. Headline (hold ≥1.5 s): **"Every sale deducts its own ingredients."**
Sequential/interaction: yes — counters tick one by one (reveal fast, then hold all four for ≥1.5 s)
Audio intent: quiet "aha" — precision, not spectacle
Audio-coupled idea: soft tick per counter; nothing on the held row
Music: slight lift begins
Transition mood: clean slide → Scene 5

### Scene 5 — Now Serving — 2.5s
The TV board (dark, room-readable): PREPARING column shows **1012**, which slides into **NOW SERVING** and scales up in vermilion. Lands on the strong cue (~16.0 s). Customer's order slip (big "#1012", "Watch the screen for your number") peeks in the corner for one beat to show paper = screen.
Sequential/interaction: yes — number moves columns
Audio intent: the payoff
Audio-coupled idea: clean hit on the NOW SERVING landing
Music: peak of the bed
Transition mood: soft zoom-out → Scene 6

### Scene 6 — One system — 2.5s
The real dining-room floor plan (kitchen, counter, tables 1–12) — Table 5 glows vermilion. Logo **OISHII NORI** with **おいしいのり** beneath; line (hold ≥1.2 s): **"Counter to kitchen to stock. One system."**
Sequential/interaction: none
Audio intent: warm resolve
Audio-coupled idea: quiet logo hit near the 18.52 s strong cue
Music: fade out over the last 1.5 s
Transition mood: end

**Scene durations:** 3.0 + 3.5 + 4.5 + 4.0 + 2.5 + 2.5 = **20.0 s**

**Music mood for this video:** upbeat
**Audio summary:** a warm, upbeat business bed carries one order from a tap on a table QR through a chime, a printer whirr and quiet stock ticks to a single clean NOW SERVING hit and a soft logo resolve.

## Facts to keep accurate in the composition
- Real button labels: **Review**, **Approve**, **Accept**, **Mark Ready**, **Complete**, **Print order slip**, **Start Business Day**.
- The slip says **ORDER SLIP** and **THIS IS NOT AN OFFICIAL RECEIPT** — don't call it an official receipt on screen.
- Stock quantities in Scene 4 are illustrative; real recipes are per size (an 8-piece and a 4-piece differ). Don't present them as the actual recipe.
- 12 tables (numbered 1–12) on the floor plan; two Xiaomi tablets; XP-58H 58 mm printers.
- Business: Oishii Nori, Pedro Guevarra Avenue beside STI College, Sta. Cruz, Laguna — Filipino-owned, authentic Japanese with a Filipino twist.
