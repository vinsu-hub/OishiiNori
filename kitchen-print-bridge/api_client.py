"""Thin wrapper over the two backend calls this bridge needs -- both
endpoints the browser frontends already use (GET /transactions, now with
the kitchen_status filter added for this bridge, and GET /products), so no
new backend surface exists beyond that one filter param."""

from __future__ import annotations

import requests

from auth import BridgeAuth
from config import Config


def _get(config: Config, auth: BridgeAuth, path: str, params: dict | None = None) -> requests.Response:
    r = requests.get(
        f"{config.api_base_url}{path}",
        params=params,
        headers=auth.auth_header(),
        timeout=30,
    )
    if r.status_code == 401:
        # Token expired/revoked mid-run -- force a refresh and retry once,
        # rather than treating an expired token like a real server error.
        r = requests.get(
            f"{config.api_base_url}{path}",
            params=params,
            headers=auth.auth_header(force_refresh=True),
            timeout=30,
        )
    r.raise_for_status()
    return r


def fetch_preparing_transactions(config: Config, auth: BridgeAuth) -> list[dict]:
    """Orders the kitchen has accepted (queued -> preparing) but this
    bridge hasn't necessarily printed yet -- state.PrintedTicketStore does
    the actual dedupe, this just returns the current live set."""
    return _get(config, auth, "/transactions", params={"kitchen_status": "preparing"}).json()


def fetch_products(config: Config, auth: BridgeAuth) -> list[dict]:
    return _get(config, auth, "/products").json()


def build_product_index(products: list[dict]) -> dict[str, dict]:
    """product_size_id -> {name, size_label} -- mirrors KitchenDisplay.tsx's
    own client-side sizeIndex, since a transaction_item only carries
    product_size_id, never a product name."""
    index: dict[str, dict] = {}
    for product in products:
        for size in product.get("sizes", []):
            index[size["id"]] = {"name": product["name"], "size_label": size["size_label"]}
    return index
