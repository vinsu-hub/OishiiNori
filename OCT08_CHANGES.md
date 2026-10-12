# October 8, 2026 — production menu additions and pending fixes

## October 9 register expense audit update

- The cashier Expenses tab already supported a purpose and amount form tied to the signed-in account. It now displays the recorder's name on each entry. Command Center has a detailed expense report for its selected day/week/month, and the Business Day Report expands to show each day's purpose, amount, timestamp, and recorder. Register expenses remain separate from paid sales and continue to reduce the expected closing register balance and P&L net profit.
- Expense reads, Business Day totals, and P&L expense totals paginate rather than stop at the database response cap. The API tests (22), TypeScript check, and dashboard build passed. Production API `dpl_FPQBJJ4wYjC5w1LRD42eHkx1TSm5` and dashboard `dpl_4Zj2x7Ugu7v51xhS7UBPLn3C6Nb6` were deployed in that order. Public dashboard routes and assets plus API health were verified. No production expense was created during verification.

## October 9 follow-up — platter recipe fix and sales breakdown deployed

- Migration `0066_pending_bundle_deductions.sql` adds an opt-in, atomic record-only path for platters whose roll recipe unit differs from its ingredient stock unit. It records the exact kitchen selection and lets the ticket progress while recording **zero** ingredient deductions or inventory movements. All other invalid submissions continue to fail. Existing strict fulfillment and reversal functions, orders, and stock rows are unchanged.
- Once a manager or executive publishes a verified whole maki recipe, the API attempts to apply each matching pending platter deduction exactly once, storing the quantities for safe reversal. A voided or restored order is skipped. Pending cost is flagged in P&L rather than estimated.
- Menu Editing highlights the original mismatched unit, requires a re-entered verified quantity and confirmation, and shows a pending-platter queue. Kitchen Display distinguishes “rolls logged, stock pending” from fully deducted batches. No recipe conversion or ingredient amount was guessed.
- Offline verification: 24 PGlite SQL checks, 19 Python API/report tests, dashboard TypeScript check and production build. The owner applied migrations 0066 and 0067; the 0066 table was independently confirmed through production REST. The saved direct database password remains stale, so the 0067 constraint definition could not be read back through SQL. API `dpl_F86tT7KR7iWzJGwvqrBo1q216mBE` and dashboard `dpl_5etuuGMTD6eYTN7ujfL8B4gYmq8Z` were deployed in that order. Production health and dashboard assets were verified. No existing orders or stock were modified during verification.

## October 9 sales breakdown rollout

- Command Center now shows payment totals for Cash, GCash, Debit, Credit, BDO, and Maya, plus payment by order source and menu item sales split by sold size. Linked digital orders use their original payment provider. The Business Day Report shows separate size rows and paginates the source reads while retaining its non-voided-order basis, including unpaid orders.
- Read-only production reconciliation for October 8 Philippine time: 95 paid, non-voided orders total ₱39,646.30; payment and source groupings each sum to the same amount. No BDO or Maya sale was present in that sample. The live Command Center, POS, delivery, and Business Day assets contain the new controls and fields.

## Command Center paid-sales analytics (live)

- The Command Center now has a Day / Week / Month selector with a date anchor, paid-sales trend, prior-period comparison, dine-in/takeout/delivery split, separate order-source split, category/item gross-sales breakdown, best sellers, and peak sales hour. This shows actual sales, not a forecast.
- New `GET /dashboard/sales-insights` counts paid, non-voided orders by the day they were placed; late delivery payments therefore update that order day's figures. Current periods compare with the same elapsed part of the previous period. Existing operational totals remain all non-voided orders and are labeled accordingly.
- API deployment `dpl_D9u7et4MpRZqxCif6A5mupisog15` and dashboard deployment `dpl_EG2AdsFScjvAp399zpDt6EmrBPCG` were promoted after preview/production-build smoke checks. Public `/dashboard/command-center` and `/health` return 200; the new endpoint returns 401 without a session. The live Command Center asset contains the new paid-sales panels. Read-only calls against the production database reconciled day/week/month totals to both order-type and source breakdowns. An authenticated browser walkthrough remains to be done.

## Live catalog changes (verified)

