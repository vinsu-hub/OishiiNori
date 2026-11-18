import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { DashboardLayout } from '@/components/DashboardLayout';
import { useAuth } from '@/contexts/AuthContext';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Loader2, Search } from 'lucide-react';
import {
  ApiIngredient,
  ApiIngredientDailySummary,
  type ApiItemUnit,
  countStock,
  fetchIngredientCountEntries,
  fetchInventory,
  fetchItemUnits,
  updateIngredient,
} from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { describeUnit, fmtQty, unitOptionsFor, unitsForItem } from '@/lib/units';
import { isCounted, isLowIngredient } from '@/lib/stockAlerts';
import { STOCK_TABLE_CELL_CLASS, STOCK_TABLE_HEAD_CLASS, STOCK_TABLE_ROW_CLASS } from '@/components/stock/stockTableStyle';
import { groupBySection, sectionAnchor } from '@/components/stock/StationsPanel';
import { STOCK_STATIONS, STOCK_STATION_LABELS } from '@/lib/constants';

// WS-3 (Phase 7): EOD Stock Count VS view -- a per-ingredient row where the
// client manually counts stock (in whatever unit is convenient) against the
// system-computed ending (same POS-deduction math the Ingredient Stock tab
// already shows). Submitting a row calls the existing count endpoint
// (inventory.py's apply_ingredient_count, shared with the single-ingredient
// count tool), which already returns a signed variance and writes the
// audit trail -- this page's own contribution is the unit dropdown +
// side-by-side layout, not new counting logic.
//
// Units: the ingredient's base unit, kg/L for g/ml, and its saved sizes
// (item_units: pack, box, bottle ...), so a pack of crab sticks can be
// counted as "3 pack" and saved as 96 pcs.

// Rows follow the client's stock sheet like Station Items: a tab per
// station, the sheet's sections, its row order (ingredients.station /
// sheet_section / sort_order, filled by scripts/apply_ingredient_sheet_layout.py;
// the API already returns them in that order). Ingredients with no station
// go to Unsorted. Before migration 0080 nothing has a station, so the page
// stays one plain list.
const UNSORTED = 'unsorted';
type StationTab = (typeof STOCK_STATIONS)[number]['value'] | typeof UNSORTED;

function stationOf(ingredient: ApiIngredient): StationTab {
  return STOCK_STATIONS.some((s) => s.value === ingredient.station)
    ? (ingredient.station as StationTab)
    : UNSORTED;
}

function initialTab(): StationTab {
  const requested = new URLSearchParams(window.location.search).get('station');
  return STOCK_STATIONS.some((s) => s.value === requested) || requested === UNSORTED
    ? (requested as StationTab)
    : STOCK_STATIONS[0].value;
}

interface RowState {
  countValue: string;
  /** UnitOption key: 'base', 'std:kg', or an item_units id. */
  unit: string;
  saving: boolean;
  variance: number | null;
}

