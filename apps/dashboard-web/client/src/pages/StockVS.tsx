import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { DashboardLayout } from '@/components/DashboardLayout';
import { useAuth } from '@/contexts/AuthContext';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Check, Loader2, Printer, Search } from 'lucide-react';
import {
  ApiIngredient,
  ApiIngredientDailySummary,
  type ApiItemUnit,
  type ApiStockItem,
  type StockStation,
  countStock,
  fetchIngredientCountEntries,
  fetchInventory,
  fetchItemUnits,
  fetchStockItems,
  overrideStockItemField,
  updateIngredient,
  updateStockItem,
} from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { describeUnit, fmtQty, type UnitOption, unitOptionsFor, unitsForItem } from '@/lib/units';
import { isCounted, isLowIngredient, isLowStockItem } from '@/lib/stockAlerts';
import { STOCK_TABLE_CELL_CLASS, STOCK_TABLE_HEAD_CLASS, STOCK_TABLE_ROW_CLASS } from '@/components/stock/stockTableStyle';
import { groupBySection, sectionAnchor } from '@/components/stock/StationsPanel';
import { type PrintRow, StockCountPrint } from '@/components/stock/StockCountPrint';
import { STOCK_STATIONS, STOCK_STATION_LABELS } from '@/lib/constants';

// EOD Stock Count (VS): one row per thing on the client's stock sheet -- every
// ingredient AND every station item that has its own stock (packaging,
// supplies, chiller/freezer rows...), so anything Stock Alerts mentions can
// be found and counted here. A station item linked to an ingredient is the
// same thing as that ingredient, so only the ingredient row shows.
//
// Counting: an ingredient goes through apply_ingredient_count (POST
// /inventory/{id}/count); a station item through its "ending" field
// override (apply_stock_item_count). Both set the stock to what was counted
// and log the variance. Units: the base unit, kg/L for g/ml, and the item's
// saved sizes (item_units), so "3 pack" of crab sticks saves as 96 pcs.
//
// Rows follow the sheet: a tab per station, its sections, its row order
// (ingredients.station / sheet_section / sort_order and stock_items.station
// / category / sort_order share one order). Ingredients with no station go
// to Unsorted, where they can be moved to a station.
const UNSORTED = 'unsorted';
type StationTab = StockStation | typeof UNSORTED;
const NEW_SECTION = '__new__';

interface CountRow {
  key: string;
  kind: 'ingredient' | 'stock_item';
  id: string;
  name: string;
  station: StationTab;
  section: string | null;
  sortOrder: number | null;
  unit: string;
  systemEnding: number;
  threshold: number | null;
  counted: boolean;
  countedToday: boolean;
  low: boolean;
  verify: boolean;
  options: UnitOption[];
}

interface RowState {
  countValue: string;
  /** UnitOption key: 'base', 'std:kg', or an item_units id. */
  unit: string;
  saving: boolean;
  variance: number | null;
}

function isStation(value: string | null | undefined): value is StockStation {
  return STOCK_STATIONS.some((s) => s.value === value);
}

function phDate(iso: string | Date) {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
}

function initialParams(): { tab: StationTab; q: string } {
  const params = new URLSearchParams(window.location.search);
  const requested = params.get('station');
  return {
    tab: isStation(requested) || requested === UNSORTED ? (requested as StationTab) : STOCK_STATIONS[0].value,
    q: params.get('q') ?? '',
  };
}

