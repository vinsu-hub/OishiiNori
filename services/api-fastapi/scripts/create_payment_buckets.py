"""One-time setup: creates the `payment-qr-codes` and `payment-proofs`
Supabase Storage buckets used by payment_methods.py's QR-code upload
endpoint and digital_menu.py's proof-of-payment upload endpoint.
Idempotent -- safe to rerun, only creates a bucket if it doesn't already
exist. Same pattern as create_product_images_bucket.py.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.stdout.reconfigure(encoding="utf-8")

from app.deps import get_supabase  # noqa: E402

BUCKETS = ["payment-qr-codes", "payment-proofs"]

supabase = get_supabase()
existing_buckets = [b.name for b in supabase.storage.list_buckets()]

for bucket_name in BUCKETS:
    if bucket_name in existing_buckets:
        print(f"Bucket '{bucket_name}' already exists -- nothing to do.")
        continue
    supabase.storage.create_bucket(
        bucket_name,
        options={
            "public": True,
            "file_size_limit": 5 * 1024 * 1024,
            "allowed_mime_types": ["image/jpeg", "image/png", "image/webp"],
        },
    )
    print(f"Created bucket '{bucket_name}' (public read, 5MB limit, jpeg/png/webp only).")
