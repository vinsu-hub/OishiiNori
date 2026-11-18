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
  g: [{ name: 'kg', factor: 1000 }, { name: 'lb', factor: 453.592 }],
  ml: [{ name: 'L', factor: 1000 }, { name: 'gallon', factor: 3785 }],
};

// Spellings the catalog actually has ("grams", "Liter") for the two bases
// that convert by weight/volume.
const ALIASES: Record<string, string> = {
  g: 'g', gram: 'g', grams: 'g', gr: 'g', grms: 'g',
  ml: 'ml', milliliter: 'ml', milliliters: 'ml', millilitre: 'ml', millilitres: 'ml',
};

/** 'g' or 'ml' when the base unit is a weight/volume, else null. */
export function measureOf(baseUnit: string | null | undefined): 'g' | 'ml' | null {
  const key = ALIASES[(baseUnit || '').trim().toLowerCase()];
  return key === 'g' || key === 'ml' ? key : null;
}

/** Count-style units (scoop, pump, pcs...) that may need "1 scoop weighs N g". */
export function isCountUnit(baseUnit: string | null | undefined): boolean {
  return measureOf(baseUnit) === null;
}

export function unitOptionsFor(baseUnit: string | null | undefined, saved: ApiItemUnit[]): UnitOption[] {
  const base = (baseUnit || 'pcs').trim();
  const opts: UnitOption[] = [{ key: 'base', name: base, factor: 1 }];
  for (const s of STANDARD[measureOf(base) ?? ''] ?? []) opts.push({ key: `std:${s.name}`, name: s.name, factor: s.factor });
  for (const u of [...saved].sort((a, b) => b.base_qty - a.base_qty)) {
    if (opts.some((o) => o.name.toLowerCase() === u.name.toLowerCase())) continue;
    opts.push({ key: u.id, name: u.name, factor: u.base_qty, savedId: u.id });
  }
  return opts;
}

/** Boxes for counting one item in all its units at once (EOD Stock Count):
 * each saved size (pack, box... largest first) gets its own box, then the
 * base unit, whose box can also take kg / L for weight and volume items.
 * Total in base units = sum of qty x factor. */
export function countUnitsFor(baseUnit: string | null | undefined, saved: ApiItemUnit[]): { sizes: UnitOption[]; baseOptions: UnitOption[] } {
  const all = unitOptionsFor(baseUnit, saved);
  return {
    sizes: all.filter((o) => o.savedId).sort((a, b) => b.factor - a.factor),
    baseOptions: all.filter((o) => !o.savedId),
  };
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
