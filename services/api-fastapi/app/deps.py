import os
from functools import lru_cache
from pathlib import Path

from dotenv import load_dotenv
from supabase import Client, create_client

# This project's convention is `.env.local` (see .env.example / scripts/
# seed_from_xlsx.py), not the python-dotenv default of `.env` -- load it
# explicitly by path so this works regardless of the process's cwd.
load_dotenv(Path(__file__).resolve().parent.parent / ".env.local")


@lru_cache
def get_supabase() -> Client:
    """Cached service-role Supabase client for the whole process.

    Uses SUPABASE_SECRET_KEY (service_role-equivalent secret key) so this
    backend bypasses RLS entirely, same as the SMFC reference's deps.py.
    Every router goes through this client rather than opening its own
    connection.
    """
    url = os.environ["SUPABASE_URL"]
    key = os.environ["SUPABASE_SECRET_KEY"]
    return create_client(url, key)
