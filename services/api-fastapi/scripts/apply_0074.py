"""Apply 0074_online_menu_addon_updates.sql changes via Supabase REST API."""

import os
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

from dotenv import load_dotenv
from supabase import create_client

load_dotenv(Path(__file__).resolve().parent.parent / ".env.local")

SUPABASE_URL = os.environ["SUPABASE_URL"]
client = create_client(SUPABASE_URL, os.environ["SUPABASE_SECRET_KEY"])
rows = client.table("menu_addons").select("id,name,price,active").execute().data
targets = {row["name"].lower(): row for row in rows}
updates = {
    "extra nori": {"price": 35},
    "extra scallions": {"price": 25},
    "extra soft-boiled egg": {"price": 25},
    "extra shrimp": {"active": False},
}
for name, values in updates.items():
    row = targets.get(name)
    if row is None:
        raise RuntimeError(f"Expected add-on is missing: {name}")
    if any(row.get(key) != value for key, value in values.items()):
        client.table("menu_addons").update(values).eq("id", row["id"]).execute()

verified = client.table("menu_addons").select("name,price,active").execute().data
actual = {row["name"].lower(): row for row in verified}
expected = {
    "extra noodles": (40, True),
    "extra nori": (35, True),
    "extra scallions": (25, True),
    "extra shrimp": (65, False),
    "extra soft-boiled egg": (25, True),
}
for name, (price, active) in expected.items():
    row = actual.get(name)
    if row is None or float(row["price"]) != price or row["active"] is not active:
        raise RuntimeError(f"Unexpected value for {name}: {row}; expected ₱{price}, active={active}")
    print(f"{row['name']}: ₱{row['price']} (active={row['active']})")
