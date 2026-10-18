"""Delivery fee table from the owner (2026-10-19): Santa Cruz barangays plus nearby towns.

Fees are matched by exact name (delivery_fees.barangay), so a whole town is a
row named after the town. `zone` groups the checkout dropdown.

    cd services/api-fastapi
    .venv/bin/python scripts/update_delivery_fees.py           # dry run
    .venv/bin/python scripts/update_delivery_fees.py --apply
"""
import argparse
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

SANTA_CRUZ = {
    "Alipit": 150, "Bagumbayan": 80, "Bubukal": 120, "Calios": 80, "Duhat": 120, "Gatid": 120,
    "Jasaan": 180, "Labuin": 120, "Malinao": 150, "Oogong": 150, "Pagsawitan": 80, "Palasan": 120,
    "Patimbao": 80, "Poblacion I": 70, "Poblacion II": 70, "Poblacion III": 70, "Poblacion IV": 70,
    "Poblacion V": 70, "San Jose": 130, "San Juan": 120, "San Pablo Norte": 70, "San Pablo Sur": 70,
    "Santisima Cruz": 80, "Santo Angel Central": 70, "Santo Angel Norte": 80, "Santo Angel Sur": 70,
}
NEARBY_TOWNS = {
    "Pagsanjan": 120, "Pila": 200, "Lumban": 150, "Magdalena": 200, "Victoria": 250, "Calauan": 400,
    "Cavinti": 350, "Luisiana": 400, "Nagcarlan": 350, "Liliw": 350, "Bay": 400, "Pakil": 350,
    "Kalayaan": 350, "Paete": 350,
}
ZONES = {"Santa Cruz": SANTA_CRUZ, "Nearby towns": NEARBY_TOWNS}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    from app.deps import get_supabase
    db = get_supabase()
    current = {r["barangay"]: r for r in db.table("delivery_fees").select("barangay,zone,fee").execute().data}
    changes = 0
    for zone, fees in ZONES.items():
        for name, fee in fees.items():
            row = current.get(name)
            if row and float(row["fee"]) == fee and row["zone"] == zone:
                continue
            was = f"₱{float(row['fee']):g} ({row['zone']})" if row else "new"
            print(f"  {name:22} {was:>26} -> ₱{fee} ({zone})")
            changes += 1
            if args.apply:
                if row:
                    db.table("delivery_fees").update({"fee": fee, "zone": zone}).eq("barangay", name).execute()
                else:
                    db.table("delivery_fees").insert({"barangay": name, "zone": zone, "fee": fee}).execute()
    extra = sorted(set(current) - set(SANTA_CRUZ) - set(NEARBY_TOWNS))
    if extra:
        print(f"Not on the owner's list (left as is): {extra}")
    print(f"{changes} change(s)." + ("" if args.apply else " Dry run; --apply to write."))
    return 0


if __name__ == "__main__":
    sys.exit(main())
