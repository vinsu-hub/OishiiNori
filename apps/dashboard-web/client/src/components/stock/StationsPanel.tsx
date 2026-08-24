import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useSearch } from 'wouter';
import { toast } from 'sonner';
import { useAuth } from '@/contexts/AuthContext';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Loader2 } from 'lucide-react';
import {
  ApiIngredient,
  ApiStockItem,
  StockStation,
  fetchInventory,
  fetchStockCountEntries,
  fetchStockItems,
  recordStockCount,
  updateStockItem,
} from '@/lib/api';
import { useDraftPersistence } from '@/hooks/useDraftPersistence';
import { StockStatusBadge } from '@/components/stock/StockStatusBadge';
import { STOCK_TABLE_CELL_CLASS, STOCK_TABLE_HEAD_CLASS, STOCK_TABLE_ROW_CLASS } from '@/components/stock/stockTableStyle';

const STATIONS: { value: StockStation; label: string }[] = [
  { value: 'tako_snack', label: 'Tako / Snack' },
  { value: 'cafe_drinks', label: 'Cafe / Drinks' },
  { value: 'sushi_kitchen_main', label: 'Sushi-Kitchen Main' },
  { value: 'ramen_hot_line', label: 'Ramen / Hot Line' },
];

type ActiveTab = StockStation | 'catalog';

interface DraftRow {
  newStocks: string;
  beginning: string;
  usage: string;
  ending: string;
  notes: string;
  needsVerification: boolean;
}

function emptyDraft(): DraftRow {
  return { newStocks: '', beginning: '', usage: '', ending: '', notes: '', needsVerification: false };
}

function draftRowChanged(a: DraftRow | undefined, b: DraftRow | undefined): boolean {
  if (!a || !b) return false;
  return (
    a.newStocks !== b.newStocks ||
    a.beginning !== b.beginning ||
    a.usage !== b.usage ||
    a.ending !== b.ending ||
    a.notes !== b.notes ||
    a.needsVerification !== b.needsVerification
  );
}

function draftFromEntry(entry: {
  new_stocks: number | null;
  beginning: number | null;
  usage: number | null;
  ending: number | null;
  notes: string | null;
  needs_verification: boolean;
} | undefined): DraftRow {
  if (!entry) return emptyDraft();
  return {
    newStocks: entry.new_stocks != null ? String(entry.new_stocks) : '',
    beginning: entry.beginning != null ? String(entry.beginning) : '',
    usage: entry.usage != null ? String(entry.usage) : '',
    ending: entry.ending != null ? String(entry.ending) : '',
    notes: entry.notes || '',
    needsVerification: entry.needs_verification,
  };
}

interface StationsPanelProps {
  onViewIngredients: () => void;
}

