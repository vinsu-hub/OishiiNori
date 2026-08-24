# Oishii Nori Command Suite — Connection & Data-Processing Optimization Plan

**Status:** research complete, not yet implemented. This is a roadmap for a future work session, written from a direct code survey of the live codebase (not guesswork) — every item below cites the real file/line/pattern found.
**Ordering:** cheapest/safest first within each section, so items can be picked off incrementally the same way the Stock console redesign was phased, rather than attempted as one large change.

---

## Backend — data processing

### 1. Fix two real N+1 queries on the checkout hot path (S/M effort, high value)
**Files:** `services/api-fastapi/app/routers/transactions.py`

- `_adjust_ingredients_for_size` (~lines 98-146): loops over a product's recipe ingredients and does a **per-ingredient** `select("current_stock")...single()` read followed by a **per-ingredient** `.update(...)` write, inside the loop. This runs on every POS sale, every void, and every bundle-fulfillment — the single highest-traffic code path in the app.
- `fulfill_bundle_line` (~lines 660-693): loops over bundle lines and, per line, does a `product_sizes` select, a `recipe_items` select, calls into the N+1 above, and a separate `bundle_fulfillments` insert — an N+1 nested inside another N+1.

**Fix:** batch the ingredient reads with a single `.in_("id", [...])` before the loop (exactly the pattern already correct elsewhere in this codebase — `oishi_ai.py`'s `_recent_losses`/`_recent_inventory_movements`, `pnl.py`'s batched recipe-cost lookup, `products.py`'s `_list_products_data`). Writes can likely stay per-row (Postgres/PostgREST doesn't have a simple batched conditional-update primitive here) but the read side alone removes half the N+1 cost per sale.

