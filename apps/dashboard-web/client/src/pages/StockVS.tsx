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
  countStock,
  fetchIngredientCountEntries,
  fetchInventory,
} from '@/lib/api';
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
// Conversion is intentionally limited to plain mass/volume (g<->kg,
// ml<->L) -- the nori-specific pack/sheet/quarter graph from the original
// spec is a distinct, product-specific ratio this pass doesn't model; an
// unsupported from-unit is rejected with a clear message rather than
// silently mis-converted.
const UNIT_OPTIONS = ['pcs', 'g', 'kg', 'ml', 'L'];

const CONVERSION: Record<string, number> = {
  'kg->g': 1000,
  'g->kg': 0.001,
  'L->ml': 1000,
  'ml->L': 0.001,
};

function convertToBase(value: number, fromUnit: string, baseUnit: string): number | null {
  if (fromUnit === baseUnit) return value;
  const factor = CONVERSION[`${fromUnit}->${baseUnit}`];
  return factor != null ? value * factor : null;
}

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

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([fetchInventory(), fetchIngredientCountEntries()])
      .then(([ing, sum]) => {
        setIngredients(ing);
        setSummaries(sum);
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
      ingredients.filter((i) => stationOf(i) === tab),
      (i) => i.sheet_section,
    );
  }, [ingredients, hasLayout, query, tab]);

  function selectTab(value: StationTab) {
    setTab(value);
    setIngredientSearch('');
    const params = new URLSearchParams(window.location.search);
    params.set('station', value);
    window.history.replaceState(null, '', `${window.location.pathname}?${params}`);
  }

  function rowState(id: string, baseUnit: string): RowState {
    return rows[id] ?? { countValue: '', unit: baseUnit, saving: false, variance: null };
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
    const converted = convertToBase(raw, row.unit, ingredient.base_unit);
    if (converted == null) {
      toast.error(`Can't convert ${row.unit} to ${ingredient.base_unit} for ${ingredient.name}`);
      return;
    }
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
                <Tabs value={tab} onValueChange={(v) => selectTab(v as StationTab)}>
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
                        onClick={() => document.getElementById(sectionAnchor(`vs-${tab}`, g.section))?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
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
              (today's beginning + new stock − POS-deducted usage).
            </p>
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
                    <TableHead className={STOCK_TABLE_HEAD_CLASS} />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sections.length === 0 && (
                    <TableRow className={STOCK_TABLE_ROW_CLASS}>
                      <TableCell colSpan={6} className="py-6 text-center text-sm text-muted-foreground">
                        {query ? `No ingredient matches “${ingredientSearch.trim()}”.` : 'No ingredients at this station.'}
                      </TableCell>
                    </TableRow>
                  )}
                  {sections.map((group) => (
                    <React.Fragment key={group.section}>
                      {group.section && (
                        <TableRow className="bg-muted/60 hover:bg-muted/60">
                          <TableCell
                            colSpan={6}
                            id={sectionAnchor(`vs-${tab}`, group.section)}
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
                        <TableCell className={`${STOCK_TABLE_CELL_CLASS} font-medium`}>{ingredient.name}</TableCell>
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
                            <SelectTrigger className="w-24 h-8">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {Array.from(new Set([ingredient.base_unit, ...UNIT_OPTIONS])).map((u) => (
                                <SelectItem key={u} value={u}>
                                  {u}
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
