"""Create the Halloween Junior Sushi Making Class event (owner's poster, 2026-10-19).

Needs migration 0078 and the event-images bucket (scripts/create_event_images_bucket.py).
Skips if an event with the same title already exists.

    .venv/bin/python scripts/seed_event.py [--apply]
"""
import argparse
import os
import sys
import uuid
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

POSTER = Path(__file__).parent / "assets" / "events" / "halloween-junior-sushi-poster.png"
EVENT = {
    "title": "Halloween Junior Sushi Making Class 🎃",
    "starts_at": "2026-10-31T08:30:00+08:00",
    "location": "Pedro Guevarra Avenue beside STI College, Sta. Cruz, Laguna",
    "price_label": "₱799 per child · Ages 5–12",
    "description": (
        "Roll. Create. Treat. Repeat. A Halloween sushi class for kids aged 5 to 12.\n\n"
        "Inclusions:\n"
        "• Junior Sushi Making Class (45–60 minutes)\n"
        "• Kids make their own 8 pcs sushi\n"
        "• 1 drink\n"
        "• Certificate of participation\n"
        "• Halloween goodie bag\n"
        "• Photo opportunity\n"
        "• FREE 4-pc California Maki voucher (for next visit)\n\n"
        "Limited slots only! Come in your cutest or spookiest Halloween costume."
    ),
    "listed": True,
    "signups_open": True,
    "slots_full": False,
}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    from app.deps import get_supabase
    db = get_supabase()
    if db.table("events").select("id").eq("title", EVENT["title"]).execute().data:
        print("Event already exists; nothing to do.")
        return 0
    print(f"Create: {EVENT['title']} on {EVENT['starts_at']} with poster {POSTER.name} ({POSTER.stat().st_size // 1024} KB)")
    if not args.apply:
        print("Dry run; --apply to write.")
        return 0
    event = db.table("events").insert(EVENT).execute().data[0]
    # Compressed JPEG copy: the original PNG is ~2 MB.
    import io
    from PIL import Image
    buffer = io.BytesIO()
    Image.open(POSTER).convert("RGB").save(buffer, "JPEG", quality=82, optimize=True, progressive=True)
    path = f"{event['id']}/{uuid.uuid4()}.jpg"
    db.storage.from_("event-images").upload(path, buffer.getvalue(), file_options={"content-type": "image/jpeg"})
    url = db.storage.from_("event-images").get_public_url(path)
    db.table("events").update({"image_url": url}).eq("id", event["id"]).execute()
    print(f"Created event {event['id']} with poster {url}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
