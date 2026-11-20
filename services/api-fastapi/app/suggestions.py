"""What the system learns from counts, batches and sales (migration 0089).

Pure functions over plain rows, so they're easy to test; the router
(app/routers/suggestions.py) fetches the rows and caches the result.

- Batch yield drift: after batches, the base keeps counting above or below
  what the batches should have made -> "it really makes ~4,300 g".
- Usage drift: a raw item comes up short count after count, by a steady
  share of what recipes took -> "runs out ~8% faster than recipes say".
- Mode hint: a batch item that's counted but never has a batch recorded
  -> "take it from the raw items on each sale instead?".
- Prep list: same weekday over the last 4 weeks, minus what's in stock ->
  "make 2x Sushi rice tomorrow", and the raw items to pull for it.

Every threshold is on purpose conservative: a wrong nudge costs trust.
"""
import math
from collections import defaultdict
from datetime import date, datetime, timedelta

MIN_INTERVALS = 3  # counts after batches before a yield is questioned
YIELD_TOLERANCE = 0.03
MIN_COUNTS = 5  # counts before usage drift is called
USAGE_TOLERANCE = 0.05
SHORT_SHARE = 0.6  # share of counts that must come up short
MODE_MIN_COUNTS = 3
PREP_WEEKS = 4


def _ts(v) -> datetime:
    return v if isinstance(v, datetime) else datetime.fromisoformat(str(v).replace("Z", "+00:00"))


def _day(v) -> date:
    return v if isinstance(v, date) and not isinstance(v, datetime) else date.fromisoformat(str(v)[:10])


def yield_drift(bases: list[dict], counts: list[dict], batches: list[dict]) -> list[dict]:
    """bases: {id, name, base_unit, prep_yield, deduct_mode}; counts:
    {ingredient_id, variance, created_at}; batches: {base_ingredient_id,
    batches, created_at}."""
    counts_by = defaultdict(list)
    for c in counts:
        counts_by[c["ingredient_id"]].append(c)
    batches_by = defaultdict(list)
    for b in batches:
        batches_by[b["base_ingredient_id"]].append(b)
    out = []
    for base in bases:
        if (base.get("deduct_mode") or "batch") != "batch" or not base.get("prep_yield"):
            continue
        yield_ = float(base["prep_yield"])
        cs = sorted(counts_by.get(base["id"], []), key=lambda c: _ts(c["created_at"]))
        errors = []
        for prev, cur in zip(cs, cs[1:]):
            lo, hi = _ts(prev["created_at"]), _ts(cur["created_at"])
            n = sum(float(b["batches"]) for b in batches_by.get(base["id"], []) if lo < _ts(b["created_at"]) <= hi)
            if n > 0:
                errors.append(float(cur["variance"]) / n)
        if len(errors) < MIN_INTERVALS:
            continue
        mean = sum(errors) / len(errors)
        if abs(mean) / yield_ < YIELD_TOLERANCE:
            continue
        suggested = round(yield_ + mean)
        if suggested <= 0:
            continue
        out.append({
            "key": f"yield:{base['id']}:{suggested}",
            "kind": "yield",
            "ingredient_id": base["id"],
            "title": f"{base['name']} usually makes ~{suggested:,} {base['base_unit']}, not {yield_:,.0f}",
            "detail": f"Over the last {len(errors)} counts after batches, each batch came out "
                      f"{'+' if mean > 0 else ''}{mean:,.0f} {base['base_unit']} off. Update one batch to {suggested:,}?",
            "action": {"prep_yield": suggested},
        })
    return out


