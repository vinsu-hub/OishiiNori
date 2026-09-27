"""One-time setup: creates the `applicant-photos` Supabase Storage bucket used
by applicants.py's resume-photo upload endpoint. Idempotent -- safe to rerun,
only creates the bucket if it doesn't already exist. Same pattern as
create_review_photos_bucket.py.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.stdout.reconfigure(encoding="utf-8")

from app.deps import get_supabase  # noqa: E402

BUCKET_NAME = "applicant-photos"

supabase = get_supabase()
existing_buckets = [b.name for b in supabase.storage.list_buckets()]

if BUCKET_NAME in existing_buckets:
    print(f"Bucket '{BUCKET_NAME}' already exists -- nothing to do.")
else:
    supabase.storage.create_bucket(
        BUCKET_NAME,
        options={
            "public": True,
            "file_size_limit": 8 * 1024 * 1024,
            "allowed_mime_types": ["image/jpeg", "image/png"],
        },
    )
    print(f"Created bucket '{BUCKET_NAME}' (public read, 8MB limit, jpeg/png only -- no PDF).")
