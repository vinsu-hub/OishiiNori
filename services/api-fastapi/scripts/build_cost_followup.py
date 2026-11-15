"""Build the follow-up workbook for Sir Joe after apply_checklist_costs.py:
only what still needs his answer -- the estimated costs to confirm, the
ingredients in recipes that still have no price, and the menu items with
no recipe (most-sold first, in his checklist's row format). Read-only.

    cd services/api-fastapi
    .venv/bin/python scripts/build_cost_followup.py "<out>.xlsx"
"""
import argparse
import os
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))

from apply_checklist_costs import COSTS, FOLD_FIRST, MERGES, RENAMES  # noqa: E402

# Things that don't add up between the two sheets, or need a yes/no.
QUESTIONS = [
    ("Pearl (tapioca)", "Checklist: 1 kg per pack. Stock sheet (DRIPTEA): 500 grams per pack. Alin po ang tama?"),
    ("Full Cream Milk", "Checklist: 1 liter per pack. Stock sheet: 1 kg per pack. Ilang ml po ang isang pack?"),
    ("Cream cheese", "Sa sheet ₱1,075 for 2 kg, sa chat ₱1,050 for 2 kg. Alin po ang latest? (Pwede i-type sa dashboard.)"),
    ("Chasu", "Pork belly (Chasu) recipes: Oishii Nori Ramen 3, Pork Teriyaki 2, Chasu Ramen 1. Slices po ba yan? "
              "Ilang slices sa isang 500 g pack (ginamit namin: 20 slices, 25 g each)?"),
    ("Matcha", "May dalawa: 'Matcha Powder (Drip Tea)' (per scoop) at 'Matcha powder' (per gram, cafe). Pareho po bang matcha? "
               "Kung oo, ilang grams ang isang scoop?"),
    ("Steamed rice", "Ginamit namin: 1 kg bigas (₱65) = mga 2.2 kg na luto. Tama po ba?"),
]

