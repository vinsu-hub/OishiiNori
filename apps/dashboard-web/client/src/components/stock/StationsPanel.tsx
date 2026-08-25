import React, { useCallback, useEffect, useMemo, useState } from 'react';
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
import { Flag, Loader2, Trash2 } from 'lucide-react';
import {
  ApiIngredient,
  ApiProduct,
  ApiStockConsumptionRule,
  ApiStockItem,
  ApiStockItemDailySummary,
  OrderType,
  StockConsumptionTrigger,
  StockStation,
  StockSummaryField,
  createStockConsumptionRule,
  deleteStockConsumptionRule,
  fetchInventory,
  fetchProducts,
  fetchStockConsumptionRules,
  fetchStockCountEntries,
  fetchStockItems,
  overrideStockItemField,
  updateStockConsumptionRule,
  updateStockItem,
  updateStockItemNotes,
} from '@/lib/api';
import { LossRecordForm } from '@/components/shared/LossRecordForm';
import { LOSS_REASONS } from '@/lib/types';
import { StockStatusBadge } from '@/components/stock/StockStatusBadge';
import { STOCK_TABLE_CELL_CLASS, STOCK_TABLE_HEAD_CLASS, STOCK_TABLE_ROW_CLASS } from '@/components/stock/stockTableStyle';

const STATIONS: { value: StockStation; label: string }[] = [
  { value: 'tako_snack', label: 'Tako / Snack' },
  { value: 'cafe_drinks', label: 'Cafe / Drinks' },
  { value: 'sushi_kitchen_main', label: 'Sushi-Kitchen Main' },
  { value: 'ramen_hot_line', label: 'Ramen / Hot Line' },
];

const FIELD_LABELS: Record<StockSummaryField, string> = {
  new_stocks: 'New Stocks',
  beginning: 'Beginning',
  usage: 'Usage',
  ending: 'Ending',
};

type ActiveTab = StockStation | 'catalog';

interface NotesDraft {
  notes: string;
  needsVerification: boolean;
}

function draftFromEntry(entry: ApiStockItemDailySummary | undefined): NotesDraft {
  return { notes: entry?.notes || '', needsVerification: entry?.needs_verification || false };
}

