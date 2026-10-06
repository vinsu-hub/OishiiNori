/** Units of measure for stock logging and recipes.
 *
 * Every stock number is stored in the item's BASE unit (what recipes deduct
 * in). A unit option is just "how many base units is one of these", so
 * logging 2 packs of nori (pack = 100 sheets) records 200 sheets, and a
 * recipe can say 1 mini sheet (= 0.25 sheet). */
import type { ApiItemUnit } from './api';

export interface UnitOption {
  /** Stable select value: 'base', 'std:kg', or the item_units row id. */
  key: string;
  name: string;
  /** Base units in ONE of this unit. */
  factor: number;
  /** Saved per-item unit (can be deleted), vs base / built-in. */
  savedId?: string;
}

// Built-in conversions that never need setting up.
const STANDARD: Record<string, { name: string; factor: number }[]> = {
  g: [{ name: 'kg', factor: 1000 }],
  ml: [{ name: 'L', factor: 1000 }],
};

export function unitOptionsFor(baseUnit: string | null | undefined, saved: ApiItemUnit[]): UnitOption[] {
  const base = (baseUnit || 'pcs').trim();
  const opts: UnitOption[] = [{ key: 'base', name: base, factor: 1 }];
  for (const s of STANDARD[base.toLowerCase()] ?? []) opts.push({ key: `std:${s.name}`, name: s.name, factor: s.factor });
  for (const u of [...saved].sort((a, b) => b.base_qty - a.base_qty)) {
    if (opts.some((o) => o.name.toLowerCase() === u.name.toLowerCase())) continue;
    opts.push({ key: u.id, name: u.name, factor: u.base_qty, savedId: u.id });
  }
  return opts;
}

export function unitsForItem(saved: ApiItemUnit[], kind: 'ingredient' | 'stock_item', id: string): ApiItemUnit[] {
  return saved.filter((u) => (kind === 'ingredient' ? u.ingredient_id === id : u.stock_item_id === id));
}

/** Trims float noise for display: 0.25, 100, 12.5 -- never 0.30000000000000004. */
export function fmtQty(n: number): string {
  return String(Math.round(n * 1000) / 1000);
}

export function describeUnit(o: UnitOption, baseUnit: string): string {
  return o.key === 'base' ? o.name : `${o.name} · ${fmtQty(o.factor)} ${baseUnit}`;
}

// Common containers offered when creating a unit.
export const COMMON_UNIT_NAMES = ['pack', 'box', 'tray', 'bottle', 'bag', 'case', 'can', 'jar', 'piece', 'roll'];