export default function StockVS() {
  const { user } = useAuth();
  const [ingredients, setIngredients] = useState<ApiIngredient[]>([]);
  const [stockItems, setStockItems] = useState<ApiStockItem[]>([]);
  const [summaries, setSummaries] = useState<ApiIngredientDailySummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [tab, setTab] = useState<StationTab>(() => initialParams().tab);
  const [search, setSearch] = useState(() => initialParams().q);
  const [itemUnits, setItemUnits] = useState<ApiItemUnit[]>([]);
  const [thresholds, setThresholds] = useState<Record<string, string>>({});
  const [printOpen, setPrintOpen] = useState(false);
  const [printStation, setPrintStation] = useState<'tab' | 'all'>('tab');
  const [printSection, setPrintSection] = useState('all');
  const [printRows, setPrintRows] = useState<{ rows: PrintRow[]; title: string } | null>(null);

  const isExecutive = user?.role === 'executive';
  const canEditStockItems = ['executive', 'manager', 'stocker'].includes(user?.role ?? '');
  const canEdit = (row: CountRow) => (row.kind === 'ingredient' ? isExecutive : canEditStockItems);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      fetchInventory(),
      fetchIngredientCountEntries(),
      fetchItemUnits().catch(() => [] as ApiItemUnit[]),
      fetchStockItems({ active_only: true }).catch(() => [] as ApiStockItem[]),
    ])
      .then(([ing, sum, units, items]) => {
        setIngredients(ing);
        setSummaries(sum);
        setItemUnits(units);
        setStockItems(items);
      })
      .catch((e) => toast.error(e instanceof Error ? e.message : 'Failed to load stock count data'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const today = phDate(new Date());

  // Station items linked to an ingredient still carry their own Verify flag;
  // it shows (and is cleared) on the ingredient's row.
  const flaggedLinks = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const s of stockItems) {
      if (s.ingredient_id && s.needs_review) map.set(s.ingredient_id, [...(map.get(s.ingredient_id) ?? []), s.id]);
    }
    return map;
  }, [stockItems]);

  const allRows = useMemo<CountRow[]>(() => {
    const summaryById = new Map(summaries.map((s) => [s.ingredient_id, s]));
    const out: CountRow[] = ingredients.map((i) => ({
      key: `i:${i.id}`,
      kind: 'ingredient',
      id: i.id,
      name: i.name,
      station: isStation(i.station) ? i.station : UNSORTED,
      section: i.sheet_section ?? null,
      sortOrder: i.sort_order ?? null,
      unit: i.base_unit,
      systemEnding: summaryById.get(i.id)?.ending ?? i.current_stock,
      threshold: i.reorder_threshold > 0 ? i.reorder_threshold : null,
      counted: isCounted(i),
      countedToday: !!i.last_counted_at && phDate(i.last_counted_at) === today,
      low: isLowIngredient(i),
      verify: i.needs_review || flaggedLinks.has(i.id),
      options: unitOptionsFor(i.base_unit, unitsForItem(itemUnits, 'ingredient', i.id)),
    }));
    for (const s of stockItems) {
      if (s.ingredient_id) continue; // counted as its ingredient
      out.push({
        key: `s:${s.id}`,
        kind: 'stock_item',
        id: s.id,
        name: s.name,
        station: s.station,
        section: s.category,
        sortOrder: s.sort_order ?? null,
        unit: s.unit || 'pcs',
        systemEnding: s.current_stock,
        threshold: s.reorder_threshold && s.reorder_threshold > 0 ? s.reorder_threshold : null,
        counted: true,
        countedToday: false,
        low: isLowStockItem(s),
        verify: s.needs_review,
        options: unitOptionsFor(s.unit || 'pcs', unitsForItem(itemUnits, 'stock_item', s.id)),
      });
    }
    return out.sort(
      (a, b) => (a.sortOrder ?? 1e9) - (b.sortOrder ?? 1e9) || a.name.localeCompare(b.name),
    );
  }, [ingredients, stockItems, summaries, itemUnits, today, flaggedLinks]);

  const ingredientCount = allRows.filter((r) => r.kind === 'ingredient').length;
  const stockItemCount = allRows.length - ingredientCount;
  const hasLayout = allRows.some((r) => r.station !== UNSORTED);
  const tabCounts = useMemo(() => {
    const counts = new Map<StationTab, number>();
    for (const r of allRows) counts.set(r.station, (counts.get(r.station) ?? 0) + 1);
    return counts;
  }, [allRows]);
  // A saved ?station=unsorted link once nothing is unsorted opens the first station.
  const activeTab: StationTab = tab === UNSORTED && !tabCounts.get(UNSORTED) ? STOCK_STATIONS[0].value : tab;
  const tabs: { value: StationTab; label: string }[] = [
    ...STOCK_STATIONS,
    ...(tabCounts.get(UNSORTED) ? [{ value: UNSORTED as StationTab, label: 'Unsorted' }] : []),
  ];
  const stationLabel = (s: StationTab) => (s === UNSORTED ? 'Unsorted' : STOCK_STATION_LABELS[s]);

  /** Sections of each station, in sheet order -- for "Move to" and Print. */
  const sectionsByStation = useMemo(() => {
    const map = new Map<StockStation, string[]>();
    for (const r of allRows) {
      if (r.station === UNSORTED || !r.section) continue;
      const list = map.get(r.station) ?? [];
      if (!list.includes(r.section)) list.push(r.section);
      map.set(r.station, list);
    }
    return map;
  }, [allRows]);

  const query = search.trim().toLowerCase();
  // A search looks across every station, so a row is found without knowing its tab.
  const sections = useMemo(() => {
    if (!hasLayout) return [{ section: '', items: allRows }];
    if (query) {
      return groupBySection(
        allRows.filter((r) => r.name.toLowerCase().includes(query)),
        (r) => (r.section ? `${stationLabel(r.station)} · ${r.section}` : stationLabel(r.station)),
      );
    }
    return groupBySection(allRows.filter((r) => r.station === activeTab), (r) => r.section);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allRows, hasLayout, query, activeTab]);

  function selectTab(value: StationTab) {
    setTab(value);
    setSearch('');
    const params = new URLSearchParams(window.location.search);
    params.set('station', value);
    params.delete('q');
    window.history.replaceState(null, '', `${window.location.pathname}?${params}`);
  }

  function rowState(key: string): RowState {
    return rows[key] ?? { countValue: '', unit: 'base', saving: false, variance: null };
  }

  function updateRow(key: string, patch: Partial<RowState>) {
    setRows((prev) => ({ ...prev, [key]: { ...rowState(key), ...patch } }));
  }

  const notCountedCount = allRows.filter((r) => !r.counted).length;
  const lowCount = allRows.filter((r) => r.low).length;
  const verifyCount = allRows.filter((r) => r.verify).length;

  async function handleSave(row: CountRow) {
    if (!user) return;
    const state = rowState(row.key);
    const raw = Number(state.countValue);
    if (!Number.isFinite(raw) || raw < 0) {
      toast.error('Enter a valid count');
      return;
    }
    const option = row.options.find((o) => o.key === state.unit) ?? row.options[0];
    const counted = Math.round(raw * option.factor * 10000) / 10000;
    updateRow(row.key, { saving: true });
    try {
      let variance: number;
      if (row.kind === 'ingredient') {
        variance = (await countStock(row.id, { employee_id: user.id, counted_stock: counted })).variance;
      } else {
        await overrideStockItemField(row.id, { field: 'ending', corrected_value: counted, reason: 'EOD Stock Count', employee_id: user.id });
        variance = Math.round((counted - row.systemEnding) * 10000) / 10000;
      }
      updateRow(row.key, { saving: false, variance });
      toast.success(`${row.name} counted -- variance ${variance >= 0 ? '+' : ''}${variance}`);
      load();
    } catch (e) {
      updateRow(row.key, { saving: false });
      toast.error(e instanceof Error ? e.message : 'Failed to save count');
    }
  }

  async function saveThreshold(row: CountRow) {
    const raw = thresholds[row.key];
    if (raw === undefined) return;
    const value = raw.trim() === '' ? 0 : Number(raw);
    if (!Number.isFinite(value) || value < 0) {
      toast.error('Low-stock level must be 0 or more');
      return;
    }
    const clear = () => setThresholds((prev) => {
      const next = { ...prev };
      delete next[row.key];
      return next;
    });
    if (value === (row.threshold ?? 0)) return clear();
    try {
      if (row.kind === 'ingredient') {
        const updated = await updateIngredient(row.id, { reorder_threshold: value });
        setIngredients((prev) => prev.map((i) => (i.id === row.id ? { ...i, reorder_threshold: updated.reorder_threshold } : i)));
      } else {
        const updated = await updateStockItem(row.id, { reorder_threshold: value > 0 ? value : null });
        setStockItems((prev) => prev.map((s) => (s.id === row.id ? { ...s, reorder_threshold: updated.reorder_threshold } : s)));
      }
      clear();
      toast.success(value > 0 ? `${row.name}: warns at ${fmtQty(value)} ${row.unit}` : `${row.name}: no low-stock warning`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save low-stock level');
    }
  }

  async function markChecked(row: CountRow) {
    try {
      if (row.kind === 'ingredient') {
        const own = ingredients.find((i) => i.id === row.id)?.needs_review;
        const linked = flaggedLinks.get(row.id) ?? [];
        if (own) await updateIngredient(row.id, { needs_review: false });
        await Promise.all(linked.map((id) => updateStockItem(id, { needs_review: false })));
        setIngredients((prev) => prev.map((i) => (i.id === row.id ? { ...i, needs_review: false } : i)));
        setStockItems((prev) => prev.map((s) => (linked.includes(s.id) ? { ...s, needs_review: false } : s)));
      } else {
        await updateStockItem(row.id, { needs_review: false });
        setStockItems((prev) => prev.map((s) => (s.id === row.id ? { ...s, needs_review: false } : s)));
      }
      toast.success(`${row.name} checked -- removed from Verify Needed`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to update');
    }
  }

  async function moveTo(row: CountRow, value: string) {
    const [station, section] = value.split('::') as [StockStation, string];
    let sheetSection: string | null = section || null;
    if (section === NEW_SECTION) {
      const name = window.prompt(`New section in ${STOCK_STATION_LABELS[station]} (e.g. Cakes & pastries)`);
      if (!name?.trim()) return;
      sheetSection = name.trim();
    }
    try {
      const updated = await updateIngredient(row.id, { station, sheet_section: sheetSection });
      setIngredients((prev) => prev.map((i) => (i.id === row.id ? { ...i, ...updated } : i)));
      toast.success(`${row.name} moved to ${STOCK_STATION_LABELS[station]}${sheetSection ? ` · ${sheetSection}` : ''}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to move');
    }
  }

  const printScope = printStation === 'all' || activeTab === UNSORTED ? allRows : allRows.filter((r) => r.station === activeTab);
  const printSections = Array.from(new Set(printScope.map((r) => r.section || 'Other items')));

  function doPrint() {
    const stationIndex = (st: StationTab) => (st === UNSORTED ? 99 : STOCK_STATIONS.findIndex((x) => x.value === st));
    const chosen = printScope
      .filter((r) => printSection === 'all' || (r.section || 'Other items') === printSection)
      .map((r, i) => ({ r, i }))
      .sort((a, b) => stationIndex(a.r.station) - stationIndex(b.r.station) || a.i - b.i)
      .map(({ r }) => r);
    if (!chosen.length) return toast.error('Nothing to print');
    const where = printStation === 'all' ? 'All stations' : stationLabel(activeTab);
    setPrintRows({
      title: printSection === 'all' ? where : `${where} · ${printSection}`,
      rows: chosen.map((r) => ({
        key: r.key, name: r.name, stationLabel: stationLabel(r.station), section: r.section || 'Other items',
        systemEnding: r.systemEnding, unit: r.unit, threshold: r.threshold, kind: r.kind, countedToday: r.countedToday,
      })),
    });
    setPrintOpen(false);
    setTimeout(() => window.print(), 100);
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
      <div className="p-6 space-y-4 print:hidden">
        <Card>
          <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
            <CardTitle className="font-corp-display text-base">
              {loading ? 'Loading...' : `${ingredientCount} ingredients · ${stockItemCount} station items`}
            </CardTitle>
            <Button variant="outline" size="sm" disabled={loading} onClick={() => { setPrintSection('all'); setPrintOpen(true); }}>
              <Printer className="mr-2 h-4 w-4" aria-hidden /> Print
            </Button>
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
                    placeholder="Find an item (all stations)"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    aria-label="Find an item"
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
              Enter today's physical count per item, in whatever unit you actually measured in -- it's
              converted to the item's own base unit before comparing against the system's computed ending
              (today's beginning + new stock − POS-deducted usage). <span className="font-medium text-foreground">Low at</span>{' '}
              is when it shows on Stock Alerts (leave 0 for no warning). <span className="font-medium text-foreground">Station item</span>{' '}
              rows are packaging and supplies tracked on Station Items -- counted here too.
            </p>
            {!loading && (notCountedCount > 0 || lowCount > 0 || verifyCount > 0) && (
              <p className="flex flex-wrap gap-x-3 text-sm">
                {notCountedCount > 0 && <span><span className="font-semibold">{notCountedCount}</span> not counted yet</span>}
                {lowCount > 0 && <span className="text-destructive"><span className="font-semibold">{lowCount}</span> low on stock</span>}
                {verifyCount > 0 && <span className="text-amber-800"><span className="font-semibold">{verifyCount}</span> to verify</span>}
              </p>
            )}
            {activeTab === UNSORTED && !query && (
              <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
                These ingredients aren't on a station sheet yet. Use <span className="font-medium">Move to</span> to put each one in its station and section.
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
                    <TableHead className={STOCK_TABLE_HEAD_CLASS}>Item</TableHead>
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
                        {query ? `Nothing matches “${search.trim()}”.` : 'Nothing at this station.'}
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
                              · {group.items.length} item{group.items.length === 1 ? '' : 's'}
                            </span>
                          </TableCell>
                        </TableRow>
                      )}
                      {group.items.map((row) => {
                        const state = rowState(row.key);
                        const editable = canEdit(row);
                        return (
                          <TableRow key={row.key} className={`${STOCK_TABLE_ROW_CLASS} ${row.verify ? 'bg-warning-bg/40' : ''}`}>
                            <TableCell className={`${STOCK_TABLE_CELL_CLASS} font-medium`}>
                              <span className="flex flex-wrap items-center gap-1.5">
                                {row.name}
                                {row.kind === 'stock_item' && <Badge variant="secondary" className="font-normal">Station item</Badge>}
                                {row.low && <Badge variant="destructive">Low</Badge>}
                                {!row.counted && <Badge variant="outline" className="font-normal text-muted-foreground">Not counted yet</Badge>}
                                {row.verify && (
                                  <>
                                    <Badge variant="outline" className="border-amber-500 text-amber-800">Verify</Badge>
                                    {editable && (
                                      <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => markChecked(row)}>
                                        <Check className="mr-1 h-3 w-3" aria-hidden /> Checked
                                      </Button>
                                    )}
                                  </>
                                )}
                              </span>
                              {row.station === UNSORTED && row.kind === 'ingredient' && isExecutive && (
                                <Select value="" onValueChange={(v) => moveTo(row, v)}>
                                  <SelectTrigger className="mt-1 h-8 w-56" aria-label={`Move ${row.name} to a station`}>
                                    <SelectValue placeholder="Move to…" />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {STOCK_STATIONS.map((s) => (
                                      <SelectGroup key={s.value}>
                                        <SelectLabel>{s.label}</SelectLabel>
                                        {(sectionsByStation.get(s.value) ?? []).map((sec) => (
                                          <SelectItem key={sec} value={`${s.value}::${sec}`}>{sec}</SelectItem>
                                        ))}
                                        <SelectItem value={`${s.value}::${NEW_SECTION}`}>+ New section…</SelectItem>
                                      </SelectGroup>
                                    ))}
                                  </SelectContent>
                                </Select>
                              )}
                            </TableCell>
                            <TableCell className={`${STOCK_TABLE_CELL_CLASS} text-right`}>
                              {fmtQty(row.systemEnding)} {row.unit}
                            </TableCell>
                            <TableCell className={STOCK_TABLE_CELL_CLASS}>
                              <Input
                                type="number"
                                min="0"
                                step="0.01"
                                className="w-28 h-8"
                                aria-label={`Count for ${row.name}`}
                                value={state.countValue}
                                onChange={(e) => updateRow(row.key, { countValue: e.target.value })}
                              />
                            </TableCell>
                            <TableCell className={STOCK_TABLE_CELL_CLASS}>
                              <Select value={state.unit} onValueChange={(v) => updateRow(row.key, { unit: v })}>
                                <SelectTrigger className="w-40 h-8" aria-label={`Unit counted for ${row.name}`}>
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  {row.options.map((o) => (
                                    <SelectItem key={o.key} value={o.key}>{describeUnit(o, row.unit)}</SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </TableCell>
                            <TableCell
                              className={`${STOCK_TABLE_CELL_CLASS} text-right font-semibold ${
                                state.variance != null && Math.abs(state.variance) > 0.001 ? 'text-destructive' : ''
                              }`}
                            >
                              {state.variance != null ? `${state.variance >= 0 ? '+' : ''}${state.variance}` : '--'}
                            </TableCell>
                            <TableCell className={STOCK_TABLE_CELL_CLASS}>
                              {editable ? (
                                <div className="flex items-center gap-1">
                                  <Input
                                    type="number"
                                    min="0"
                                    step="any"
                                    className="h-8 w-24"
                                    aria-label={`Low-stock level for ${row.name}`}
                                    value={thresholds[row.key] ?? (row.threshold ? String(row.threshold) : '')}
                                    placeholder="0"
                                    onChange={(e) => setThresholds((prev) => ({ ...prev, [row.key]: e.target.value }))}
                                    onBlur={() => saveThreshold(row)}
                                    onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()}
                                  />
                                  <span className="text-xs text-muted-foreground">{row.unit}</span>
                                </div>
                              ) : (
                                <span className="text-sm text-muted-foreground">
                                  {row.threshold ? `${fmtQty(row.threshold)} ${row.unit}` : '--'}
                                </span>
                              )}
                            </TableCell>
                            <TableCell className={STOCK_TABLE_CELL_CLASS}>
                              <Button size="sm" disabled={state.saving || !state.countValue} onClick={() => handleSave(row)}>
                                {state.saving ? 'Saving...' : 'Save'}
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

      <Dialog open={printOpen} onOpenChange={setPrintOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Print stock count</DialogTitle>
            <DialogDescription>A count sheet per category, with boxes to write the count in.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="print-station">Station</Label>
              <Select value={printStation} onValueChange={(v) => { setPrintStation(v as 'tab' | 'all'); setPrintSection('all'); }}>
                <SelectTrigger id="print-station" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="tab">This tab: {stationLabel(activeTab)}</SelectItem>
                  <SelectItem value="all">All stations</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="print-section">Category</Label>
              <Select value={printSection} onValueChange={setPrintSection}>
                <SelectTrigger id="print-section" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All categories ({printScope.length} items)</SelectItem>
                  {printSections.map((sec) => (
                    <SelectItem key={sec} value={sec}>
                      {sec} ({printScope.filter((r) => (r.section || 'Other items') === sec).length})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPrintOpen(false)}>Cancel</Button>
            <Button onClick={doPrint}><Printer className="mr-2 h-4 w-4" aria-hidden /> Print</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {printRows && <StockCountPrint rows={printRows.rows} title={printRows.title} date={today} />}
    </DashboardLayout>
  );
}