function notesDraftChanged(a: NotesDraft | undefined, b: NotesDraft | undefined): boolean {
  if (!a || !b) return false;
  return a.notes !== b.notes || a.needsVerification !== b.needsVerification;
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
  const [summaries, setSummaries] = useState<Record<string, ApiStockItemDailySummary>>({});
  const [notesDrafts, setNotesDrafts] = useState<Record<string, NotesDraft>>({});
  const [originalNotesDrafts, setOriginalNotesDrafts] = useState<Record<string, NotesDraft>>({});
  const [loading, setLoading] = useState(true);
  const [savingNotes, setSavingNotes] = useState(false);
  const [lossItem, setLossItem] = useState<ApiStockItem | null>(null);

  const loadStation = useCallback((station: StockStation) => {
    setLoading(true);
    Promise.all([fetchStockItems({ station, active_only: true }), fetchStockCountEntries({ station })])
      .then(([stockItems, entries]) => {
        const summaryByItem: Record<string, ApiStockItemDailySummary> = {};
        for (const e of entries) summaryByItem[e.stock_item_id] = e;
        const sorted = [...stockItems].sort((a, b) => a.name.localeCompare(b.name));
        const initialNotes: Record<string, NotesDraft> = {};
        for (const item of sorted) {
          initialNotes[item.id] = draftFromEntry(summaryByItem[item.id]);
        }
        setItems(sorted);
        setSummaries(summaryByItem);
        setNotesDrafts(initialNotes);
        setOriginalNotesDrafts(initialNotes);
      })
      .catch((e) => toast.error(`Failed to load stock items: ${e.message}`))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (activeTab !== 'catalog') {
      loadStation(activeTab);
    }
  }, [activeTab, loadStation]);

  function updateNotesDraft(itemId: string, patch: Partial<NotesDraft>) {
    setNotesDrafts((prev) => ({
      ...prev,
      [itemId]: { ...(prev[itemId] || { notes: '', needsVerification: false }), ...patch },
    }));
  }

  const changedNotesItems = items.filter((i) => notesDraftChanged(notesDrafts[i.id], originalNotesDrafts[i.id]));

  async function handleSaveNotes() {
    if (!user?.id || activeTab === 'catalog') return;
    if (changedNotesItems.length === 0) {
      toast.error('No notes changed.');
      return;
    }
    setSavingNotes(true);
    try {
      await Promise.all(
        changedNotesItems.map((item) => {
          const d = notesDrafts[item.id];
          return updateStockItemNotes(item.id, {
            recorded_by: user.id,
            notes: d.notes.trim() || null,
            needs_verification: d.needsVerification,
          });
        })
      );
      toast.success(`Saved notes for ${changedNotesItems.length} item${changedNotesItems.length === 1 ? '' : 's'}`);
      loadStation(activeTab as StockStation);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save notes');
    } finally {
      setSavingNotes(false);
    }
  }

  function handleOverrideSaved(summary: ApiStockItemDailySummary) {
    setSummaries((prev) => ({ ...prev, [summary.stock_item_id]: summary }));
    setNotesDrafts((prev) => ({ ...prev, [summary.stock_item_id]: draftFromEntry(summary) }));
    setOriginalNotesDrafts((prev) => ({ ...prev, [summary.stock_item_id]: draftFromEntry(summary) }));
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
            <Card className="border-l-4 border-l-warning">
              <CardContent className="p-4">
                <p className="text-sm text-muted-foreground mb-1">Flagged for Verification</p>
                <p className="text-3xl font-bold text-warning">
                  {items.filter((i) => notesDrafts[i.id]?.needsVerification).length}
                </p>
              </CardContent>
            </Card>
            <Card className="border-l-4 border-l-destructive">
              <CardContent className="p-4">
                <p className="text-sm text-muted-foreground mb-1">Fields Flagged as Wrong</p>
                <p className="text-3xl font-bold text-destructive">
                  {items.reduce((n, i) => n + Object.keys(summaries[i.id]?.overrides || {}).length, 0)}
                </p>
              </CardContent>
            </Card>
          </div>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0">
              <div>
                <CardTitle>{STATIONS.find((s) => s.value === activeTab)?.label} -- today's count</CardTitle>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Auto-filled from sales, losses and deliveries. Already a done list -- flag a field only if it
                  looks wrong.{' '}
                  <button
                    type="button"
                    className="text-primary underline underline-offset-2"
                    onClick={onViewIngredients}
                  >
                    View Recipe Ingredients &rarr;
                  </button>
                </p>
              </div>
              <Button size="sm" onClick={handleSaveNotes} disabled={savingNotes || changedNotesItems.length === 0}>
                {savingNotes ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                Save Notes ({changedNotesItems.length})
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
                      <TableHead className={`${STOCK_TABLE_HEAD_CLASS} text-center`}>Verify</TableHead>
                      <TableHead className={STOCK_TABLE_HEAD_CLASS} />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items.map((item) => {
                      const summary = summaries[item.id];
                      const d = notesDrafts[item.id] || { notes: '', needsVerification: false };
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
                          <SummaryFieldCell
                            field="new_stocks"
                            item={item}
                            summary={summary}
                            employeeId={user?.id}
                            onSaved={handleOverrideSaved}
                          />
                          <SummaryFieldCell
                            field="beginning"
                            item={item}
                            summary={summary}
                            employeeId={user?.id}
                            onSaved={handleOverrideSaved}
                            extra={
                              summary && !summary.overrides.beginning ? (
                                <p className="text-[10px] text-muted-foreground">
                                  {summary.beginning_source === 'carry_forward' ? "from yesterday's ending" : 'no prior count'}
                                </p>
                              ) : null
                            }
                          />
                          <SummaryFieldCell
                            field="usage"
                            item={item}
                            summary={summary}
                            employeeId={user?.id}
                            onSaved={handleOverrideSaved}
                          />
                          <SummaryFieldCell
                            field="ending"
                            item={item}
                            summary={summary}
                            employeeId={user?.id}
                            onSaved={handleOverrideSaved}
                          />
                          <TableCell className={STOCK_TABLE_CELL_CLASS}>
                            <Input
                              className="text-sm min-w-[140px]"
                              value={d.notes}
                              onChange={(e) => updateNotesDraft(item.id, { notes: e.target.value })}
                            />
                          </TableCell>
                          <TableCell className={`${STOCK_TABLE_CELL_CLASS} text-center`}>
                            <input
                              type="checkbox"
                              checked={d.needsVerification}
                              onChange={(e) => updateNotesDraft(item.id, { needsVerification: e.target.checked })}
                              aria-label="Flag for verification"
                            />
                          </TableCell>
                          <TableCell className={STOCK_TABLE_CELL_CLASS}>
                            <Button size="sm" variant="ghost" onClick={() => setLossItem(item)}>
                              Log Loss
                            </Button>
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

      <Dialog open={!!lossItem} onOpenChange={(open) => !open && setLossItem(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Log Loss -- {lossItem?.name}</DialogTitle>
          </DialogHeader>
          {lossItem && user?.id && (
            <LossRecordForm
              employeeId={user.id}
              fixedStockItemId={lossItem.ingredient_id ? undefined : lossItem.id}
              fixedIngredientId={lossItem.ingredient_id || undefined}
              fixedIngredientLabel={lossItem.name}
              stockItemLabel={lossItem.name}
              reasonOptions={LOSS_REASONS}
              defaultReason="spoilage"
              skipStockDeduction={false}
              submitLabel="Log Loss"
              successToast={() => `Loss logged for ${lossItem.name}`}
              onSuccess={() => {
                setLossItem(null);
                loadStation(activeTab as StockStation);
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

interface SummaryFieldCellProps {
  field: StockSummaryField;
  item: ApiStockItem;
  summary: ApiStockItemDailySummary | undefined;
  employeeId: string | undefined;
  onSaved: (summary: ApiStockItemDailySummary) => void;
  extra?: React.ReactNode;
}

function SummaryFieldCell({ field, item, summary, employeeId, onSaved, extra }: SummaryFieldCellProps) {
  const [flagOpen, setFlagOpen] = useState(false);
  const [correctedValue, setCorrectedValue] = useState('');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  const value = summary?.[field];
  const override = summary?.overrides[field];
  const isLinkedEndingOrNewStocks = item.ingredient_id && (field === 'new_stocks' || field === 'ending');

  function openFlag() {
    setCorrectedValue(value != null ? String(value) : '');
    setReason('');
    setFlagOpen(true);
  }

  async function handleSubmit() {
    if (!employeeId) return;
    const corrected = Number(correctedValue);
    if (correctedValue.trim() === '' || Number.isNaN(corrected)) {
      toast.error('Enter a corrected value');
      return;
    }
    if (!reason.trim()) {
      toast.error('A reason is required to flag/correct a field');
      return;
    }
    setSaving(true);
    try {
      const result = await overrideStockItemField(item.id, {
        field,
        corrected_value: corrected,
        reason: reason.trim(),
        employee_id: employeeId,
      });
      onSaved(result);
      toast.success(`${FIELD_LABELS[field]} corrected for ${item.name}`);
      setFlagOpen(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save correction');
    } finally {
      setSaving(false);
    }
  }

  return (
    <TableCell className={`${STOCK_TABLE_CELL_CLASS} text-right align-top`}>
      <div className="flex items-center justify-end gap-1">
        <span className={`text-sm font-medium ${override ? 'text-warning' : ''}`}>
          {value != null ? value : '--'}
        </span>
        <button
          type="button"
          className="text-muted-foreground hover:text-warning"
          title={
            isLinkedEndingOrNewStocks
              ? `Flag ${FIELD_LABELS[field]} as wrong (corrects the linked ingredient's stock)`
              : `Flag ${FIELD_LABELS[field]} as wrong`
          }
          onClick={openFlag}
        >
          <Flag className="w-3.5 h-3.5" />
        </button>
      </div>
      {extra}
      {override && (
        <p className="text-[10px] text-warning mt-0.5" title={override.reason}>
          flagged: {override.reason}
        </p>
      )}

      <Dialog open={flagOpen} onOpenChange={setFlagOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Flag {FIELD_LABELS[field]} -- {item.name}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Auto-computed value: <span className="font-medium text-foreground">{value != null ? value : '--'}</span>
            </p>
            <div className="space-y-1">
              <Label>Corrected value</Label>
              <Input type="number" value={correctedValue} onChange={(e) => setCorrectedValue(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>Reason (required)</Label>
              <Input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. physical recount found 3 more cups"
              />
            </div>
          </div>
          <DialogFooter>
            <Button disabled={saving} onClick={handleSubmit}>
              {saving ? 'Saving...' : 'Save correction'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </TableCell>
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
  const [rulesItem, setRulesItem] = useState<ApiStockItem | null>(null);

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
                  <TableCell className={`${STOCK_TABLE_CELL_CLASS} space-x-2`}>
                    <Button size="sm" variant="outline" onClick={() => openEdit(item)}>
                      Edit
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setRulesItem(item)}>
                      Consumption Rules
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

      <Dialog open={!!rulesItem} onOpenChange={(open) => !open && setRulesItem(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Consumption Rules -- {rulesItem?.name}</DialogTitle>
          </DialogHeader>
          {rulesItem && <ConsumptionRulesEditor stockItem={rulesItem} />}
        </DialogContent>
      </Dialog>
    </Card>
  );
}

interface FlatProductSize {
  productSizeId: string;
  label: string;
}

function ConsumptionRulesEditor({ stockItem }: { stockItem: ApiStockItem }) {
  const [rules, setRules] = useState<ApiStockConsumptionRule[]>([]);
  const [productSizes, setProductSizes] = useState<FlatProductSize[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [triggerType, setTriggerType] = useState<StockConsumptionTrigger>('per_product_unit');
  const [productSizeId, setProductSizeId] = useState('');
  const [orderType, setOrderType] = useState<OrderType | 'any'>('any');
  const [scaleByGuestCount, setScaleByGuestCount] = useState(false);
  const [qtyPerUnit, setQtyPerUnit] = useState('1');

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([fetchStockConsumptionRules({ stock_item_id: stockItem.id }), fetchProducts(true)])
      .then(([r, products]: [ApiStockConsumptionRule[], ApiProduct[]]) => {
        setRules(r);
        const flat: FlatProductSize[] = [];
        for (const p of products) {
          for (const s of p.sizes) {
            flat.push({ productSizeId: s.id, label: `${p.name} -- ${s.size_label}` });
          }
        }
        flat.sort((a, b) => a.label.localeCompare(b.label));
        setProductSizes(flat);
      })
      .catch((e) => toast.error(`Failed to load consumption rules: ${e.message}`))
      .finally(() => setLoading(false));
  }, [stockItem.id]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleCreate() {
    const qty = Number(qtyPerUnit);
    if (!qty || qty <= 0) {
      toast.error('Enter a quantity greater than 0');
      return;
    }
    if (triggerType === 'per_product_unit' && !productSizeId) {
      toast.error('Select a product size');
      return;
    }
    setSaving(true);
    try {
      await createStockConsumptionRule({
        stock_item_id: stockItem.id,
        trigger_type: triggerType,
        product_size_id: triggerType === 'per_product_unit' ? productSizeId : null,
        order_type: triggerType === 'per_transaction' && orderType !== 'any' ? orderType : null,
        qty_per_unit: qty,
        scale_by_guest_count: triggerType === 'per_transaction' ? scaleByGuestCount : false,
      });
      toast.success('Consumption rule added');
      setProductSizeId('');
      setQtyPerUnit('1');
      setOrderType('any');
      setScaleByGuestCount(false);
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to add rule');
    } finally {
      setSaving(false);
    }
  }

  async function handleToggleActive(rule: ApiStockConsumptionRule) {
    try {
      await updateStockConsumptionRule(rule.id, { active: !rule.active });
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to update rule');
    }
  }

  async function handleDelete(rule: ApiStockConsumptionRule) {
    try {
      await deleteStockConsumptionRule(rule.id);
      toast.success('Rule removed');
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to remove rule');
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Defines how a sale automatically deducts this item -- per unit of a specific product sold, or once per
        transaction (e.g. a takeout box), optionally scaled by guest count.
      </p>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading rules...</p>
      ) : (
        <div className="space-y-2 max-h-64 overflow-y-auto">
          {rules.length === 0 && <p className="text-sm text-muted-foreground">No consumption rules yet.</p>}
          {rules.map((rule) => (
            <div key={rule.id} className="flex items-center justify-between rounded-md border p-2 text-sm">
              <div>
                <p className="font-medium">
                  {rule.trigger_type === 'per_product_unit'
                    ? `${rule.qty_per_unit} per ${rule.product_name} (${rule.size_label})`
                    : `${rule.qty_per_unit} per ${rule.order_type ? rule.order_type.replace('_', ' ') : 'any'} transaction${
                        rule.scale_by_guest_count ? ' x guest count' : ''
                      }`}
                </p>
                <p className="text-xs text-muted-foreground">{rule.active ? 'Active' : 'Inactive'}</p>
              </div>
              <div className="flex items-center gap-2">
                <Switch checked={rule.active} onCheckedChange={() => handleToggleActive(rule)} />
                <Button size="icon-sm" variant="ghost" onClick={() => handleDelete(rule)} aria-label="Delete rule">
                  <Trash2 className="w-4 h-4" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="space-y-3 rounded-md border p-3">
        <p className="text-sm font-medium">Add rule</p>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label>Trigger</Label>
            <Select value={triggerType} onValueChange={(v) => setTriggerType(v as StockConsumptionTrigger)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="per_product_unit">Per product sold</SelectItem>
                <SelectItem value="per_transaction">Per transaction</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Qty per unit</Label>
            <Input type="number" min={0} step="0.01" value={qtyPerUnit} onChange={(e) => setQtyPerUnit(e.target.value)} />
          </div>
        </div>

        {triggerType === 'per_product_unit' ? (
          <div className="space-y-1">
            <Label>Product (size)</Label>
            <Select value={productSizeId} onValueChange={setProductSizeId}>
              <SelectTrigger>
                <SelectValue placeholder="Select product size" />
              </SelectTrigger>
              <SelectContent>
                {productSizes.map((ps) => (
                  <SelectItem key={ps.productSizeId} value={ps.productSizeId}>
                    {ps.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : (
          <>
            <div className="space-y-1">
              <Label>Order type</Label>
              <Select value={orderType} onValueChange={(v) => setOrderType(v as OrderType | 'any')}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="any">Any (dine-in and takeout)</SelectItem>
                  <SelectItem value="dine_in">Dine-in only</SelectItem>
                  <SelectItem value="takeout">Takeout only</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center justify-between rounded-md border p-3">
              <Label>Scale by guest count</Label>
              <Switch checked={scaleByGuestCount} onCheckedChange={setScaleByGuestCount} />
            </div>
          </>
        )}

        <Button size="sm" disabled={saving} onClick={handleCreate}>
          {saving ? 'Adding...' : 'Add rule'}
        </Button>
      </div>
    </div>
  );
}