**Risk:** medium — this is business-critical checkout logic (stock deduction), so change it carefully with the existing test coverage (`system_health_check.py`'s real POS-sale-lifecycle check) re-run before and after, plus a manual multi-ingredient sale/void/bundle-fulfillment walkthrough.

### 2. Add 4 missing indexes (S effort, high value, very low risk)
**New migration**, columns confirmed via direct read of every `supabase/migrations/*.sql` file against every router's actual filter/sort usage:

| Table | Column | Why |
|---|---|---|
| `transactions` | `opened_at` | Primary filter/sort for Order Queue's 20s poll, Trend Analysis, Command Center, P&L, Oishii AI's revenue aggregation |
| `inventory_movements` | `created_at` | Sort column for the movements list and Oishii AI's recent-movements section |
| `loss_records` | `created_at` | Sort/range-filter for Loss Log, P&L's loss-by-reason, Oishii AI's loss analysis |
| `digital_orders` | `created_at` | Sort column for every digital-order list call (Pending Orders' poll) |

(`transactions.employee_id/status`, `inventory_movements.ingredient_id/type`, `loss_records.ingredient_id/employee_id/reason`, and `hr.attendance_logs.employee_id/date` are **already indexed** — confirmed, not a gap.)

**Risk:** near zero — pure additive `CREATE INDEX`, no behavior change, standard `supabase db push`-style migration matching this project's existing pattern.

### 3. Cap remaining unbounded queries (S effort, medium value)
- `hr.py`'s `list_attendance` — no `.limit()`, and all its filters (`date_from`/`date_to`/`employee_id`) are optional, so a filterless call is a full table scan.
- `oishi_ai.py`'s `_revenue_bucket("all_time")`, `_digital_orders_summary`, `_loss_analysis` — all fetch the entire table with no cap, run on every single AI query.
- `pnl.py`'s ingredients `select("id, unit_cost")` — small table today, but no cap as the catalog grows.

**Fix:** add `.limit()`s or require at least one filter, matching the existing cap convention already used by `loss_records`/`inventory_movements`/`digital_orders`/`payroll_records` list endpoints (default 50-200, max 200-500).

**Risk:** low — mostly additive; double-check nothing downstream assumes an unbounded result (e.g. `_loss_analysis`'s all-time total needs either a real aggregate query or an explicit "capped, may undercount past N rows" caveat if capped).

### 4. Narrow remaining `select("*")` calls (M effort, low-medium value)
Roughly 1 in 3 queries across the routers is a `select("*")` fetching unused columns. Highest-value targets (large/growing tables): `transactions.py:366` (`list_transactions`), `hr.py`'s attendance queries, `inventory.py`'s ingredient list, `stock_items.py`'s repeated `select("*, ingredients(name, current_stock))`. Narrow each to just the columns its response model actually uses — the discipline `oishi_ai.py`/`pnl.py`/`dashboard_summary.py` already apply everywhere.

**Risk:** low, but tedious — go file by file, cross-check the response model's fields before removing any column from a select.

### 5. Consider a short-TTL in-memory cache for the busiest read-only lookups (M/L effort, medium value)
No caching layer exists anywhere in the backend today (confirmed — no Redis, no `lru_cache` on query results, only `deps.py`'s client-object cache). Best candidates: `products`/`discount_types` — fetched by 3+ dashboard pages every 20s poll cycle, and change rarely (only via Menu Editing/POS Management, both executive/manager actions). A `cachetools.TTLCache` with a short TTL (seconds, not minutes — this is a live POS, staleness has real consequences) would cut real duplicate load without much staleness risk.

**Risk:** medium — new infrastructure, needs careful invalidation (or just a short enough TTL that manual invalidation isn't needed) so a just-added menu item or a just-toggled discount doesn't appear stale for too long.

---

## Frontend — connection optimization

### 6. Deduplicate overlapping inventory fetches (S/M effort, medium value)
`StockOverview.tsx` and `StockAlerts.tsx` each independently call `fetchInventory()`/`fetchStockItems()`/`fetchExpiringSoon()` on mount — the same underlying data `InventoryAlertsContext` already polls every 90s at the app root. Consolidate: either extend the context to carry the fuller dataset these two pages need, or introduce a small shared fetch-cache hook so navigating between Stock Overview → Alerts → the Sidebar badge doesn't refire 3 near-identical requests.

### 7. Add visibility-gating to every poll (S effort, real value, zero functional downside)
None of the ~7 `setInterval`-based polls (Order Queue/Pending Orders/Kitchen Display/Inventory Movements/Loss Log/Utility Log all 20s, Command Center 30s, `InventoryAlertsContext` 90s) check `document.visibilityState` — every one keeps polling a backgrounded browser tab exactly as fast as a foregrounded one. A shared `useVisiblePolling` hook (pause on `visibilitychange` → hidden, resume + immediately refetch on → visible) meaningfully cuts real network/DB load, especially relevant since multiple staff stations plausibly keep several of these tabs open in the background simultaneously during a shift. `customer-menu`'s status poll is already the one exception with any gating (stops once an order leaves `pending`) — worth using as the reference pattern.

### 8. Stop re-fetching the product catalog on every poll tick (S effort, low-medium value)
`PendingOrders.tsx` and `KitchenDisplay.tsx` both re-fetch the full product catalog (`fetchProducts(true)`) on every 20s poll cycle even though products only change via an executive/manager action (Menu Editing). Fetch once on mount instead, or piggyback on `InventoryAlertsContext`'s slower 90s cadence.

### 9. Route-level code-splitting (M effort, medium value, standard tooling)
All 27 dashboard-web pages are statically imported in `App.tsx` and ship in one JS bundle — an `employee`-role session downloads executive-only code (P&L, Command Center, Menu Editing, Oishii AI, Trend Analysis) it can never navigate to. Convert page imports to `React.lazy(() => import(...))` + a `Suspense` boundary per route — standard Vite/Rollup automatic chunking, no backend changes, no `manualChunks` config needed to start.

### 10. CORS — note only, no change recommended
`allow_origins=["*"]` with no `allow_credentials` set (defaults false) is a **valid, safe combination** as configured — dashboard-web sends its Supabase JWT via an `Authorization` header, not cookies, so the credentials-leak concern that usually accompanies wildcard CORS doesn't apply here. Tightening to a fixed 3-origin allowlist would be reasonable hardening but isn't fixing a real vulnerability; lowest priority, optional.

---

## Suggested execution order for a future session

1. Add the 4 indexes (#2) — zero-risk, immediate win, do first.
2. Visibility-gate the pollers (#7) — self-contained frontend change, no backend coordination needed.
3. Fix the checkout N+1s (#1) — highest value, needs the most careful verification; do with dedicated focus, not bundled with other changes.
4. Cap unbounded queries (#3) + stop the product-catalog re-fetch (#8) — small, quick wins.
5. Dedupe inventory fetches (#6) + narrow `select("*")` (#4) — medium effort, do together since they touch overlapping files.
6. Code-splitting (#9) and the caching layer (#5) — larger, more structural; save for last, verify bundle size / cache behavior explicitly before and after.
7. CORS tightening (#10) — optional, whenever convenient.
