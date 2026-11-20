"""Who changed what on an item (migration 0089's item_edit_log), shown on
the item page. Best-effort: a failed log line never fails the edit."""
import logging

from app.prep_chain import batches_supported

log = logging.getLogger(__name__)


def log_item_edit(
    supabase,
    field: str,
    before,
    after,
    changed_by: str | None,
    ingredient_id: str | None = None,
    stock_item_id: str | None = None,
) -> None:
    if before == after or not batches_supported(supabase):
        return
    try:
        supabase.table("item_edit_log").insert({
            "ingredient_id": ingredient_id, "stock_item_id": stock_item_id, "field": field,
            "before": before, "after": after, "changed_by": changed_by,
        }).execute()
    except Exception:  # pragma: no cover - logged, never raised
        log.exception("could not log %s edit", field)
