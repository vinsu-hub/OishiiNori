"""The maths behind the smart suggestions and the prep list (app/suggestions.py)."""

import unittest
from datetime import date

from app import suggestions as smart

SUSHI = {"id": "sushi", "name": "Sushi rice", "base_unit": "g", "prep_yield": 4500, "deduct_mode": "batch"}


def count(iid, variance, ts):
    return {"ingredient_id": iid, "variance": variance, "created_at": ts}


class YieldDriftTests(unittest.TestCase):
    def test_consistently_short_batches_suggest_a_lower_yield(self):
        counts = [count("sushi", 0, "2026-11-01T14:00:00Z")]
        batches = []
        for i, var in enumerate([-400, -200, -300], start=2):
            batches.append({"base_ingredient_id": "sushi", "batches": 2, "created_at": f"2026-11-0{i}T13:59:00Z"})
            counts.append(count("sushi", var, f"2026-11-0{i}T14:00:00Z"))
        (s,) = smart.yield_drift([SUSHI], counts, batches)
        # each batch came out (-200 -100 -150)/3 = -150 g short
        self.assertEqual(s["action"], {"prep_yield": 4350})
        self.assertEqual(s["key"], "yield:sushi:4350")

    def test_small_or_few_differences_stay_quiet(self):
        counts = [count("sushi", 0, "2026-11-01T14:00:00Z")]
        batches = []
        for i, var in enumerate([-50, 40, -30], start=2):
            batches.append({"base_ingredient_id": "sushi", "batches": 1, "created_at": f"2026-11-0{i}T13:59:00Z"})
            counts.append(count("sushi", var, f"2026-11-0{i}T14:00:00Z"))
        self.assertEqual(smart.yield_drift([SUSHI], counts, batches), [])  # within 3%
        self.assertEqual(smart.yield_drift([SUSHI], counts[:3], batches), [])  # only 2 intervals
        auto = {**SUSHI, "deduct_mode": "auto"}
        self.assertEqual(smart.yield_drift([auto], counts, batches), [])


class UsageDriftTests(unittest.TestCase):
    RICE = {"id": "rice", "name": "Japanese rice cooked", "base_unit": "g"}

    def test_steady_shortfall_is_flagged(self):
        counts = [count("rice", v, f"2026-11-{d:02d}T14:00:00Z") for d, v in [(10, 0), (11, -300), (12, -250), (13, -100), (14, -350)]]
        usage = [{"ingredient_id": "rice", "day": f"2026-11-{d:02d}", "used": 4000} for d in range(10, 15)]
        (s,) = smart.usage_drift([self.RICE], counts, usage)
        self.assertEqual(s["kind"], "usage")
        self.assertIn("~6% faster", s["title"])  # 1000 short / 16000 used
        self.assertIsNone(s["action"])

    def test_mixed_or_too_few_counts_stay_quiet(self):
        mixed = [count("rice", v, f"2026-11-{d:02d}T14:00:00Z") for d, v in [(10, 0), (11, -900), (12, 300), (13, 200), (14, -500)]]
        usage = [{"ingredient_id": "rice", "day": f"2026-11-{d:02d}", "used": 4000} for d in range(10, 15)]
        self.assertEqual(smart.usage_drift([self.RICE], mixed, usage), [])
        self.assertEqual(smart.usage_drift([self.RICE], mixed[:4], usage), [])


class ModeHintTests(unittest.TestCase):
    def test_counted_never_batched(self):
        kik = {"id": "kik", "name": "Kikoman mix", "base_unit": "g", "prep_yield": 500, "deduct_mode": "batch"}
        counts = [count("kik", 0, f"2026-11-1{d}T14:00:00Z") for d in range(3)]
        (s,) = smart.mode_hints([kik], counts, [])
        self.assertEqual(s["action"], {"deduct_mode": "auto"})
        self.assertEqual(smart.mode_hints([kik], counts, [{"base_ingredient_id": "kik"}]), [])
        self.assertEqual(smart.mode_hints([kik], counts[:2], []), [])


class PrepListTests(unittest.TestCase):
    def test_same_weekday_need_in_whole_batches(self):
        target = date(2026, 11, 21)  # a Saturday
        usage = [{"ingredient_id": "sushi", "day": f"2026-11-{d:02d}", "used": u} for d, u in [(14, 9000), (7, 8000), (13, 99999)]]
        usage += [{"ingredient_id": "sushi", "day": "2026-10-31", "used": 7000}, {"ingredient_id": "sushi", "day": "2026-10-24", "used": 8000}]
        ingredients = {
            "sushi": {"name": "Sushi rice", "base_unit": "g", "current_stock": 1000},
            "cooked": {"name": "Japanese rice cooked", "base_unit": "g", "current_stock": 20000},
            "vin": {"name": "Vinegar", "base_unit": "g", "current_stock": 5000},
        }
        components = [{"base_ingredient_id": "sushi", "ingredient_id": "cooked", "qty": 4000},
                      {"base_ingredient_id": "sushi", "ingredient_id": "vin", "qty": 350}]
        out = smart.prep_list([SUSHI], components, ingredients, usage, target)
        (item,) = out["items"]
        # Saturdays: 9000, 8000, 7000, 8000 -> 8000 expected; 1000 in stock -> 7000 -> 2 batches
        self.assertEqual((item["expected_use"], item["batches"], item["makes"]), (8000.0, 2, 9000.0))
        self.assertEqual({p["name"]: p["qty"] for p in out["pull"]}, {"Japanese rice cooked": 8000.0, "Vinegar": 700.0})
        ingredients["sushi"]["current_stock"] = 9000
        self.assertEqual(smart.prep_list([SUSHI], components, ingredients, usage, target)["items"], [])