def usage_drift(items: list[dict], counts: list[dict], usage: list[dict]) -> list[dict]:
    """items: {id, name, base_unit} of plain (not batch-made) items;
    usage: {ingredient_id, day, used}."""
    counts_by = defaultdict(list)
    for c in counts:
        counts_by[c["ingredient_id"]].append(c)
    used_by = defaultdict(dict)
    for u in usage:
        used_by[u["ingredient_id"]][_day(u["day"])] = float(u["used"])
    out = []
    for item in items:
        cs = sorted(counts_by.get(item["id"], []), key=lambda c: _ts(c["created_at"]))
        if len(cs) < MIN_COUNTS:
            continue
        after = cs[1:]  # the first count only sets the starting point
        short = sum(1 for c in after if float(c["variance"]) < 0)
        var_sum = sum(float(c["variance"]) for c in after)
        first, last = _ts(cs[0]["created_at"]).date(), _ts(cs[-1]["created_at"]).date()
        used = sum(v for d, v in used_by.get(item["id"], {}).items() if first < d <= last)
        if used <= 0 or var_sum >= 0 or short / len(after) < SHORT_SHARE:
            continue
        share = -var_sum / used
        if share < USAGE_TOLERANCE:
            continue
        pct = round(share * 100)
        out.append({
            "key": f"usage:{item['id']}:{pct // 5}",
            "kind": "usage",
            "ingredient_id": item["id"],
            "title": f"{item['name']} runs out ~{pct}% faster than recipes say",
            "detail": f"{short} of the last {len(after)} counts came up short: {-var_sum:,.0f} {item['base_unit']} "
                      f"missing against {used:,.0f} {item['base_unit']} recorded as used. Portions may be bigger "
                      "than the recipe, or there's waste nobody logs.",
            "action": None,
        })
    return out


def mode_hints(bases: list[dict], counts: list[dict], batches: list[dict]) -> list[dict]:
    counted = defaultdict(int)
    for c in counts:
        counted[c["ingredient_id"]] += 1
    batched = {b["base_ingredient_id"] for b in batches}
    out = []
    for base in bases:
        if (base.get("deduct_mode") or "batch") != "batch" or not base.get("prep_yield"):
            continue
        if counted[base["id"]] >= MODE_MIN_COUNTS and base["id"] not in batched:
            out.append({
                "key": f"mode:{base['id']}",
                "kind": "mode",
                "ingredient_id": base["id"],
                "title": f"{base['name']} is never logged as a batch",
                "detail": f"It was counted {counted[base['id']]} times but no batch was ever recorded, so its "
                          "raw items never go down. Take them straight from stock on each sale instead?",
                "action": {"deduct_mode": "auto"},
            })
    return out


def prep_list(bases: list[dict], components: list[dict], ingredients: dict[str, dict],
              usage: list[dict], target: date) -> dict:
    """bases: batch-made items; components: prep_recipe_items rows;
    ingredients: id -> {name, base_unit, current_stock}."""
    used_by = defaultdict(dict)
    for u in usage:
        used_by[u["ingredient_id"]][_day(u["day"])] = float(u["used"])
    same_days = [target - timedelta(days=7 * k) for k in range(1, PREP_WEEKS + 1)]
    takes = defaultdict(list)
    for c in components:
        takes[c["base_ingredient_id"]].append(c)
    items, pull = [], defaultdict(float)
    for base in bases:
        if (base.get("deduct_mode") or "batch") != "batch" or not base.get("prep_yield") or not takes.get(base["id"]):
            continue
        history = used_by.get(base["id"], {})
        if not any(history.get(d) for d in same_days):
            continue
        expected = sum(history.get(d, 0.0) for d in same_days) / len(same_days)
        stock = float(ingredients.get(base["id"], {}).get("current_stock") or 0)
        need = expected - max(stock, 0)
        if need <= 0:
            continue
        yield_ = float(base["prep_yield"])
        n = math.ceil(need / yield_)
        items.append({
            "ingredient_id": base["id"], "name": base["name"], "unit": base["base_unit"],
            "expected_use": round(expected, 1), "in_stock": round(stock, 1), "batches": n, "makes": round(n * yield_, 1),
        })
        for c in takes[base["id"]]:
            pull[c["ingredient_id"]] += float(c["qty"]) * n
    items.sort(key=lambda i: i["name"])
    return {
        "for_date": target.isoformat(),
        "items": items,
        "pull": sorted(
            ({"ingredient_id": iid, "name": ingredients.get(iid, {}).get("name", "?"),
              "unit": ingredients.get(iid, {}).get("base_unit", ""), "qty": round(q, 1),
              "in_stock": round(float(ingredients.get(iid, {}).get("current_stock") or 0), 1)}
             for iid, q in pull.items()),
            key=lambda p: p["name"],
        ),
    }
