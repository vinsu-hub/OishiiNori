/** The low-stock rule -- same as the API's app/stock_alerts.py.
 *
 * Low = counted since the last stock reset, has a real threshold (> 0), and
 * stock <= threshold. A stock that was reset and not counted yet is "not
 * counted", never "low" (before migration 0086 there's no last_counted_at
 * and everything counts as counted). */
import type { ApiIngredient } from './api';

export function isCounted(ing: Pick<ApiIngredient, 'last_counted_at'>): boolean {
  return ing.last_counted_at === undefined || ing.last_counted_at !== null;
}

export function isLowIngredient(ing: Pick<ApiIngredient, 'current_stock' | 'reorder_threshold' | 'last_counted_at'>): boolean {
  return isCounted(ing) && ing.reorder_threshold > 0 && ing.current_stock <= ing.reorder_threshold;
}

export function isLowStockItem(item: { current_stock: number; reorder_threshold: number | null; ingredient_id?: string | null }): boolean {
  // A linked item's stock lives on its ingredient, which alerts on its own.
  if (item.ingredient_id) return false;
  return item.reorder_threshold != null && item.reorder_threshold > 0 && item.current_stock <= item.reorder_threshold;
}
