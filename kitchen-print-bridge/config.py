"""Loads kitchen-print-bridge/.env -- see .env.example for every field and
what it's for. Kept as one dataclass, same posture as the rest of this repo
(services/api-fastapi/scripts/*.py load .env.local the same way) rather than
scattering os.environ[...] reads across the other modules."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv


@dataclass(frozen=True)
class Config:
    api_base_url: str
    supabase_url: str
    supabase_anon_key: str
    bridge_email: str
    bridge_password: str
    poll_interval_seconds: int
    bt_port: str
    bt_baudrate: int
    paper_width_chars: int
    state_db_path: str
    log_file_path: str


def load_config(env_path: Path | None = None) -> Config:
    """Fields needed only to reach the live backend/printer (Supabase
    creds, BT port) are left blank if unset rather than raising here --
    `--test-print` needs none of them. `require_live_fields()` below is
    what actually enforces they're set, called only by the real poll loop."""
    load_dotenv(env_path or Path(__file__).resolve().parent / ".env")

    return Config(
        api_base_url=os.environ.get("API_BASE_URL", "https://oishii-nori-api.vercel.app").rstrip("/"),
        supabase_url=os.environ.get("SUPABASE_URL", "").strip(),
        supabase_anon_key=os.environ.get("SUPABASE_ANON_KEY", "").strip(),
        bridge_email=os.environ.get("BRIDGE_EMAIL", "").strip(),
        bridge_password=os.environ.get("BRIDGE_PASSWORD", "").strip(),
        poll_interval_seconds=int(os.environ.get("POLL_INTERVAL_SECONDS", "20")),
        bt_port=os.environ.get("BT_PORT", "COM5"),
        bt_baudrate=int(os.environ.get("BT_BAUDRATE", "9600")),
        paper_width_chars=int(os.environ.get("PAPER_WIDTH_CHARS", "32")),
        state_db_path=os.environ.get("STATE_DB_PATH", "printed_tickets.db"),
        log_file_path=os.environ.get("LOG_FILE_PATH", "bridge.log"),
    )


def require_live_fields(config: Config) -> None:
    missing = [
        name
        for name, value in [
            ("SUPABASE_URL", config.supabase_url),
            ("SUPABASE_ANON_KEY", config.supabase_anon_key),
            ("BRIDGE_EMAIL", config.bridge_email),
            ("BRIDGE_PASSWORD", config.bridge_password),
        ]
        if not value
    ]
    if missing:
        raise RuntimeError(
            f"Missing required setting(s) {', '.join(missing)} -- copy .env.example to .env and fill it in."
        )
