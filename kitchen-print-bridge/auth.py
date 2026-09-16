"""Authenticates the bridge as a real Supabase user -- this backend has no
API-key/service-account path (every non-/public/* route requires a live
Supabase JWT via app/auth.py::get_current_user), so the bridge signs in as
a dedicated low-privilege account (see README.md) exactly the way every
frontend in this project already does via supabase.auth.signInWithPassword
(anon key + email/password), just via a direct GoTrue call instead of the
supabase-py/JS SDK -- mirroring the proven pattern in
services/api-fastapi/scripts/system_health_check.py::login(), which exists
because the installed supabase-py version doesn't get along with the
newer secret-key format in create_client(). Refreshes automatically once
the access token is close to expiring, or on a 401 from the API.
"""

from __future__ import annotations

import logging
import time

import requests

from config import Config

logger = logging.getLogger("kitchen_print_bridge.auth")


class BridgeAuth:
    def __init__(self, config: Config):
        self._config = config
        self._access_token: str | None = None
        self._refresh_token: str | None = None
        self._expires_at: float = 0.0

    def _token_endpoint(self, grant_type: str) -> str:
        return f"{self._config.supabase_url}/auth/v1/token?grant_type={grant_type}"

    def _apply(self, payload: dict) -> None:
        self._access_token = payload["access_token"]
        self._refresh_token = payload.get("refresh_token", self._refresh_token)
        # Refresh a bit early (60s buffer) rather than racing the exact
        # expiry instant against an in-flight poll cycle.
        self._expires_at = time.time() + int(payload.get("expires_in", 3600)) - 60

    def _login(self) -> None:
        r = requests.post(
            self._token_endpoint("password"),
            headers={"apikey": self._config.supabase_anon_key, "Content-Type": "application/json"},
            json={"email": self._config.bridge_email, "password": self._config.bridge_password},
            timeout=30,
        )
        if r.status_code != 200:
            raise RuntimeError(f"Login failed for {self._config.bridge_email}: {r.status_code} {r.text[:300]}")
        self._apply(r.json())
        logger.info("Signed in as %s", self._config.bridge_email)

    def _refresh(self) -> None:
        if not self._refresh_token:
            self._login()
            return
        r = requests.post(
            self._token_endpoint("refresh_token"),
            headers={"apikey": self._config.supabase_anon_key, "Content-Type": "application/json"},
            json={"refresh_token": self._refresh_token},
            timeout=30,
        )
        if r.status_code != 200:
            logger.warning("Token refresh failed (%s), falling back to a fresh login", r.status_code)
            self._login()
            return
        self._apply(r.json())
        logger.debug("Refreshed access token")

    def get_token(self, force_refresh: bool = False) -> str:
        """Returns a currently-valid access token, logging in or refreshing
        first if needed. Call with force_refresh=True after a 401."""
        if force_refresh or self._access_token is None:
            if self._access_token is None:
                self._login()
            else:
                self._refresh()
        elif time.time() >= self._expires_at:
            self._refresh()
        assert self._access_token is not None
        return self._access_token

    def auth_header(self, force_refresh: bool = False) -> dict:
        return {"Authorization": f"Bearer {self.get_token(force_refresh=force_refresh)}"}