- Ramen, 1 bowl: Tantanmen ₱209; Kuro Chasumen ₱209; Spicy Miso ₱199; Black Garlic ₱289.
- Cafe (16oz Iced), 16 oz: Tiramisu Rate ₱229 (owner's exact spelling).
- Separate Pork and Chicken products, same categories/servings as their source:
  Katsudon Curry ₱219 each; Cheesy Katsu oBento ₱115 each; Katsu oBento ₱99 each.
- All eleven new entries are active. Recipe rows remain empty; the owner will supply recipes. No ingredient/stock writes were made.
- The three original “Pork or Chicken” products are deactivated after deploying the lookup fix. Their IDs, sizes, and historical order links remain intact.
- Takeout Bowl ₱10 and Takeout Box ₱5 are active in the `Packaging` category. Takeout Bowl is an existing product recategorized from Ramen; Takeout Box is newly added. Neither received a recipe or stock-consumption rule, so cashiers add only what was used.
- Scripts `services/api-fastapi/scripts/add_ramen_20261008.py` and `split_menu_20261008.py` default to dry-run, verify existing names/prices on rerun, and retain historical IDs.

## Production rollout and verification

- Production deployments: API `dpl_52oDnxKCQg6nFE7gdfd4ZBupSvMn`; dashboard
  `dpl_BmccLGJDmAFa4VbSFGGUDPLeNFQL`. Dashboard includes cashier delivery-fee/source controls,
  source metrics, rider payout and expense screens/reporting, 17 POS table choices, CEO recipe
  notices, larger receipt table number, SPA deep-link fallback, bundle recipe-mapping editor,
  and manual KDS roll fulfillment.
- Live schema inspection confirms `cash_expenses`, `transactions.order_source`, and
  `deliveries.rider_payout`, `bundle_fulfillment_batches`, `bundle_recipe_sources`, and the
  atomic fulfillment/reversal RPCs exist. Eight active roll products are mapped to their
  recipe-bearing sizes with provisional yields derived from the size labels.
- Three recipe lines currently have unit/base-unit mismatches: one each in Crazy Maki, Futo
  Maki, and Torikatsu Maki. The atomic RPC validates all selected recipe units before writing
  stock, so a fulfillment containing these recipes fails without partial deductions. Verify
  and correct the saved recipe units/quantities with kitchen input.
- Smoke checks: dashboard root, Reservations, Online Orders, Expenses, POS Deliveries, Command
  Center, P&L, Kitchen Display, and POS return HTTP 200. API `/health`, `/public/menu`,
  `/public/addons`, and `/public/delivery-fees` return 200; Packaging is excluded from the
  public menu. Cash-expense and rider-payout routes return 401 without a session, confirming the
  auth guard runs.
- Dashboard type check/build, Python compilation, 11 API unit tests, six kitchen-ticket
  scenarios, 19 isolated SQL integration checks, and `git diff --check` pass. Existing CSS
  import-order and large-chunk build warnings remain. Delivery line-item editing is unimplemented
  pending a stock-safe atomic update path.
- Supabase CLI remains unlinked/unauthenticated in this checkout and the production DB host is
  IPv6-only/unreachable from this environment. Live schema and mappings were verified read-only
  through Supabase REST; migration tracking metadata could not be queried through the CLI.

## Changes still local

Ticket rendering now always shows DINE IN, TAKE OUT, or DELIVERY beneath the order number; dine-in additionally prints TABLE N. Missing/unknown types print CHECK ORDER TYPE rather than being mislabeled takeout. The TypeScript tablet ticket change is live; the Python bridge equivalent remains local.

Kitchen Display, Order Queue, and shared delivery/digital-order lookup now read inactive catalog items too, preserving names on historical/pending orders after retiring combined products. Bundle choices still exclude inactive products. These dashboard changes are deployed to production as `dpl_4Wx7nqEGmCGixywaaYJ6nWMSLEKE` (`https://oishii-nori-dashboard.vercel.app`). I fetched the production Kitchen Display asset and confirmed it contains the order-type and table labels. The Python bridge ticket label change remains local; Android tablet printing uses the dashboard code.

Bundle failure: product `5c834722-826a-433b-bebf-9164237fca01` is Torikatsu Maki, with an 8 pcs size containing a recipe and a 4 pcs size without one. The old endpoint rejects multiple sizes and multiplies piece counts directly by serving recipes. It also writes each flavor independently. An offline reproduction demonstrated partial writes if a later flavor fails.

Read-only production inspection found **no fulfillment rows** for item `0a297915-81e8-42d9-b416-23e036e77c4c` on transaction `12852282-5549-4311-8a0e-5c392aed83ed`. This does not independently prove absence of all historical stock movement side effects. No production order was repaired or resubmitted.

Migration `0063_atomic_bundle_fulfillment.sql` adds explicit flavor→recipe-size/piece-yield mappings, atomic fulfillment/reversal RPCs, batch completion records, and ingredient deduction snapshots. It is now applied and deployed with the API and dashboard. Eight active roll products are mapped to their recipe-bearing size, with provisional yields taken from the size labels as authorized. Exact retries return the recorded response; conflicting/partial historical submissions require review. New reversals use saved quantities even after recipes change; P&L uses saved deductions with current ingredient costs. Historical ambiguous rows are flagged/excluded from COGS and blocked from automatic reversal rather than guessed.

## Outstanding rollout steps

1. Have the owner/kitchen verify the provisional yields: seven recipes are labeled **8 pcs** and Futo Maki is **6 pcs**. Correct mappings in Menu Editing → Recipe if the physical yield differs.
2. Correct the recipe unit/base-unit mismatches in Crazy Maki, Futo Maki, and Torikatsu Maki using verified ingredient quantities. The atomic RPC rejects these recipes before stock changes.
3. Verify a controlled platter's exact deductions and retry behavior in an isolated environment, then observe an authorized real service order. Re-read the affected production item before any remediation; activity may have changed since inspection.

Rollback: once snapshot-based fulfillments exist, reverting to the old backend would reintroduce incorrect multi-size reversal. Keep the snapshot-aware reversal code and disable new bundle submissions if a rollout problem occurs; retain the additive tables/data. Existing order/refund processing is not globally transactional; this change makes the bundle operation atomic, not every mixed-order refund path.

## Verification

- 19 isolated PostgreSQL/PGlite checks: two-size flavor, per-flavor yields, multiple platters, duplicate and conflicting retries, missing recipes/mappings, legacy partial records, injected write-failure rollback, snapshot reversal/retry, void/late-fulfillment guards, unit validation, eligibility, function permissions. PGlite uses one connection; a real multi-session concurrency test remains a staging rollout check.
- 11 offline Python API/report tests: existing payload compatibility, errors, mapping validation, completion totals, ambiguous legacy reversal and P&L snapshot handling.
- Six ticket scenarios checked across TypeScript text, ESC/POS commands, mocked canvas drawing, and real Python bridge header output. No physical printer used.
- Dashboard TypeScript check and production build pass. Build reports existing CSS import-order and chunk-size warnings.
- Tests live in `services/api-fastapi/tests`. SQL test engine is isolated at `/private/tmp/oishii-bundle-sql-tests`; it is not an application dependency.
