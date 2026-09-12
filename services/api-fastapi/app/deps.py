import os
from functools import lru_cache
from pathlib import Path

import httpx
from dotenv import load_dotenv
from supabase import Client, create_client
from supabase.lib.client_options import SyncClientOptions

# This project's convention is `.env.local` (see .env.example / scripts/
# seed_from_xlsx.py), not the python-dotenv default of `.env` -- load it
# explicitly by path so this works regardless of the process's cwd.
load_dotenv(Path(__file__).resolve().parent.parent / ".env.local")


class _RetryOnDisconnectTransport(httpx.HTTPTransport):
    """Vercel can freeze and later reuse a serverless function's execution
    environment -- the pooled keep-alive connection this httpx client holds
    to Supabase's PostgREST can go stale (closed by the remote or an idle
    middlebox) while frozen. httpx's own `HTTPTransport(retries=N)` only
    retries the TCP-connect stage, not this case: the *next* request that
    tries to reuse the dead connection fails immediately with
    RemoteProtocolError -- observed in production as a real, if rare, 500
    on otherwise-correct requests (e.g. GET /digital-orders).

    Retrying exactly this exception, exactly once, is safe even for a
    write (POST/PATCH/DELETE): it fires when httpx detects the reused
    connection was already closed by the peer *before* any request bytes
    went out, so a retry can't double-execute anything -- same reasoning
    the frontend's own network-error retry already relies on (see
    fetchWithRetry in apps/dashboard-web/client/src/lib/api.ts). Any other
    exception (a real timeout, a genuine outage) is left alone rather than
    masked by a retry loop.
    """

    def handle_request(self, request: httpx.Request) -> httpx.Response:
        try:
            return super().handle_request(request)
        except httpx.RemoteProtocolError:
            return super().handle_request(request)


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
    # httpx's default timeout is a flat 5s across connect/read/write/pool --
    # observed in production as a real ReadTimeout (500) on an otherwise-fast
    # query, most likely a Vercel cold start reaching a cold Supabase/
    # PostgREST connection. 20s gives that room without masking a genuine
    # outage (a request that's still hanging at 20s is not a normal blip).
    timeout = httpx.Timeout(20.0)
    options = SyncClientOptions(httpx_client=httpx.Client(transport=_RetryOnDisconnectTransport(), timeout=timeout))
    return create_client(url, key, options=options)