BLUE = "1F4E78"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("out")
    args = parser.parse_args()

    import openpyxl
    from openpyxl.styles import Alignment, Font, PatternFill
    from dotenv import load_dotenv

    load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env.local"))
    from app.deps import get_supabase
    from app.routers.sales_insights import _page_rows

    db = get_supabase()
    ingredients = _page_rows(db.table("ingredients").select("id, name, category, base_unit, unit_cost").order("name"))
    products = db.table("products").select("id, name, category, is_bundle").eq("active", True).execute().data
    product_by_id = {p["id"]: p for p in products}
    sizes = _page_rows(db.table("product_sizes").select("id, product_id, size_label, sort_order")
                       .in_("product_id", list(product_by_id)).order("sort_order").order("id"))
    recipe_rows = _page_rows(db.table("recipe_items").select("product_size_id, ingredient_id").order("id"))
    rule_sizes = {r["product_size_id"] for r in _page_rows(
        db.table("stock_consumption_rules").select("product_size_id").eq("active", True).order("id"))}

    # What the names / costs will be once apply_checklist_costs.py has run.
    renamed = {**RENAMES}
    gone = set(MERGES) | set(FOLD_FIRST)
    costed = set(COSTS)
    size_by_id = {s["id"]: s for s in sizes}

    used_in: dict[str, set[str]] = defaultdict(set)
    sizes_with_recipe = set()
    for row in recipe_rows:
        size = size_by_id.get(row["product_size_id"])
        if not size:
            continue
        sizes_with_recipe.add(size["id"])
        used_in[row["ingredient_id"]].add(product_by_id[size["product_id"]]["name"])

    no_price = []
    for ing in ingredients:
        name = renamed.get(ing["name"], ing["name"])
        if ing["name"] in gone or ing["unit_cost"] is not None or name in costed or not used_in.get(ing["id"]):
            continue
        no_price.append((ing.get("category") or "", name, ing["base_unit"], sorted(used_in[ing["id"]])))
    no_price.sort(key=lambda r: (-len(r[3]), r[1]))

    # Sales in the last 30 days, to put the most-sold missing recipes first.
    since = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()
    sold: dict[str, float] = defaultdict(float)
    for row in _page_rows(db.table("transaction_items").select("product_size_id, quantity, transactions!inner(opened_at, status)")
                          .gte("transactions.opened_at", since).neq("transactions.status", "voided").order("id")):
        sold[row["product_size_id"]] += float(row["quantity"])

    missing = defaultdict(list)
    for size in sizes:
        product = product_by_id[size["product_id"]]
        if product["is_bundle"] or size["id"] in sizes_with_recipe or size["id"] in rule_sizes:
            continue
        missing[product["id"]].append(size)
    missing_rows = sorted(
        missing.items(),
        key=lambda kv: (-sum(sold.get(s["id"], 0) for s in kv[1]), product_by_id[kv[0]]["category"], product_by_id[kv[0]]["name"]),
    )

    estimates = [(name, price, qty, note) for name, (price, qty, note, est) in COSTS.items() if est]
    unit_of = {renamed.get(i["name"], i["name"]): i["base_unit"] for i in ingredients}

    wb = openpyxl.Workbook()
    head = Font(bold=True, color="FFFFFF")
    fill = PatternFill("solid", fgColor=BLUE)
    wrap = Alignment(wrap_text=True, vertical="top")

    def sheet(title, headers, widths, first=False):
        ws = wb.active if first else wb.create_sheet()
        ws.title = title
        ws.append(headers)
        for c, w in zip(ws[1], widths):
            c.font, c.fill, c.alignment = head, fill, wrap
            ws.column_dimensions[c.column_letter].width = w
        ws.freeze_panes = "A2"
        return ws

    ws = sheet("Basahin muna", ["Oishii Nori - follow-up sa Recipes & Unit Costs"], [120], first=True)
    for line in [
        "Salamat po sa checklist! Na-load na namin ang mga presyo. Ito na lang po ang kulang o kailangan i-confirm.",
        "",
        "IMPORTANTE - paano mag-type ng unit cost sa dashboard (Stock -> Recipes & Costs -> Unit costs):",
        "  Paid ₱ = kabuuang binayaran.  for = ilan ang laman.  Unit = kg, L, box, pack, atbp.",
        "  Halimbawa: Cream cheese, ₱1050 para sa 2 kg  ->  1050, for 2, piliin ang 'kg'. Lalabas: ₱0.525 per g.",
        "  HUWAG iwan sa '1 g' kung box o kilo ang binili - magbibigay ng babala ang dashboard kapag sobrang mahal per gram.",
        "  May box o pack? Piliin '+ New size' minsan lang (hal. 1 box = 2000 g). Sa susunod: ₱___ for 1 box na lang.",
        "  Per scoop / per pump? Piliin 'kg (by weight)' at ilagay kung ilang grams ang isang scoop.",
        "  Food cost tab: pindutin ang menu item para makita ang bawat ingredient at palitan ang presyo doon mismo.",
        "  Bawat palit ng presyo ay naka-save sa History (sino, kailan, magkano).",
        "",
        "Mga tab:",
        "  1. Pakicheck - mga presyong hinulaan namin. Pakisulat ang tamang sagot.",
        "  2. Walang presyo pa - ginagamit na sa recipe pero wala pang presyo.",
        "  3. Tanong - mga hindi tugma sa dalawang sheet.",
        "  4. Recipes na kulang - pinakamabenta muna. Isang row bawat ingredient, gamit ang unit na nakalagay.",
        "",
        "Pwede pong i-type diretso sa dashboard o ibalik ang file na ito.",
    ]:
        ws.append([line])
        ws.cell(ws.max_row, 1).alignment = wrap

    ws = sheet("1 Pakicheck", ["Ingredient", "Unit", "Ginamit namin", "Cost per unit na na-save", "Tama ba? (oo / tamang sagot)"],
               [34, 10, 52, 22, 40])
    for name, price, qty, note in estimates:
        unit = unit_of.get(name, "")
        ws.append([name, unit, f"₱{price:g} - {note}", f"₱{price / qty:.4f} per {unit}", ""])

    ws = sheet("2 Walang presyo pa", ["Category", "Ingredient", "Unit", "Ginagamit sa", "Binayaran (₱)", "Ilan ang laman", "Unit ng laman (kg, L, pack...)"],
               [22, 34, 10, 50, 14, 14, 26])
    for category, name, unit, items in no_price:
        ws.append([category, name, unit, f"{len(items)}: " + ", ".join(items[:4]) + ("…" if len(items) > 4 else ""), "", "", ""])

    ws = sheet("3 Tanong", ["Tungkol sa", "Tanong", "Sagot"], [24, 90, 40])
    for about, q in QUESTIONS:
        ws.append([about, q, ""])
        for c in ws[ws.max_row]:
            c.alignment = wrap

    ws = sheet("4 Recipes na kulang", ["Category", "Menu item", "Size", "Nabenta (30 araw)", "Ingredient", "Gaano karami per serving", "Unit"],
               [24, 34, 26, 16, 32, 22, 10])
    for product_id, item_sizes in missing_rows:
        product = product_by_id[product_id]
        for size in item_sizes:
            ws.append([product["category"], product["name"], size["size_label"], round(sold.get(size["id"], 0)), "", "", ""])
            ws.cell(ws.max_row, 2).font = Font(bold=True)
            for _ in range(3):
                ws.append(["", "", "", "", "", "", ""])

    ws = wb.create_sheet("Ingredient list")
    ws.append(["Ingredient", "Unit"])
    for ing in ingredients:
        if ing["name"] in gone:
            continue
        ws.append([renamed.get(ing["name"], ing["name"]), ing["base_unit"] if ing["name"] != "Scallion" else "g"])
    ws.column_dimensions["A"].width = 40

    wb.save(args.out)
    print(f"{args.out}: {len(estimates)} to confirm, {len(no_price)} with no price, "
          f"{sum(len(v) for _, v in missing_rows)} sizes ({len(missing_rows)} items) with no recipe")
    return 0


if __name__ == "__main__":
    sys.exit(main())