export function StationsPanel({ onViewIngredients }: StationsPanelProps) {
  const { user } = useAuth();
  const isManagerOrExecutive = user?.role === 'manager' || user?.role === 'executive';

  // Deep-link support: Stock Alerts' "Count now" action links here with
  // ?station=<value> so the right station tab opens directly instead of
  // always landing on the default. Read once on mount only (this panel
  // stays mounted persistently once Stock.tsx renders it), matching the
  // rest of this app's URL-param-on-mount convention.
  const search = useSearch();
  const initialStation = (): ActiveTab => {
    const requested = new URLSearchParams(search).get('station');
    return STATIONS.some((s) => s.value === requested) ? (requested as StockStation) : 'tako_snack';
  };
  const [activeTab, setActiveTab] = useState<ActiveTab>(initialStation);
  const [items, setItems] = useState<ApiStockItem[]>([]);
  const [drafts, setDrafts] = useState<Record<string, DraftRow>>({});
  const [originalDrafts, setOriginalDrafts] = useState<Record<string, DraftRow>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Draft persistence: only the changed rows (vs. originalDrafts) get
  // persisted, keyed per-station, so a lost tab doesn't lose an in-progress
  // count. Restoration is deferred to a ref rather than applied immediately
  // -- loadStation's own setDrafts(initial) below (server truth) would
  // otherwise race a restore and silently wipe it out, since the restore
  // effect fires synchronously on mount/tab-change while loadStation's data
  // arrives later, asynchronously.
  const pendingRestoreRef = useRef<Record<string, DraftRow> | null>(null);
  const changedDraftsForPersistence: Record<string, DraftRow> =
    activeTab === 'catalog'
      ? {}
      : Object.fromEntries(
          items.filter((i) => draftRowChanged(drafts[i.id], originalDrafts[i.id])).map((i) => [i.id, drafts[i.id]])
        );
  const { clearDraft: clearStationDraft } = useDraftPersistence(
    `oishii-draft-stock-count-${activeTab}`,
    changedDraftsForPersistence,
    (restored) => {
      pendingRestoreRef.current = restored;
    }
  );

  const loadStation = useCallback((station: StockStation) => {
    setLoading(true);
    Promise.all([fetchStockItems({ station, active_only: true }), fetchStockCountEntries({ station })])
      .then(([stockItems, entries]) => {
        const entriesByItem = new Map(entries.map((e) => [e.stock_item_id, e]));
        const sorted = [...stockItems].sort((a, b) => a.name.localeCompare(b.name));
        const initial: Record<string, DraftRow> = {};
        for (const item of sorted) {
          initial[item.id] = draftFromEntry(entriesByItem.get(item.id));
        }
        setItems(sorted);
        setDrafts(initial);
        setOriginalDrafts(initial);
        if (pendingRestoreRef.current) {
          const restored = pendingRestoreRef.current;
          pendingRestoreRef.current = null;
          setDrafts((prev) => ({ ...prev, ...restored }));
        }
      })
      .catch((e) => toast.error(`Failed to load stock items: ${e.message}`))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (activeTab !== 'catalog') {
      loadStation(activeTab);
    }
  }, [activeTab, loadStation]);

  function updateDraft(itemId: string, patch: Partial<DraftRow>) {
    setDrafts((prev) => ({ ...prev, [itemId]: { ...(prev[itemId] || emptyDraft()), ...patch } }));
  }

  const changedItems = items.filter((i) => draftRowChanged(drafts[i.id], originalDrafts[i.id]));

  async function handleSave() {
    if (!user?.id || activeTab === 'catalog') return;
    if (changedItems.length === 0) {
      toast.error('No changes to save.');
      return;
    }
    setSaving(true);
    try {
      await Promise.all(
        changedItems.map((item) => {
          const d = drafts[item.id];
          return recordStockCount(item.id, {
            recorded_by: user.id,
            new_stocks: d.newStocks !== '' ? Number(d.newStocks) : null,
            beginning: d.beginning !== '' ? Number(d.beginning) : null,
            usage: d.usage !== '' ? Number(d.usage) : null,
            ending: d.ending !== '' ? Number(d.ending) : null,
            notes: d.notes.trim() || null,
            needs_verification: d.needsVerification,
          });
        })
      );
      const stationLabel = STATIONS.find((s) => s.value === activeTab)?.label;
      toast.success(`Saved ${changedItems.length} item${changedItems.length === 1 ? '' : 's'} for ${stationLabel}`);
      clearStationDraft();
      loadStation(activeTab);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save stock count');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as ActiveTab)}>
        <TabsList className="h-auto flex-wrap">
          {STATIONS.map((s) => (
            <TabsTrigger key={s.value} value={s.value}>
              {s.label}
            </TabsTrigger>
          ))}
          {isManagerOrExecutive && <TabsTrigger value="catalog">Manage Catalog</TabsTrigger>}
        </TabsList>
      </Tabs>

      {activeTab === 'catalog' ? (
        <ManageCatalog />
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card className="border-l-4 border-l-success">
              <CardContent className="p-4">
                <p className="text-sm text-muted-foreground mb-1">Items Counted</p>
                <p className="text-3xl font-bold text-foreground">
                  {items.filter((i) => {
                    const d = drafts[i.id];
                    return !!d && (d.beginning !== '' || d.usage !== '' || d.ending !== '' || d.newStocks !== '');
                  }).length}
                  /{items.length}
                </p>
              </CardContent>
            </Card>
            <Card className="border-l-4 border-l-warning">
              <CardContent className="p-4">
                <p className="text-sm text-muted-foreground mb-1">Flagged for Verification</p>
                <p className="text-3xl font-bold text-warning">
                  {items.filter((i) => drafts[i.id]?.needsVerification).length}
                </p>
              </CardContent>
            </Card>
          </div>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0">
              <div>
                <CardTitle>{STATIONS.find((s) => s.value === activeTab)?.label} -- today's count</CardTitle>
                <button
                  type="button"
                  className="text-xs text-primary underline underline-offset-2 mt-0.5"
                  onClick={onViewIngredients}
                >
                  View Recipe Ingredients &rarr;
                </button>
              </div>
              <Button size="sm" onClick={handleSave} disabled={saving || changedItems.length === 0}>
                {saving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                Save ({changedItems.length})
              </Button>
            </CardHeader>
            <CardContent>
              {loading && <p className="text-sm text-muted-foreground">Loading stock items...</p>}
              {!loading && items.length === 0 && (
                <p className="text-sm text-muted-foreground py-4">No stock items set up for this station yet.</p>
              )}
              {!loading && items.length > 0 && (
                <Table>
                  <TableHeader>
                    <TableRow className={STOCK_TABLE_ROW_CLASS}>
                      <TableHead className={STOCK_TABLE_HEAD_CLASS}>Item</TableHead>
                      <TableHead className={`${STOCK_TABLE_HEAD_CLASS} text-right`}>New Stocks</TableHead>
                      <TableHead className={`${STOCK_TABLE_HEAD_CLASS} text-right`}>Beginning</TableHead>
                      <TableHead className={`${STOCK_TABLE_HEAD_CLASS} text-right`}>Usage</TableHead>
                      <TableHead className={`${STOCK_TABLE_HEAD_CLASS} text-right`}>Ending</TableHead>
                      <TableHead className={STOCK_TABLE_HEAD_CLASS}>Notes</TableHead>
                      <TableHead className={`${STOCK_TABLE_HEAD_CLASS} text-center`}>Flag</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items.map((item) => {
                      const d = drafts[item.id] || emptyDraft();
                      const beginning = parseFloat(d.beginning);
                      const newStocks = parseFloat(d.newStocks);
                      const ending = parseFloat(d.ending);
                      const usage = parseFloat(d.usage);
                      const canCheck = !isNaN(beginning) && !isNaN(ending) && !isNaN(usage);
                      const computedUsage = canCheck ? beginning + (isNaN(newStocks) ? 0 : newStocks) - ending : null;
                      const mismatch = canCheck && computedUsage !== null && Math.abs(computedUsage - usage) > 0.01;
                      return (
                        <TableRow
                          key={item.id}
                          className={`${STOCK_TABLE_ROW_CLASS} ${item.needs_review ? 'bg-warning-bg' : ''}`}
                        >
                          <TableCell className={`${STOCK_TABLE_CELL_CLASS} font-medium`}>
                            <div className="flex items-center gap-1.5 flex-wrap">
                              {item.name}
                              {item.needs_review && <StockStatusBadge variant="critical">Verify</StockStatusBadge>}
                              {item.ingredient_id && (
                                <StockStatusBadge variant="neutral">Linked -- {item.ingredient_name}</StockStatusBadge>
                              )}
                            </div>
                            {item.unit && <p className="text-xs text-muted-foreground">{item.unit}</p>}
                          </TableCell>
                          <TableCell className={`${STOCK_TABLE_CELL_CLASS} text-right`}>
                            {item.ingredient_id ? (
                              <span className="text-xs text-muted-foreground">--</span>
                            ) : (
                              <Input
                                type="number"
                                className="w-24 text-right text-sm ml-auto"
                                value={d.newStocks}
                                onChange={(e) => updateDraft(item.id, { newStocks: e.target.value })}
                              />
                            )}
                          </TableCell>
                          <TableCell className={`${STOCK_TABLE_CELL_CLASS} text-right`}>
                            <Input
                              type="number"
                              className="w-24 text-right text-sm ml-auto"
                              value={d.beginning}
                              onChange={(e) => updateDraft(item.id, { beginning: e.target.value })}
                            />
                          </TableCell>
                          <TableCell className={`${STOCK_TABLE_CELL_CLASS} text-right`}>
                            <Input
                              type="number"
                              className={`w-24 text-right text-sm ml-auto ${mismatch ? 'border-destructive' : ''}`}
                              value={d.usage}
                              onChange={(e) => updateDraft(item.id, { usage: e.target.value })}
                            />
                            {mismatch && (
                              <div className="mt-1 flex flex-col items-end gap-1">
                                <StockStatusBadge variant="critical">Mismatch</StockStatusBadge>
                                <p className="text-xs text-destructive">expected {computedUsage?.toFixed(2)}</p>
                              </div>
                            )}
                          </TableCell>
                          <TableCell className={`${STOCK_TABLE_CELL_CLASS} text-right`}>
                            {item.ingredient_id ? (
                              <div className="text-right">
                                <p className="text-sm font-medium">
                                  {item.ingredient_current_stock ?? '--'}
                                </p>
                                <button
                                  type="button"
                                  className="text-xs text-primary underline underline-offset-2"
                                  onClick={onViewIngredients}
                                >
                                  Edit in Recipe Ingredients &rarr;
                                </button>
                              </div>
                            ) : (
                              <Input
                                type="number"
                                className="w-24 text-right text-sm ml-auto"
                                value={d.ending}
                                onChange={(e) => updateDraft(item.id, { ending: e.target.value })}
                              />
                            )}
                          </TableCell>
                          <TableCell className={STOCK_TABLE_CELL_CLASS}>
                            <Input
                              className="text-sm min-w-[140px]"
                              value={d.notes}
                              onChange={(e) => updateDraft(item.id, { notes: e.target.value })}
                            />
                          </TableCell>
                          <TableCell className={`${STOCK_TABLE_CELL_CLASS} text-center`}>
                            <input
                              type="checkbox"
                              checked={d.needsVerification}
                              onChange={(e) => updateDraft(item.id, { needsVerification: e.target.checked })}
                              aria-label="Flag for verification"
                            />
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function ManageCatalog() {
  const [items, setItems] = useState<ApiStockItem[]>([]);
  const [ingredients, setIngredients] = useState<ApiIngredient[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<ApiStockItem | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [name, setName] = useState('');
  const [category, setCategory] = useState('');
  const [unit, setUnit] = useState('');
  const [reorderThreshold, setReorderThreshold] = useState('');
  const [ingredientId, setIngredientId] = useState<string>('none');
  const [active, setActive] = useState(true);
  const [needsReview, setNeedsReview] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([fetchStockItems({ active_only: false }), fetchInventory()])
      .then(([stockItems, ing]) => {
        setItems(
          [...stockItems].sort((a, b) => a.station.localeCompare(b.station) || a.name.localeCompare(b.name))
        );
        setIngredients([...ing].sort((a, b) => a.name.localeCompare(b.name)));
      })
      .catch((e) => toast.error(`Failed to load catalog: ${e.message}`))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function openEdit(item: ApiStockItem) {
    setEditing(item);
    setName(item.name);
    setCategory(item.category || '');
    setUnit(item.unit || '');
    setReorderThreshold(item.reorder_threshold != null ? String(item.reorder_threshold) : '');
    setIngredientId(item.ingredient_id || 'none');
    setActive(item.active);
    setNeedsReview(item.needs_review);
    setEditOpen(true);
  }

  async function handleSave() {
    if (!editing) return;
    setSaving(true);
    try {
      await updateStockItem(editing.id, {
        name: name.trim(),
        category: category.trim() || null,
        unit: unit.trim() || null,
        reorder_threshold: reorderThreshold.trim() ? Number(reorderThreshold) : null,
        ingredient_id: ingredientId === 'none' ? null : ingredientId,
        active,
        needs_review: needsReview,
      });
      toast.success(`${name.trim()} saved`);
      setEditOpen(false);
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save stock item');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Manage Stock Items Catalog</CardTitle>
      </CardHeader>
      <CardContent>
        {loading && <p className="text-sm text-muted-foreground">Loading catalog...</p>}
        {!loading && (
          <Table>
            <TableHeader>
              <TableRow className={STOCK_TABLE_ROW_CLASS}>
                <TableHead className={STOCK_TABLE_HEAD_CLASS}>Station</TableHead>
                <TableHead className={STOCK_TABLE_HEAD_CLASS}>Name</TableHead>
                <TableHead className={STOCK_TABLE_HEAD_CLASS}>Category</TableHead>
                <TableHead className={STOCK_TABLE_HEAD_CLASS}>Unit</TableHead>
                <TableHead className={STOCK_TABLE_HEAD_CLASS}>Linked Ingredient</TableHead>
                <TableHead className={STOCK_TABLE_HEAD_CLASS}>Active</TableHead>
                <TableHead className={STOCK_TABLE_HEAD_CLASS}>Verify</TableHead>
                <TableHead className={STOCK_TABLE_HEAD_CLASS} />
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => (
                <TableRow key={item.id} className={STOCK_TABLE_ROW_CLASS}>
                  <TableCell className={`${STOCK_TABLE_CELL_CLASS} text-muted-foreground`}>
                    {STATIONS.find((s) => s.value === item.station)?.label}
                  </TableCell>
                  <TableCell className={`${STOCK_TABLE_CELL_CLASS} font-medium`}>{item.name}</TableCell>
                  <TableCell className={`${STOCK_TABLE_CELL_CLASS} text-muted-foreground`}>{item.category || '--'}</TableCell>
                  <TableCell className={`${STOCK_TABLE_CELL_CLASS} text-muted-foreground`}>{item.unit || '--'}</TableCell>
                  <TableCell className={STOCK_TABLE_CELL_CLASS}>
                    {item.ingredient_name ? (
                      <StockStatusBadge variant="neutral">{item.ingredient_name}</StockStatusBadge>
                    ) : (
                      <span className="text-muted-foreground">--</span>
                    )}
                  </TableCell>
                  <TableCell className={STOCK_TABLE_CELL_CLASS}>
                    <StockStatusBadge variant={item.active ? 'ok' : 'neutral'}>
                      {item.active ? 'Active' : 'Inactive'}
                    </StockStatusBadge>
                  </TableCell>
                  <TableCell className={STOCK_TABLE_CELL_CLASS}>
                    {item.needs_review ? (
                      <StockStatusBadge variant="critical">Verify</StockStatusBadge>
                    ) : (
                      <span className="text-muted-foreground">--</span>
                    )}
                  </TableCell>
                  <TableCell className={STOCK_TABLE_CELL_CLASS}>
                    <Button size="sm" variant="outline" onClick={() => openEdit(item)}>
                      Edit
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {items.length === 0 && (
                <TableRow className={STOCK_TABLE_ROW_CLASS}>
                  <TableCell colSpan={8} className="text-center text-sm text-muted-foreground">
                    No stock items yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        )}
      </CardContent>

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit {editing?.name}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>Name</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label>Category</Label>
                <Input value={category} onChange={(e) => setCategory(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label>Unit</Label>
                <Input value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="e.g. pcs, box, pack" />
              </div>
              <div className="space-y-1">
                <Label>Reorder threshold</Label>
                <Input type="number" value={reorderThreshold} onChange={(e) => setReorderThreshold(e.target.value)} />
              </div>
            </div>
            <div className="space-y-1">
              <Label>Linked ingredient (optional)</Label>
              <Select value={ingredientId} onValueChange={setIngredientId}>
                <SelectTrigger>
                  <SelectValue placeholder="None" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None (standalone stock item)</SelectItem>
                  {ingredients.map((ing) => (
                    <SelectItem key={ing.id} value={ing.id}>
                      {ing.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Linking makes this item's Ending count and New Stocks feed directly into that ingredient's real stock
                (same as Inventory Count / Receive Shipment).
              </p>
            </div>
            <div className="flex items-center justify-between rounded-md border p-3">
              <Label>Active</Label>
              <Switch checked={active} onCheckedChange={setActive} />
            </div>
            <div className="flex items-center justify-between rounded-md border p-3">
              <div>
                <Label>Needs verification</Label>
                <p className="text-xs text-muted-foreground">Flags this item until someone confirms its identity/mapping.</p>
              </div>
              <Switch checked={needsReview} onCheckedChange={setNeedsReview} />
            </div>
          </div>
          <DialogFooter>
            <Button disabled={saving} onClick={handleSave}>
              {saving ? 'Saving...' : 'Save changes'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
