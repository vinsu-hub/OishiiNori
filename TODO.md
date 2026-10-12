# TODO

## Pending — bundle fulfillment in Kitchen Display

- **October 9 local fix, awaiting production migration and deployment:** `0066_pending_bundle_deductions.sql` adds a record-only path for unit-mismatched recipes, so staff can log the exact rolls and advance the ticket without guessing stock usage. Manager/executive recipe publishing later applies pending stock once. The local implementation passes isolated checks; it is **not live** because the saved database password no longer authenticates and the Supabase CLI is unauthenticated. Apply 0066 through the Supabase SQL Editor, verify the new table/RPCs, then deploy API before dashboard and smoke-check a controlled platter. Do not clear or replay existing orders automatically.

- Keep the kitchen flow manual: staff select the roll flavors and enter the actual number
  used for each platter. The total must match the platter's required piece count; only a
  successful save marks that bundle fulfilled and lets the Kitchen Display ticket advance.
- Provisional yield assumption for wiring the existing roll recipes: use the piece count
  in each recipe-bearing size label (for example, an 8 pcs recipe yields 8 pieces; Futo
  Maki's 6 pcs recipe yields 6). This is an operational assumption, not a verified kitchen
  measurement. Do not auto-select or proportionally calculate the rolls used.
- Migration `0063`, the atomic fulfillment API, mapping editor, and manual Kitchen Display
  flow are deployed. Eight active roll mappings were saved using the provisional size-label
  assumption. Kitchen still enters the actual flavor and piece counts for each platter.
- Three existing recipes have recipe-unit/base-unit mismatches: Crazy Maki, Futo Maki, and
  Torikatsu Maki. The RPC rejects a fulfillment containing those recipes before any stock
  writes. Correct their existing recipe units/quantities with verified kitchen input, then
  test a controlled platter. Do not invent or change recipe ingredients.
- Verify a controlled platter can be logged, persisted, retried safely, and advanced without
  partial stock deductions. Kitchen staff should use currently valid mapped recipes until the
  three unit mismatches are resolved.

## Pending — POS, delivery, reporting, and operations

- **Done in live POS catalog:** Takeout Bowl ₱10 and Takeout Box ₱5 are active as separate
  Packaging-category POS items. The existing Takeout bowl SKU was recategorized from Ramen;
  Takeout Box was added as a new product. Neither has a recipe or stock-consumption rule,
  so staff must add only the packaging actually used and no ingredient/stock deduction is
  being guessed.
- **Deployed safely:** the dine-in table number is larger/bolder on POS receipts; Packaging
  SKUs are hidden from the public ordering menu while remaining active in POS; dashboard SPA
  deep links such as Reservations and Online Orders return the app instead of a Vercel 404.
- **Deployed and smoke-checked:** cashier-entered POS delivery fee, POS/Grab source tags,
  Command Suite source metrics, rider payout/net display, P&L deductions, register expense
  log and Business Day Report totals, 17 numbered POS choices (unmapped ones marked layout
  pending), and CEO-pending recipe notices. Migrations `0064` and `0065` are present in the
  live schema. Dashboard and API deployments are live; dashboard routes and public API
  health/menu/add-on/delivery-fee endpoints return HTTP 200. Migration `0063` and eight
  provisional recipe mappings are also live; atomic fulfillment is enabled, subject to the
  three recipe-unit mismatches above.
- **Takeout packaging workflow:** remind/train cashiers to add the bowl or box actually
  used to each takeout/delivery order. Do not auto-add packaging to every menu item.
- **Delivery order editing:** add an Edit action in Deliveries so authorized cashiers can
  replace, swap, or remove order items. This needs a stock-safe atomic update path before
  enabling edits; do not mutate line items while leaving ingredient deductions behind.
- **Table layout follow-up:** after the physical arrangement/capacities are supplied, map
  the 17 POS numbers into Tables/Reservations. The POS currently offers 1–17, but unmapped
  entries cannot enforce reservation conflicts or seat capacity yet.

Everything below is a record of what was done, kept for context.

## Done

- **Customer Reviews smoke test** — submitted a real review via the public API, confirmed it
  appeared in the dashboard's Pending queue, approved it, confirmed it moved to History. Clean.
- **Customer Reviews: optional photo upload** — migration `0053` (adds `reviews.photo_url`) and a
  new `review-photos` Storage bucket, both applied/created live. New unauthenticated
  `POST /public/reviews/{id}/photo` (mirrors the existing proof-of-payment upload pattern exactly:
  content-type allowlist, 5MB cap, `pending`-only gate). Landing Page's review form gained an
  optional file input + preview; dashboard's Reviews tab renders a thumbnail (click to open
  full-size) in both Pending and History. Fully end-to-end tested: happy path (upload → publicly
  fetchable URL → visible in dashboard), bad content-type (400), oversized file (400), attaching
  to an already-decided review (400), and a review with no photo still works unchanged. All test
  rows and the one uploaded test storage object deleted afterward, zero residue.
- **Migration `0051` (POS Delivery order type) and `0052` (Customer Reviews) — applied and
  verified end-to-end** in an earlier round (POS Delivery charge → rider queue → completion;
  Reviews submission → moderation → approve/reject, idempotency, rate limiting, anonymity
  scrubbing). See prior `SESSION_HANDOFF.md` entries for full detail.
- Kitchen print bridge ticket formatting re-verified against real order data; 3 real formatting
  bugs found and fixed (unwrapped item lines, a mangled Unicode en-dash, a silently truncated long
  customer name) — see `kitchen-print-bridge/ticket.py`.

## Still outstanding (unrelated to this work, not urgent)

- The dedicated Supabase account the kitchen print bridge should authenticate as ("Kitchen
  Printer") has not been created yet — see `kitchen-print-bridge/README.md` §1a.
- The XP-58H has not been physically paired/tested over Bluetooth — only proofed via
  `--test-print`'s `Dummy` profile and real order data rendered to text/bytes, never a real print.
- None of this work is committed, pushed, or deployed to Vercel yet — the database is ahead of
  the deployed code (safe/backward-compatible), but a commit+push+deploy is needed before any of
  it is actually reachable in production.
