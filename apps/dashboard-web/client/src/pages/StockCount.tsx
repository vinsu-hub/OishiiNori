import React, { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { DashboardLayout } from '@/components/DashboardLayout';
import { useAuth } from '@/contexts/AuthContext';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
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

export default function StockCount() {
  const { user } = useAuth();
  const isManagerOrExecutive = user?.role === 'manager' || user?.role === 'executive';

  const [activeTab, setActiveTab] = useState<ActiveTab>('tako_snack');
  const [items, setItems] = useState<ApiStockItem[]>([]);
  const [drafts, setDrafts] = useState<Record<string, DraftRow>>({});
  const [originalDrafts, setOriginalDrafts] = useState<Record<string, DraftRow>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

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

  function draftChanged(itemId: string): boolean {
    const a = drafts[itemId];
    const b = originalDrafts[itemId];
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

  const changedItems = items.filter((i) => draftChanged(i.id));

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
      loadStation(activeTab);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save stock count');
    } finally {
      setSaving(false);
    }
  }

  return (
    <DashboardLayout title="Stock Count">
      <div className="p-6 space-y-4">
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
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0">
              <CardTitle>{STATIONS.find((s) => s.value === activeTab)?.label} -- today's count</CardTitle>
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
                    <TableRow>
                      <TableHead>Item</TableHead>
                      <TableHead className="text-right">New Stocks</TableHead>
                      <TableHead className="text-right">Beginning</TableHead>
                      <TableHead className="text-right">Usage</TableHead>
                      <TableHead className="text-right">Ending</TableHead>
                      <TableHead>Notes</TableHead>
                      <TableHead className="text-center">Flag</TableHead>
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
                        <TableRow key={item.id} className={item.needs_review ? 'bg-amber-50' : undefined}>
                          <TableCell className="font-medium">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              {item.name}
                              {item.needs_review && (
                                <Badge variant="destructive" className="text-xs">
                                  VERIFY
                                </Badge>
                              )}
                              {item.ingredient_id && (
                                <Badge variant="outline" className="text-xs">
                                  linked -- {item.ingredient_name}
                                </Badge>
                              )}
                            </div>
                            {item.unit && <p className="text-xs text-muted-foreground">{item.unit}</p>}
                          </TableCell>
                          <TableCell className="text-right">
                            <Input
                              type="number"
                              className="w-24 text-right text-sm ml-auto"
                              value={d.newStocks}
                              onChange={(e) => updateDraft(item.id, { newStocks: e.target.value })}
                            />
                          </TableCell>
                          <TableCell className="text-right">
                            <Input
                              type="number"
                              className="w-24 text-right text-sm ml-auto"
                              value={d.beginning}
                              onChange={(e) => updateDraft(item.id, { beginning: e.target.value })}
                            />
                          </TableCell>
                          <TableCell className="text-right">
                            <Input
                              type="number"
                              className={`w-24 text-right text-sm ml-auto ${mismatch ? 'border-destructive' : ''}`}
                              value={d.usage}
                              onChange={(e) => updateDraft(item.id, { usage: e.target.value })}
                            />
                            {mismatch && (
                              <p className="text-xs text-destructive mt-1">expected {computedUsage?.toFixed(2)}</p>
                            )}
                          </TableCell>
                          <TableCell className="text-right">
                            <Input
                              type="number"
                              className="w-24 text-right text-sm ml-auto"
                              value={d.ending}
                              onChange={(e) => updateDraft(item.id, { ending: e.target.value })}
                            />
                          </TableCell>
                          <TableCell>
                            <Input
                              className="text-sm min-w-[140px]"
                              value={d.notes}
                              onChange={(e) => updateDraft(item.id, { notes: e.target.value })}
                            />
                          </TableCell>
                          <TableCell className="text-center">
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
        )}
      </div>
    </DashboardLayout>
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
              <TableRow>
                <TableHead>Station</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Unit</TableHead>
                <TableHead>Linked Ingredient</TableHead>
                <TableHead>Active</TableHead>
                <TableHead>Verify</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell className="text-muted-foreground">
                    {STATIONS.find((s) => s.value === item.station)?.label}
                  </TableCell>
                  <TableCell className="font-medium">{item.name}</TableCell>
                  <TableCell className="text-muted-foreground">{item.category || '--'}</TableCell>
                  <TableCell className="text-muted-foreground">{item.unit || '--'}</TableCell>
                  <TableCell>
                    {item.ingredient_name ? (
                      <Badge variant="outline">{item.ingredient_name}</Badge>
                    ) : (
                      <span className="text-muted-foreground">--</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant={item.active ? 'outline' : 'secondary'}>{item.active ? 'Active' : 'Inactive'}</Badge>
                  </TableCell>
                  <TableCell>
                    {item.needs_review ? <Badge variant="destructive">VERIFY</Badge> : <span className="text-muted-foreground">--</span>}
                  </TableCell>
                  <TableCell>
                    <Button size="sm" variant="outline" onClick={() => openEdit(item)}>
                      Edit
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {items.length === 0 && (
                <TableRow>
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
