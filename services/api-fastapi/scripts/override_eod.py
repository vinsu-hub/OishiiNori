"""Override End-of-Day for a shift that couldn't be closed (e.g. an outage).

Vercel paused every app on the evening of 2026-10-16, so the cashier never
did End-of-Day and the next morning's orders landed in the old shift. This
closes that shift at a cutoff time and, optionally, opens the next one at a
chosen time, so each day's report covers only its own orders (sales are
picked by time, see shift_reports._sales).

The drawer was never counted, so the closed report is marked
cash_count_pending. Executives see it as a notification and type the counted
cash on the Shift Reports page (POST /shift-reports/{id}/cash-count).

    cd services/api-fastapi
    .venv/bin/python scripts/override_eod.py --cutoff 2026-10-17T00:00:00+08:00 \\
        --open-next-at 2026-10-17T10:45:00+08:00 --reason "Vercel outage"         # dry run
    ... --apply                                                               # write it
"""
import argparse
import json
import os
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--cutoff", required=True, help="close the open shift at this time (ISO, with offset)")
    parser.add_argument("--open-next-at", help="open the next shift at this time (ISO, with offset)")
    parser.add_argument("--opened-by", help="profile id for the next shift (default: whoever opened the old one)")
    parser.add_argument("--reason", required=True)
    parser.add_argument("--apply", action="store_true", help="write the changes (default is a dry run)")
    args = parser.parse_args()

    from app.deps import get_supabase
    from app.routers.business_days import fetch_open_shift
    from app.routers.shift_reports import build_shift_report

    db = get_supabase()
    shift = fetch_open_shift(db)
    if not shift or shift.get("report_version") != 1:
        print("No report-enabled shift is open; nothing to override.")
        return 1
    cutoff = datetime.fromisoformat(args.cutoff).astimezone(timezone.utc)
    next_at = datetime.fromisoformat(args.open_next_at).astimezone(timezone.utc) if args.open_next_at else None
    if cutoff <= datetime.fromisoformat(shift["opened_at"]):
        print("Cutoff is before the shift opened.")
        return 1
    if next_at and next_at < cutoff:
        print("The next shift can't open before the cutoff.")
        return 1
    next_date = (next_at + timedelta(hours=8)).date() if next_at else None  # PH business date
    if next_date and db.table("business_days").select("id").eq("business_date", next_date.isoformat()).execute().data:
        print(f"{next_date} already has a shift.")
        return 1

    report = build_shift_report(db, shift, cutoff, 0)
    report["cash_drawer"]["actual_cash"] = None
    report["cash_drawer"]["difference"] = None
    report["cash_count_pending"] = True
    report["override_note"] = f"End-of-Day override: {args.reason}. Closed by the system at {args.cutoff}."
    print(f"Close shift #{shift['shift_number']} ({shift['business_date']}) at {cutoff.isoformat()}")
    print(f"  {report['sales']['order_count']} paid orders, net {report['sales']['net']:.2f}, "
          f"expected cash {report['cash_drawer']['expected_cash']:.2f}, payments {json.dumps(report['payments'])}")
    if next_at:
        print(f"Open shift for {next_date} at {next_at.isoformat()}")
    if not args.apply:
        print("Dry run. Re-run with --apply to write.")
        return 0

    closed = (db.table("business_days").update({
        "closing_at": report["closed_at"], "closed_at": report["closed_at"],
        "system_eod_total": report["cash_drawer"]["expected_cash"], "shift_report": report,
    }).eq("id", shift["id"]).is_("closed_at", "null").is_("closing_at", "null").execute().data)
    if not closed:
        print("The shift changed while this ran; nothing written.")
        return 1
    print("Closed.")
    if next_at:
        opened = db.table("business_days").insert({
            "business_date": next_date.isoformat(), "opened_at": next_at.isoformat(),
            "opened_by": args.opened_by or shift["opened_by"], "menu_confirmed": True,
            "starting_cash": 0, "report_version": 1,
        }).execute().data[0]
        print(f"Opened shift #{opened['shift_number']} for {opened['business_date']}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