export default function StockVS() {
  const { user } = useAuth();
  const [ingredients, setIngredients] = useState<ApiIngredient[]>([]);
  const [summaries, setSummaries] = useState<ApiIngredientDailySummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [tab, setTab] = useState<StationTab>(initialTab);
  const [ingredientSearch, setIngredientSearch] = useState('');
  const [itemUnits, setItemUnits] = useState<ApiItemUnit[]>([]);
  const [thresholds, setThresholds] = useState<Record<string, string>>({});
  const canSetThreshold = user?.role === 'executive';

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([fetchInventory(), fetchIngredientCountEntries(), fetchItemUnits().catch(() => [] as ApiItemUnit[])])
      .then(([ing, sum, units]) => {
        setIngredients(ing);
        setSummaries(sum);
        setItemUnits(units);
      })
      .catch((e) => toast.error(e instanceof Error ? e.message : 'Failed to load stock VS data'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const summaryByIngredient = useMemo(
    () => new Map(summaries.map((s) => [s.ingredient_id, s])),
    [summaries]
  );

  const hasLayout = ingredients.some((i) => stationOf(i) !== UNSORTED);
  const tabCounts = useMemo(() => {
    const counts = new Map<StationTab, number>();
    for (const i of ingredients) counts.set(stationOf(i), (counts.get(stationOf(i)) ?? 0) + 1);
    return counts;
  }, [ingredients]);
  // A saved ?station=unsorted link once nothing is unsorted opens the first station.
  const activeTab: StationTab = tab === UNSORTED && !tabCounts.get(UNSORTED) ? STOCK_STATIONS[0].value : tab;
  const tabs: { value: StationTab; label: string }[] = [
    ...STOCK_STATIONS,
    ...(tabCounts.get(UNSORTED) ? [{ value: UNSORTED as StationTab, label: 'Unsorted' }] : []),
  ];

  const query = ingredientSearch.trim().toLowerCase();
  // A search looks across every station, so a row is found without knowing its tab.
  const sections = useMemo(() => {
    if (!hasLayout) return [{ section: '', items: ingredients }];
    if (query) {
      return groupBySection(
        ingredients.filter((i) => i.name.toLowerCase().includes(query)),
        (i) => {
          const station = stationOf(i);
          const label = station === UNSORTED ? 'Unsorted' : STOCK_STATION_LABELS[station];
          return i.sheet_section ? `${label} · ${i.sheet_section}` : label;
        },
      );
    }
    return groupBySection(
      ingredients.filter((i) => stationOf(i) === activeTab),
      (i) => i.sheet_section,
    );
  }, [ingredients, hasLayout, query, activeTab]);

  function selectTab(value: StationTab) {
    setTab(value);
    setIngredientSearch('');
    const params = new URLSearchParams(window.location.search);
    params.set('station', value);
    window.history.replaceState(null, '', `${window.location.pathname}?${params}`);
  }

  function rowState(id: string, _baseUnit: string): RowState {
    return rows[id] ?? { countValue: '', unit: 'base', saving: false, variance: null };
  }

  function optionsFor(ingredient: ApiIngredient) {
    return unitOptionsFor(ingredient.base_unit, unitsForItem(itemUnits, 'ingredient', ingredient.id));
  }

  const notCountedCount = ingredients.filter((i) => !isCounted(i)).length;
  const lowCount = ingredients.filter(isLowIngredient).length;

  async function saveThreshold(ingredient: ApiIngredient) {
    const raw = thresholds[ingredient.id];
    if (raw === undefined) return;
    const value = raw.trim() === '' ? 0 : Number(raw);
    if (!Number.isFinite(value) || value < 0) {
      toast.error('Low-stock level must be 0 or more');
      return;
    }
    if (value === ingredient.reorder_threshold) return;
    try {
      const updated = await updateIngredient(ingredient.id, { reorder_threshold: value });
      setIngredients((prev) => prev.map((i) => (i.id === ingredient.id ? { ...i, reorder_threshold: updated.reorder_threshold } : i)));
      setThresholds((prev) => {
        const next = { ...prev };
        delete next[ingredient.id];
        return next;
      });
      toast.success(value > 0 ? `${ingredient.name}: warns at ${fmtQty(value)} ${ingredient.base_unit}` : `${ingredient.name}: no low-stock warning`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save low-stock level');
    }
  }

  function updateRow(id: string, patch: Partial<RowState>, baseUnit: string) {
    setRows((prev) => ({ ...prev, [id]: { ...rowState(id, baseUnit), ...patch } }));
  }

  async function handleSave(ingredient: ApiIngredient) {
    if (!user) return;
    const row = rowState(ingredient.id, ingredient.base_unit);
    const raw = Number(row.countValue);
    if (!Number.isFinite(raw) || raw < 0) {
      toast.error('Enter a valid count');
      return;
    }
    const option = optionsFor(ingredient).find((o) => o.key === row.unit) ?? optionsFor(ingredient)[0];
    const converted = Math.round(raw * option.factor * 10000) / 10000;
    updateRow(ingredient.id, { saving: true }, ingredient.base_unit);
    try {
      const result = await countStock(ingredient.id, { employee_id: user.id, counted_stock: converted });
      updateRow(ingredient.id, { saving: false, variance: result.variance }, ingredient.base_unit);
      toast.success(`${ingredient.name} counted -- variance ${result.variance >= 0 ? '+' : ''}${result.variance}`);
      load();
    } catch (e) {
      updateRow(ingredient.id, { saving: false }, ingredient.base_unit);
      toast.error(e instanceof Error ? e.message : 'Failed to save count');
    }
  }

  if (user && user.role === 'employee' && !user.extraPages.includes('stock')) {
    return (
      <DashboardLayout title="EOD Stock Count (VS)">
        <div className="p-6">
          <p className="text-sm text-muted-foreground">You don't have access to this page.</p>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout title="EOD Stock Count (VS)">
      <div className="p-6 space-y-4">
        <Card>
          <CardHeader>
            <CardTitle className="font-corp-display text-base">
              {loading ? 'Loading...' : `${ingredients.length} ingredients`}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {!loading && hasLayout && (
              <div className="space-y-2">
                <Tabs value={activeTab} onValueChange={(v) => selectTab(v as StationTab)}>
                  <TabsList className="h-auto flex-wrap">
                    {tabs.map((t) => (
                      <TabsTrigger key={t.value} value={t.value}>
                        {t.label} <span className="ml-1 text-muted-foreground">{tabCounts.get(t.value) ?? 0}</span>
                      </TabsTrigger>
                    ))}
                  </TabsList>
                </Tabs>
                <div className="relative max-w-sm">
                  <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" aria-hidden />
                  <Input
                    className="pl-9"
                    placeholder="Find an ingredient (all stations)"
                    value={ingredientSearch}
                    onChange={(e) => setIngredientSearch(e.target.value)}
                    aria-label="Find an ingredient"
                  />
                </div>
                {!query && sections.length > 1 && (
                  <div className="flex flex-wrap gap-1.5" aria-label="Jump to section">
                    {sections.map((g) => (
                      <button
                        key={g.section}
                        type="button"
                        className="rounded-full border bg-muted/50 px-3 py-1 text-xs font-medium hover:bg-muted"
                        onClick={() => document.getElementById(sectionAnchor(`vs-${activeTab}`, g.section))?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                      >
                        {g.section} <span className="text-muted-foreground">{g.items.length}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              Enter today's physical count per ingredient, in whatever unit you actually measured in -- it's
              converted to the ingredient's own base unit before comparing against the system's computed ending
              (today's beginning + new stock − POS-deducted usage). <span className="font-medium text-foreground">Low at</span>{' '}
              is when it shows on Stock Alerts (leave 0 for no warning).
            </p>
            {!loading && (notCountedCount > 0 || lowCount > 0) && (
              <p className="text-sm">
                {notCountedCount > 0 && (
                  <span className="mr-3"><span className="font-semibold">{notCountedCount}</span> not counted yet</span>
                )}
                {lowCount > 0 && <span className="text-destructive"><span className="font-semibold">{lowCount}</span> low on stock</span>}
              </p>
            )}
            {loading ? (
              <div className="flex items-center justify-center py-8 text-muted-foreground">
                <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                Loading...
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className={STOCK_TABLE_ROW_CLASS}>
                    <TableHead className={STOCK_TABLE_HEAD_CLASS}>Ingredient</TableHead>
                    <TableHead className={`${STOCK_TABLE_HEAD_CLASS} text-right`}>System Ending</TableHead>
                    <TableHead className={STOCK_TABLE_HEAD_CLASS}>Manual Count</TableHead>
                    <TableHead className={STOCK_TABLE_HEAD_CLASS}>Unit</TableHead>
                    <TableHead className={`${STOCK_TABLE_HEAD_CLASS} text-right`}>Variance</TableHead>
                    <TableHead className={STOCK_TABLE_HEAD_CLASS}>Low at</TableHead>
                    <TableHead className={STOCK_TABLE_HEAD_CLASS} />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sections.length === 0 && (
                    <TableRow className={STOCK_TABLE_ROW_CLASS}>
                      <TableCell colSpan={7} className="py-6 text-center text-sm text-muted-foreground">
                        {query ? `No ingredient matches “${ingredientSearch.trim()}”.` : 'No ingredients at this station.'}
                      </TableCell>
                    </TableRow>
                  )}
                  {sections.map((group) => (
                    <React.Fragment key={group.section}>
                      {group.section && (
                        <TableRow className="bg-muted/60 hover:bg-muted/60">
                          <TableCell
                            colSpan={7}
                            id={sectionAnchor(`vs-${activeTab}`, group.section)}
                            className="scroll-mt-20 py-2 text-xs font-bold uppercase tracking-wide text-foreground"
                          >
                            {group.section}{' '}
                            <span className="font-normal normal-case text-muted-foreground">
                              · {group.items.length} ingredient{group.items.length === 1 ? '' : 's'}
                            </span>
                          </TableCell>
                        </TableRow>
                      )}
                  {group.items.map((ingredient) => {
                    const summary = summaryByIngredient.get(ingredient.id);
                    const systemEnding = summary?.ending ?? ingredient.current_stock;
                    const row = rowState(ingredient.id, ingredient.base_unit);
                    return (
                      <TableRow key={ingredient.id} className={STOCK_TABLE_ROW_CLASS}>
                        <TableCell className={`${STOCK_TABLE_CELL_CLASS} font-medium`}>
                          <span className="flex flex-wrap items-center gap-1.5">
                            {ingredient.name}
                            {isLowIngredient(ingredient) && <Badge variant="destructive">Low</Badge>}
                            {!isCounted(ingredient) && <Badge variant="outline" className="font-normal text-muted-foreground">Not counted yet</Badge>}
                          </span>
                        </TableCell>
                        <TableCell className={`${STOCK_TABLE_CELL_CLASS} text-right`}>
                          {systemEnding} {ingredient.base_unit}
                        </TableCell>
                        <TableCell className={STOCK_TABLE_CELL_CLASS}>
                          <Input
                            type="number"
                            min="0"
                            step="0.01"
                            className="w-28 h-8"
                            value={row.countValue}
                            onChange={(e) =>
                              updateRow(ingredient.id, { countValue: e.target.value }, ingredient.base_unit)
                            }
                          />
                        </TableCell>
                        <TableCell className={STOCK_TABLE_CELL_CLASS}>
                          <Select
                            value={row.unit}
                            onValueChange={(v) => updateRow(ingredient.id, { unit: v }, ingredient.base_unit)}
                          >
                            <SelectTrigger className="w-40 h-8" aria-label={`Unit counted for ${ingredient.name}`}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {optionsFor(ingredient).map((o) => (
                                <SelectItem key={o.key} value={o.key}>
                                  {describeUnit(o, ingredient.base_unit)}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </TableCell>
                        <TableCell
                          className={`${STOCK_TABLE_CELL_CLASS} text-right font-semibold ${
                            row.variance != null && Math.abs(row.variance) > 0.001 ? 'text-destructive' : ''
                          }`}
                        >
                          {row.variance != null ? `${row.variance >= 0 ? '+' : ''}${row.variance}` : '--'}
                        </TableCell>
                        <TableCell className={STOCK_TABLE_CELL_CLASS}>
                          {canSetThreshold ? (
                            <div className="flex items-center gap-1">
                              <Input
                                type="number"
                                min="0"
                                step="any"
                                className="h-8 w-24"
                                aria-label={`Low-stock level for ${ingredient.name}`}
                                value={thresholds[ingredient.id] ?? (ingredient.reorder_threshold ? String(ingredient.reorder_threshold) : '')}
                                placeholder="0"
                                onChange={(e) => setThresholds((prev) => ({ ...prev, [ingredient.id]: e.target.value }))}
                                onBlur={() => saveThreshold(ingredient)}
                                onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()}
                              />
                              <span className="text-xs text-muted-foreground">{ingredient.base_unit}</span>
                            </div>
                          ) : (
                            <span className="text-sm text-muted-foreground">
                              {ingredient.reorder_threshold > 0 ? `${fmtQty(ingredient.reorder_threshold)} ${ingredient.base_unit}` : '--'}
                            </span>
                          )}
                        </TableCell>
                        <TableCell className={STOCK_TABLE_CELL_CLASS}>
                          <Button
                            size="sm"
                            disabled={row.saving || !row.countValue}
                            onClick={() => handleSave(ingredient)}
                          >
                            {row.saving ? 'Saving...' : 'Save'}
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                    </React.Fragment>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
