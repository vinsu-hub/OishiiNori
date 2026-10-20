"""Put ingredients in the client's stock-sheet order for EOD Stock Count (VS).

Ingredients are their own table, so they get their own placement (station,
sheet_section, sort_order -- migration 0080). Each one sits next to the
Station Items row it is counted as, and takes that row's section and
position (apply_client_stock_layout.py must have run first):

  1. an ingredient a station item links to (stock_items.ingredient_id)
     takes that item's place;
  2. otherwise ALIASES names the station item it goes with;
  3. kitchen-made and other items the sheet doesn't list go to HOUSE: a
     last "Kitchen-made & extras" section of their station, A-Z.

Anything left unmatched is listed, and lands on the page's "Unsorted" tab.
Dry run by default:

    cd services/api-fastapi
    .venv/bin/python scripts/apply_ingredient_sheet_layout.py
    ... --apply
"""
import argparse
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))

from apply_client_stock_names import norm  # noqa: E402

R, M, D, T = "ramen_hot_line", "sushi_kitchen_main", "cafe_drinks", "tako_snack"

# ingredient -> (station, the Station Items row it is counted with)
ALIASES = {
    "Angus beef": (R, "Angus beef"),
    "Beef (sliced)": (R, "Beef sliced Chiller"),
    "Black garlic": (R, "Black Garlic"),
    "Chasu": (R, "Chasu"),
    "Pork belly (Chasu)": (R, "Chasu"),
    "Pork (cutlet)": (R, "Tonkatsu Chiller"),
    "Chicken (cutlet)": (R, "Torikatsu Chiller"),
    "Shrimp / Prawn (raw)": (R, "Shrimp"),
    "Squid (Ika)": (R, "Seafood Pack"),
    "Ground pork (gyoza filling)": (R, "Gyoza"),
    "Gyoza wrapper": (R, "Gyoza"),
    "Ramen broth (batch-prepped)": (R, "Ramen Base"),
    "Egg (Tamago / soft-boiled)": (R, "Egg Boiled"),
    "Scallion": (R, "Onion leaks"),
    "Chili flakes": (R, "Chili powder/ Togarashi"),
    "Steamed rice": (R, "Rice cooked"),
    "Cooking oil": (R, "Oil"),
    "Tempura batter / panko breading": (R, "B.Crubms"),
    "Chopsticks": (R, "Chopstick"),
    "Nori sheet": (M, "Nori whole"),
    "Salted Nori": (M, "Salted nori"),
    "Bibigo seasoned seaweed (branded SKU)": (M, "Salted nori"),
    "Breaded prawn": (M, "Breaded prawns Chiller"),
    "Breaded shrimp (Ebi)": (M, "Breaded prawns Chiller"),
    "Tempura shrimp": (M, "Prawns for Baked"),
    "Canned tuna": (M, "Tuna Chiller"),
    "Tuna (raw, spicy tuna mix)": (M, "Spicy Tuna Mix"),
    "Salmon": (M, "Salmon Chiller"),
    "Scallop": (M, "Scallop Chiller"),
    "Crab stick": (M, "Crab Chiller"),
    "Ebiko (fish roe)": (M, "Ebiko Chiller"),
    "Mozzarella cheese": (M, "Mozarella"),
    "Cheese blend (torching)": (M, "Mozarella"),
    "Parmesan cheese": (M, "Parmesan"),
    "Teriyaki glaze": (M, "Teriyaki sauce"),
    "Katsu sauce": (M, "Tongkatsu sauce"),
    "Special mayo (house)": (M, "Mayo"),
    "Spicy mayo": (M, "Hot mayo"),
    "Oishii salad sauce (house)": (M, "Salad Sauce"),
    "Rice vinegar seasoning mix": (M, "Vinegar"),
    "Crispy potato string": (M, "Potato String"),
    "Crispy kani (garnish, batch-prepped)": (M, "Kani"),
    "Pearl (tapioca)": (D, "Pearl"),
    "Fructose (Drip Tea)": (D, "Fructose"),
    "B.S Syrup": (D, "BS syrup"),
    "Milktea base (batch-prepped)": (D, "Black tea"),
    "Green Tea (batch-brewed)": (D, "Black tea"),
    "Mousse mix (Drip Tea)": (D, "Mousse Powder"),
    "Full Cream Milk": (D, "Full cream"),
    "Milk": (D, "Full cream"),
    "Oreo Crumble": (D, "Oreo"),
    "Cookie Crumble": (D, "Cookies"),
    "Nutella Sauce": (D, "Nuttela"),
    "C.D Syrup": (D, "Cookie Dough"),
    "Star Jelly": (D, "Nata"),
    "W.M Syrup": (D, "WM"),
    "Thai Flavor": (D, "Thai"),
    "Okinawa Flavor": (D, "Okinawa"),
    "Hokkaido Flavor": (D, "Hokkaido"),
    "Matcha Powder (Drip Tea)": (D, "Matcha"),
    "Cocoa / Creamer": (D, "Choco powder"),
    "Red Choco / Creamer": (D, "Red choco"),
    "Taro Flavor": (D, "Taro powder"),
    "Charcoal Powder": (D, "Charcoal"),
    "Mango Syrup": (D, "Mango syrup"),
    "Lychee Syrup": (D, "Lychee"),
    "Passion Syrup": (D, "Passion"),
    "Yogurt Syrup": (D, "Yogurt"),
    "Butterfly Pea Tea (batch-brewed)": (D, "Butterfly"),
    "Hibiscus Tea (batch-brewed)": (D, "Hibiscus"),
    "Chocolate sauce": (D, "Choco sauce"),
    "Crushed pistachio": (D, "Pistachio"),
    "Aonori": (T, "Annori"),
    "Takoyaki Sauce": (T, "Tako sauce"),
    "Cabbage (slaw)": (T, "Repolyo"),
    "Bonito Flakes": (T, "Bonito"),
    "Pork Floss": (T, "Pork Floss"),
    "Japanese Mayo": (T, "Mayo"),
    "Cheddar Cheese": (T, "Cheese Bar"),
    "Cheese Cuts": (T, "Cheese Bar"),
    "Special Cheese Sauce": (T, "Cheese sauce"),
    "Truffle Oil": (T, "Truffle Oil"),
}
# Not on the sheet -> the station whose "Kitchen-made & extras" lists it.
HOUSE = {
    "Chicken (sliced, teriyaki)": R, "Pork (sliced, teriyaki)": R, "Mushroom": R, "Onion": R,
    "Gyoza dipping sauce": R,
    "Tartar/mayo sauce": M,
    "Espresso beans / shots": D, "Matcha powder": D, "Mocha sauce": D, "Simple syrup": D,
    "Spanish cream syrup": D, "Pastillas syrup (house)": D, "Pistachio mousse cream (house)": D,
    "Sea salt cream foam (house)": D, "Ice": D, "Water": D,
    "Special Oishii Nori Sauce": T,
}
HOUSE_SECTION = "Kitchen-made & extras"
HOUSE_POSITION = 9000


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()

    from dotenv import load_dotenv
    load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env.local"))
    from app.deps import get_supabase
    db = get_supabase()

    items = db.table("stock_items").select("station,name,category,sort_order,ingredient_id").execute().data
    by_station_name = {(i["station"], norm(i["name"])): i for i in items}
    linked = {i["ingredient_id"]: i for i in items if i["ingredient_id"]}
    ingredients = db.table("ingredients").select("id,name,station,sheet_section,sort_order").execute().data

    layout: dict[str, tuple[str | None, str | None, int | None]] = {}
    unmatched = []
    for ing in ingredients:
        item = linked.get(ing["id"])
        if not item and ing["name"] in ALIASES:
            station, row = ALIASES[ing["name"]]
            item = by_station_name.get((station, norm(row)))
            if not item:
                print(f"  !! {ing['name']!r}: no Station Items row {row!r} at {station}")
        if item:
            layout[ing["id"]] = (item["station"], item["category"], item["sort_order"])
        elif ing["name"] in HOUSE:
            layout[ing["id"]] = (HOUSE[ing["name"]], HOUSE_SECTION, HOUSE_POSITION)
        else:
            unmatched.append(ing["name"])
            layout[ing["id"]] = (None, None, None)

    changes = 0
    ordered = sorted(ingredients, key=lambda i: (layout[i["id"]][0] or "~", layout[i["id"]][2] or 10**6,
                                                 i["name"].lower()))
    for ing in ordered:
        station, section, position = layout[ing["id"]]
        if (ing["station"], ing["sheet_section"], ing["sort_order"]) == (station, section, position):
            continue
        changes += 1
        where = f"{position:>4}" if position is not None else "   -"
        print(f"  {station or '(none)':<19} {where} {ing['name']:<38} {section or ''}")
        if args.apply:
            db.table("ingredients").update(
                {"station": station, "sheet_section": section, "sort_order": position}
            ).eq("id", ing["id"]).execute()
    if unmatched:
        print("\nNot matched (Unsorted tab): " + ", ".join(sorted(unmatched)))
    print(f"\n{changes} change(s)." + ("" if args.apply else " Dry run; re-run with --apply to write."))
    return 0


if __name__ == "__main__":
    sys.exit(main())
