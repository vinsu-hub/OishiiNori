"""Renders a kitchen prep ticket to any python-escpos printer instance
(Serial for the real XP-58H, Dummy for --test-print) -- same rendering
code either way, so a ticket can be proofed on-screen/to-file before ever
touching Bluetooth. 58mm paper, ~32 chars/line at default font (configurable
via PAPER_WIDTH_CHARS).

Item names/sizes aren't on the transaction_item itself (only
product_size_id) -- resolved via `product_index`, built the same way
KitchenDisplay.tsx builds its own client-side sizeIndex from GET /products.
"""

from __future__ import annotations

import unicodedata
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

PH_TZ = ZoneInfo("Asia/Manila")

_ORDER_TYPE_LABEL = {
    "dine_in": "DINE IN",
    "takeout": "TAKEOUT",
    "delivery": "DELIVERY",
}

# Real product size labels in this catalog use an en dash ("2–3 pax"),
# which the printer's default single-byte codepage (CP437) can't represent
# -- python-escpos silently substitutes a mangled replacement byte rather
# than raising, so this went unnoticed until tested against real order
# data. Map the common offenders to a plain-ASCII equivalent up front;
# anything else unmapped still falls back to a safe replacement instead of
# a garbled/undefined glyph on the actual paper.
_ASCII_REPLACEMENTS = {
    "–": "-",  # en dash
    "—": "--",  # em dash
    "‘": "'",
    "’": "'",
    "“": '"',
    "”": '"',
    "…": "...",
}


def _ascii_safe(text: str) -> str:
    for char, replacement in _ASCII_REPLACEMENTS.items():
        text = text.replace(char, replacement)
    # NFKD-normalize anything else non-ASCII left (accented letters, etc.)
    # down to its closest ASCII form rather than risk an encoding error or
    # an undefined glyph on the actual printer.
    normalized = unicodedata.normalize("NFKD", text)
    return normalized.encode("ascii", "replace").decode("ascii")


def _ph_time_12h(iso_timestamp: str) -> str:
    dt = datetime.fromisoformat(iso_timestamp.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    local = dt.astimezone(PH_TZ)
    # %I gives a zero-padded hour (e.g. "09:05 AM") -- strip the leading
    # zero to match this project's formatTime12h convention elsewhere.
    return local.strftime("%I:%M %p").lstrip("0")


def _wrap_line(prefix: str, text: str, width: int) -> list[str]:
    """A held-ingredient/addon note is usually short, but never trust that
    -- wrap rather than let a long ingredient name blow past the paper
    width uncontrolled."""
    full = f"{prefix}{text}"
    if len(full) <= width:
        return [full]
    lines = []
    indent = " " * len(prefix)
    words = text.split(" ")
    current = prefix
    for word in words:
        candidate = f"{current}{word} " if current != prefix else f"{prefix}{word} "
        if len(candidate) > width and current != prefix:
            lines.append(current.rstrip())
            current = f"{indent}{word} "
        else:
            current = candidate
    if current.strip():
        lines.append(current.rstrip())
    return lines


def build_ticket_header(transaction: dict, width: int) -> list[str]:
    order_number = transaction.get("order_number")
    order_type = transaction.get("order_type") or "takeout"
    table_number = transaction.get("table_number")
    delivery = transaction.get("delivery")

    lines = [f"ORDER #{order_number if order_number is not None else transaction['id'][:8]}".center(width)]
    if order_type == "dine_in" and table_number is not None:
        lines.append(f"TABLE {table_number}".center(width))
    else:
        lines.append(_ORDER_TYPE_LABEL.get(order_type, order_type.upper()).center(width))
    if delivery:
        # Wrapped, not hard-truncated -- a long customer name/address must
        # never silently lose characters off the end (a real name did,
        # caught in testing: "Maria Consolacion Fernandez-Reyes" ->
        # "...Fernandez-Reye" with the final "s" just gone, no indication
        # it was cut).
        for wrapped in _wrap_line("", _ascii_safe(delivery.get("customer_name", "")), width):
            lines.append(wrapped.center(width))
        if delivery.get("customer_phone"):
            for wrapped in _wrap_line("", _ascii_safe(delivery["customer_phone"]), width):
                lines.append(wrapped.center(width))
        address = delivery.get("address") or ""
        if delivery.get("landmark"):
            address = f"{address} ({delivery['landmark']})"
        for wrapped in _wrap_line("", _ascii_safe(address), width):
            lines.append(wrapped)
    lines.append(_ph_time_12h(transaction["opened_at"]).center(width))
    return lines


def build_item_lines(item: dict, product_index: dict, width: int) -> tuple[list[str], list[str]]:
    """Returns (head_lines, sub_lines) -- head_lines plural because a long
    product name + size label routinely exceeds 32 chars (real catalog
    data does, e.g. "Spicy Tuna Baked Sushi (Small (2-3 pax))") and must
    wrap rather than overrun the paper width uncontrolled, same as the
    held-ingredient/addon sub-lines already did."""
    resolved = product_index.get(item["product_size_id"])
    name = f"{resolved['name']} ({resolved['size_label']})" if resolved else "Item"
    head = _ascii_safe(f"{item['quantity']:g}x {name}")
    head_lines = _wrap_line("", head, width)

    sub_lines: list[str] = []
    for held in item.get("held_ingredients") or []:
        sub_lines.extend(_wrap_line("  - NO ", _ascii_safe(held), width))
    for addon in item.get("addons") or []:
        addon_name = addon.get("addon_name") or "Add-on"
        qty = addon.get("quantity", 1)
        suffix = f" x{qty}" if qty and qty > 1 else ""
        sub_lines.extend(_wrap_line("  + ", _ascii_safe(f"{addon_name}{suffix}"), width))
    return head_lines, sub_lines


def render_preview_text(transaction: dict, product_index: dict, width: int = 32) -> str:
    """Plain-text reconstruction of the ticket for --test-print's human-
    readable preview -- built from the same header/item line functions
    print_ticket uses, not by decoding the raw ESC/POS byte stream (which
    contains command bytes that also happen to be printable characters
    and would otherwise garble a naive preview)."""
    divider = "-" * width
    lines = list(build_ticket_header(transaction, width))
    lines.append(divider)
    for item in transaction.get("items", []):
        head_lines, sub_lines = build_item_lines(item, product_index, width)
        lines.extend(head_lines)
        lines.extend(sub_lines)
    lines.append(divider)
    return "\n".join(lines)


def print_ticket(printer, transaction: dict, product_index: dict, width: int = 32) -> None:
    """Writes the full ticket to `printer` (any escpos.printer.Escpos
    subclass -- Serial for the real device, Dummy for a dry run) and cuts
    the paper. Caller is responsible for opening/closing the connection."""
    divider = "-" * width

    printer.set(align="center", bold=True, double_height=True)
    for line in build_ticket_header(transaction, width):
        printer.text(line + "\n")

    printer.set(align="left", bold=False, double_height=False)
    printer.text(divider + "\n")

    for item in transaction.get("items", []):
        head_lines, sub_lines = build_item_lines(item, product_index, width)
        printer.set(align="left", bold=True, double_height=False)
        for line in head_lines:
            printer.text(line + "\n")
        if sub_lines:
            printer.set(align="left", bold=False, double_height=False)
            for line in sub_lines:
                printer.text(line + "\n")

    printer.set(align="left", bold=False, double_height=False)
    printer.text(divider + "\n")
    printer.text("\n")
    printer.cut()
