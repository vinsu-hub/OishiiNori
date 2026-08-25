"""
Seed a placeholder Drinks/Softdrinks category into the Oishii Nori catalog.

The client's source spreadsheet (D:\\ioshinori\\Oishii_Nori_Menu_Ingredients.xlsx,
seeded by seed_from_xlsx.py) has zero beverage products -- the closest thing
is the 8-item "Cafe (16oz Iced)" coffee category. This script inserts a
small placeholder set of common Philippine bottled drinks/softdrinks so the
POS Terminal's new category tabs (and the customer-menu / landing-page apps,
which read the same live product data) have a real "Drinks" category to
show. Names and prices below are PLACEHOLDERS -- confirm/correct them with
the client via the Menu Editing screen before real service.

No recipe_items rows are created: per this project's established
convention (see WALKTHROUGH.md's Stock & Inventory section), resale
beverages like these are meant to be tracked as Station Items, not
recipe-based ingredients, so they carry no BOM/ingredient-deduction chain.
Selling one at POS will not touch inventory -- transactions.py's
_adjust_ingredients_for_size already no-ops cleanly for a product_size with
no recipe_items rows.

Connects directly to Postgres (same pattern as seed_from_xlsx.py) using
SUPABASE_DB_PASSWORD from services/api-fastapi/.env.local. Idempotent --
safe to re-run; every insert is an upsert keyed on the table's natural
unique constraint.

Run with:  py -3 services/api-fastapi/scripts/seed_drinks_placeholder.py
"""
import os
import re

import psycopg2

ENV_LOCAL_PATH = os.path.join(os.path.dirname(__file__), "..", ".env.local")

CATEGORY = "Drinks"
STATION = "cafe_bar"
DEPARTMENT = "cafe"

# (product name, placeholder price in PHP) -- PLACEHOLDER, confirm with client.
DRINKS = [
    ("Coke (Regular, in can)", 40),
    ("Coke Zero (in can)", 40),
    ("Sprite (in can)", 40),
    ("Royal (in can)", 40),
    ("Mountain Dew (in can)", 40),
    ("Sarsi (in can)", 35),
    ("Pineapple Juice (bottled)", 35),
    ("Bottled Water (500ml)", 20),
    ("Bottled Water (1L)", 35),
    ("Iced Tea (bottled)", 30),
]


def load_env_local(path):
    env = {}
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip()
    return env


def get_db_connection():
    env = load_env_local(ENV_LOCAL_PATH)
    supabase_url = env["SUPABASE_URL"]  # https://<ref>.supabase.co
    password = env["SUPABASE_DB_PASSWORD"]
    ref = re.match(r"https://([a-z0-9]+)\.supabase\.co", supabase_url).group(1)
    host = f"db.{ref}.supabase.co"
    return psycopg2.connect(
        host=host, port=5432, user="postgres", password=password,
        dbname="postgres", sslmode="require",
    )


def main():
    conn = get_db_connection()
    inserted = []
    try:
        with conn:
            with conn.cursor() as cur:
                for name, price in DRINKS:
                    cur.execute(
                        """
                        insert into products (name, category, station, department, is_bundle)
                        values (%s, %s, %s, %s, false)
                        on conflict (name) do update set
                            category = excluded.category,
                            station = excluded.station,
                            department = excluded.department,
                            updated_at = now()
                        returning id
                        """,
                        (name, CATEGORY, STATION, DEPARTMENT),
                    )
                    product_id = cur.fetchone()[0]

                    cur.execute(
                        """
                        insert into product_sizes (product_id, size_label, price, scale_factor, sort_order)
                        values (%s, 'Regular', %s, 1, 0)
                        on conflict (product_id, size_label) do update set
                            price = excluded.price
                        returning id
                        """,
                        (product_id, price),
                    )
                    cur.fetchone()
                    inserted.append((name, price))
    finally:
        conn.close()

    print(f"Upserted {len(inserted)} Drinks products (category={CATEGORY!r}, station={STATION!r}):")
    for name, price in inserted:
        print(f"  - {name}: PHP {price}.00")
    print()
    print("PLACEHOLDER PRICES -- confirm actual drink/softdrink names and prices "
          "with the client via the Menu Editing screen before go-live.")


if __name__ == "__main__":
    main()
