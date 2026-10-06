import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { DashboardLayout } from '@/components/DashboardLayout';
import { useAuth } from '@/contexts/AuthContext';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import {
  ApiIngredient,
  ApiInventoryMovement,
  ApiItemUnit,
  ApiStockItem,
  Department,
  MovementType,
  createInventoryMovement,
  fetchInventory,
  fetchInventoryMovements,
  fetchItemUnits,
  fetchStockItems,
} from '@/lib/api';
import { ConversionHint, NewUnitDialog, UnitSelect } from '@/components/stock/UnitPicker';
import { fmtQty, unitOptionsFor, unitsForItem, type UnitOption } from '@/lib/units';
import { formatDateTime12h } from '@/lib/utils';
import { useVisiblePolling } from '@/hooks/useVisiblePolling';

const POLL_INTERVAL_MS = 20_000;

const MOVEMENT_TYPES: { value: MovementType; label: string }[] = [
  { value: 'delivery', label: 'Delivery (internal)' },
  { value: 'trans_in', label: 'Received from supplier' },
  { value: 'trans_out', label: 'Removed / written off' },
  { value: 'transfer_in', label: 'Transfer in (from other dept)' },
  { value: 'transfer_out', label: 'Transfer out (to other dept)' },
  { value: 'count_adjustment', label: 'Count adjustment' },
];

const DEPARTMENTS: { value: Department; label: string }[] = [
  { value: 'kitchen', label: 'Kitchen' },
  { value: 'cafe', label: 'Cafe' },
];

const VOLATILE_TIERS = new Set(['high', 'medium_high']);

// Combined ingredient + unlinked-stock-item picker key, "ingredient:<id>" or
// "stock_item:<id>" -- Receive Shipment is the only real delivery-logging
// surface an unlinked Station Item has (0028), so it needs both target kinds
// in one list. Linked stock items are excluded here -- receive those via
// their real ingredient instead, same routing rule the rest of this app
// already follows.
type TargetKey = string;

function targetKeyFor(kind: 'ingredient' | 'stock_item', id: string): TargetKey {
  return `${kind}:${id}`;
}

function parseTargetKey(key: TargetKey): { kind: 'ingredient' | 'stock_item'; id: string } | null {
  const [kind, id] = key.split(':');
  if ((kind === 'ingredient' || kind === 'stock_item') && id) return { kind, id };
  return null;
}

interface ShipmentRow {
  localId: string;
  targetKey: TargetKey;
  /** 'base', 'std:kg', or an item_units id -- quantity and cost are in this unit. */
  unitKey: string;
  quantity: string;
  unitCost: string;
  expiryDate: string;
}

function newShipmentRow(): ShipmentRow {
  return { localId: crypto.randomUUID(), targetKey: '', unitKey: 'base', quantity: '', unitCost: '', expiryDate: '' };
}

export default function InventoryMovements() {
  const { user } = useAuth();
  const [ingredients, setIngredients] = useState<ApiIngredient[]>([]);
  const [stockItems, setStockItems] = useState<ApiStockItem[]>([]);
  const [movements, setMovements] = useState<ApiInventoryMovement[]>([]);
  const [itemUnits, setItemUnits] = useState<ApiItemUnit[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    Promise.all([
      fetchInventory(),
      fetchInventoryMovements({ limit: 50 }),
      fetchStockItems({ active_only: true }),
      // Units are optional extras -- an empty list just means base units only.
      fetchItemUnits().catch(() => [] as ApiItemUnit[]),
    ])
      .then(([ing, mov, items, units]) => {
        setIngredients([...ing].sort((a, b) => a.name.localeCompare(b.name)));
        setMovements(mov);
        setStockItems([...items].filter((i) => !i.ingredient_id).sort((a, b) => a.name.localeCompare(b.name)));
        setItemUnits(units);
      })
      .catch((e) => toast.error(`Failed to load movements: ${e.message}`))
      .finally(() => setLoading(false));
  }, []);

  useVisiblePolling(load, POLL_INTERVAL_MS);

  const ingredientsById = useMemo(() => {
    const map = new Map<string, ApiIngredient>();
    for (const ing of ingredients) map.set(ing.id, ing);
    return map;
  }, [ingredients]);

  const stockItemsById = useMemo(() => {
    const map = new Map<string, ApiStockItem>();
    for (const item of stockItems) map.set(item.id, item);
    return map;
  }, [stockItems]);

  /** Name, base unit and unit options for a picker key. */
  function targetInfo(key: TargetKey) {
    const target = parseTargetKey(key);
    if (!target) return null;
    const item = target.kind === 'ingredient' ? ingredientsById.get(target.id) : stockItemsById.get(target.id);
    if (!item) return null;
    const baseUnit = (target.kind === 'ingredient' ? (item as ApiIngredient).base_unit : (item as ApiStockItem).unit) || 'pcs';
    const options = unitOptionsFor(baseUnit, unitsForItem(itemUnits, target.kind, target.id));
    return { target, name: item.name, baseUnit, options };
  }

  function optionFor(options: UnitOption[], key: string): UnitOption {
    return options.find((o) => o.key === key) ?? options[0];
  }

  // "+ New unit…" -- which form asked, and for which item.
  const [newUnitFor, setNewUnitFor] = useState<{ source: string; key: TargetKey } | null>(null);
  const newUnitInfo = newUnitFor ? targetInfo(newUnitFor.key) : null;

  function handleUnitCreated(unit: ApiItemUnit) {
    setItemUnits((units) => [...units, unit]);
    if (!newUnitFor) return;
    if (newUnitFor.source === 'other') setOtherUnitKey(unit.id);
    else updateShipmentRow(newUnitFor.source, { unitKey: unit.id });
  }

  function movementBaseUnit(m: ApiInventoryMovement): string {
    if (m.ingredient_id) return ingredientsById.get(m.ingredient_id)?.base_unit || '';
    if (m.stock_item_id) return stockItemsById.get(m.stock_item_id)?.unit || 'pcs';
    return '';
  }

  function movementTargetName(m: ApiInventoryMovement): string {
    if (m.ingredient_id) return ingredientsById.get(m.ingredient_id)?.name || m.ingredient_id.slice(0, 8);
    if (m.stock_item_id) return stockItemsById.get(m.stock_item_id)?.name || m.stock_item_id.slice(0, 8);
    return '--';
  }

  // --- Receive Shipment (batch) ---
  const [shipmentRows, setShipmentRows] = useState<ShipmentRow[]>([newShipmentRow()]);
  const [supplierNote, setSupplierNote] = useState('');
  const [receiving, setReceiving] = useState(false);

  function updateShipmentRow(localId: string, patch: Partial<ShipmentRow>) {
    setShipmentRows((rows) => rows.map((r) => (r.localId === localId ? { ...r, ...patch } : r)));
  }

  function addShipmentRow() {
    setShipmentRows((rows) => [...rows, newShipmentRow()]);
  }

  function removeShipmentRow(localId: string) {
    setShipmentRows((rows) => (rows.length === 1 ? rows : rows.filter((r) => r.localId !== localId)));
  }

  async function handleReceiveShipment() {
    if (!user) return;
    const validRows = shipmentRows.filter((r) => r.targetKey && Number(r.quantity) > 0);
    if (validRows.length === 0) {
      toast.error('Add at least one item with a quantity greater than 0');
      return;
    }
    setReceiving(true);
    try {
      await Promise.all(
        validRows.map((r) => {
          const target = parseTargetKey(r.targetKey);
          const info = targetInfo(r.targetKey);
          const unit = info ? optionFor(info.options, r.unitKey) : undefined;
          const factor = unit?.factor ?? 1;
          return createInventoryMovement({
            ingredient_id: target?.kind === 'ingredient' ? target.id : undefined,
            stock_item_id: target?.kind === 'stock_item' ? target.id : undefined,
            type: 'delivery',
            // Stock is kept in the base unit: 2 packs x 100 = 200 sheets.
            quantity: Number(r.quantity) * factor,
            reason: supplierNote.trim() || undefined,
            employee_id: user.id,
            // Cost is typed per chosen unit; stored per base unit.
            unit_cost_snapshot: r.unitCost.trim() ? Number(r.unitCost) / factor : undefined,
            expiry_date: r.expiryDate || undefined,
            entered_quantity: unit && unit.key !== 'base' ? Number(r.quantity) : undefined,
            entered_unit: unit && unit.key !== 'base' ? unit.name : undefined,
          });
        })
      );
      toast.success(`Shipment received -- ${validRows.length} item${validRows.length === 1 ? '' : 's'} logged`);
      setShipmentRows([newShipmentRow()]);
      setSupplierNote('');
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to log shipment');
    } finally {
      setReceiving(false);
    }
  }

  // --- Log Other Movement (single entry) ---
  const [ingredientId, setIngredientId] = useState('');
  const [type, setType] = useState<MovementType>('trans_out');
  const [quantity, setQuantity] = useState('');
  const [otherUnitKey, setOtherUnitKey] = useState('base');
  const [department, setDepartment] = useState<Department | 'none'>('none');
  const [reason, setReason] = useState('');
  const [unitCostSnapshot, setUnitCostSnapshot] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const selectedIngredient = ingredientId ? ingredientsById.get(ingredientId) : undefined;
  const otherInfo = ingredientId ? targetInfo(targetKeyFor('ingredient', ingredientId)) : null;
  const needsCostCheck =
    (type === 'delivery' || type === 'trans_in') &&
    !!selectedIngredient?.cost_volatility_tier &&
    VOLATILE_TIERS.has(selectedIngredient.cost_volatility_tier);

  function resetForm() {
    setIngredientId('');
    setType('trans_out');
    setQuantity('');
    setOtherUnitKey('base');
    setDepartment('none');
    setReason('');
    setUnitCostSnapshot('');
  }

  async function handleSubmit() {
    if (!user) return;
    if (!ingredientId) {
      toast.error('Select an ingredient');
      return;
    }
    const qty = Number(quantity);
    if (!qty || qty <= 0) {
      toast.error('Enter a quantity greater than 0');
      return;
    }
    if (needsCostCheck && !unitCostSnapshot.trim()) {
      toast.error(`${selectedIngredient?.name} is a volatile-cost ingredient -- confirm its unit cost before logging this movement`);
      return;
    }
    const unit = otherInfo ? optionFor(otherInfo.options, otherUnitKey) : undefined;
    const factor = unit?.factor ?? 1;
    setSubmitting(true);
    try {
      await createInventoryMovement({
        ingredient_id: ingredientId,
        type,
        department: department === 'none' ? undefined : department,
        quantity: qty * factor,
        reason: reason.trim() || undefined,
        employee_id: user.id,
        unit_cost_snapshot: unitCostSnapshot.trim() ? Number(unitCostSnapshot) / factor : undefined,
        entered_quantity: unit && unit.key !== 'base' ? qty : undefined,
        entered_unit: unit && unit.key !== 'base' ? unit.name : undefined,
      });
      toast.success('Movement logged');
      resetForm();
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to log movement');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <DashboardLayout title="Inventory Movements">
      <div className="p-6 space-y-6">
        <Tabs defaultValue="receive">
          <TabsList>
            <TabsTrigger value="receive">Receive Shipment</TabsTrigger>
            <TabsTrigger value="other">Log Other Movement</TabsTrigger>
            <TabsTrigger value="history">History</TabsTrigger>
          </TabsList>

          <TabsContent value="receive" className="space-y-3 pt-4">
            <Card>
              <CardContent className="pt-6 space-y-4">
                <div className="space-y-1">
                  <Label>Supplier / invoice note (optional, applied to every line)</Label>
                  <Input
                    placeholder="e.g. SM Supermarket delivery, invoice #1234"
                    value={supplierNote}
                    onChange={(e) => setSupplierNote(e.target.value)}
                  />
                </div>

                <div className="space-y-3">
                  {shipmentRows.map((row) => {
                    const info = targetInfo(row.targetKey);
                    const unit = info ? optionFor(info.options, row.unitKey) : undefined;
                    return (
                      <div key={row.localId} className="grid grid-cols-12 gap-2 items-start">
                        <div className="col-span-3 space-y-1">
                          <Label className="text-xs">Item</Label>
                          <Select
                            value={row.targetKey}
                            onValueChange={(v) => updateShipmentRow(row.localId, { targetKey: v, unitKey: 'base' })}
                          >
                            <SelectTrigger className="w-full">
                              <SelectValue placeholder="Select ingredient or stock item" />
                            </SelectTrigger>
                            <SelectContent>
                              {ingredients.map((ing) => (
                                <SelectItem key={targetKeyFor('ingredient', ing.id)} value={targetKeyFor('ingredient', ing.id)}>
                                  {ing.name}
                                </SelectItem>
                              ))}
                              {stockItems.map((item) => (
                                <SelectItem key={targetKeyFor('stock_item', item.id)} value={targetKeyFor('stock_item', item.id)}>
                                  {item.name} (Station Item)
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="col-span-2 space-y-1">
                          <Label className="text-xs">Quantity</Label>
                          <Input
                            type="number"
                            min={0}
                            step="any"
                            value={row.quantity}
                            onChange={(e) => updateShipmentRow(row.localId, { quantity: e.target.value })}
                          />
                          {info && <ConversionHint qty={row.quantity} option={unit} baseUnit={info.baseUnit} />}
                        </div>
                        <div className="col-span-2 space-y-1">
                          <Label className="text-xs">Unit</Label>
                          <UnitSelect
                            options={info?.options ?? []}
                            baseUnit={info?.baseUnit ?? ''}
                            value={row.unitKey}
                            disabled={!info}
                            onChange={(k) => updateShipmentRow(row.localId, { unitKey: k })}
                            onRequestNew={info ? () => setNewUnitFor({ source: row.localId, key: row.targetKey }) : undefined}
                          />
                        </div>
                        <div className="col-span-2 space-y-1">
                          <Label className="text-xs">Cost per {unit?.name ?? 'unit'} (optional)</Label>
                          <Input
                            type="number"
                            min={0}
                            step="0.01"
                            value={row.unitCost}
                            onChange={(e) => updateShipmentRow(row.localId, { unitCost: e.target.value })}
                          />
                        </div>
                        <div className="col-span-2 space-y-1">
                          <Label className="text-xs">Expiry date (optional)</Label>
                          <Input
                            type="date"
                            value={row.expiryDate}
                            onChange={(e) => updateShipmentRow(row.localId, { expiryDate: e.target.value })}
                          />
                        </div>
                        <div className="col-span-1 pt-6">
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => removeShipmentRow(row.localId)}
                            disabled={shipmentRows.length === 1}
                            aria-label="Remove row"
                          >
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div className="flex items-center justify-between">
                  <Button variant="outline" size="sm" onClick={addShipmentRow} className="gap-1">
                    <Plus className="w-4 h-4" />
                    Add item
                  </Button>
                  <Button disabled={receiving} onClick={handleReceiveShipment} className="gap-2">
                    {receiving ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                    Log Shipment
                  </Button>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="other" className="space-y-3 pt-4">
            <Card>
              <CardContent className="pt-6 space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label>Ingredient</Label>
                    <Select
                      value={ingredientId}
                      onValueChange={(v) => {
                        setIngredientId(v);
                        setOtherUnitKey('base');
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select ingredient" />
                      </SelectTrigger>
                      <SelectContent>
                        {ingredients.map((ing) => (
                          <SelectItem key={ing.id} value={ing.id}>
                            {ing.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label>Type</Label>
                    <Select value={type} onValueChange={(v) => setType(v as MovementType)}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {MOVEMENT_TYPES.map((t) => (
                          <SelectItem key={t.value} value={t.value}>
                            {t.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label>Quantity</Label>
                    <div className="grid grid-cols-2 gap-2">
                      <Input type="number" min={0} step="any" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
                      <UnitSelect
                        options={otherInfo?.options ?? []}
                        baseUnit={otherInfo?.baseUnit ?? ''}
                        value={otherUnitKey}
                        disabled={!otherInfo}
                        onChange={setOtherUnitKey}
                        onRequestNew={
                          otherInfo ? () => setNewUnitFor({ source: 'other', key: targetKeyFor('ingredient', ingredientId) }) : undefined
                        }
                      />
                    </div>
                    {otherInfo && (
                      <ConversionHint qty={quantity} option={optionFor(otherInfo.options, otherUnitKey)} baseUnit={otherInfo.baseUnit} />
                    )}
                  </div>
                  <div className="space-y-1">
                    <Label>Department (optional)</Label>
                    <Select value={department} onValueChange={(v) => setDepartment(v as Department | 'none')}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">None</SelectItem>
                        {DEPARTMENTS.map((d) => (
                          <SelectItem key={d.value} value={d.value}>
                            {d.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="space-y-1">
                  <Label>Reason (optional)</Label>
                  <Input value={reason} onChange={(e) => setReason(e.target.value)} />
                </div>

                {needsCostCheck && (
                  <div className="rounded-md border border-amber-400 bg-amber-50 p-3 space-y-2">
                    <p className="text-sm font-medium text-amber-900">
                      {selectedIngredient?.name} is a {selectedIngredient?.cost_volatility_tier?.replace('_', ' ')}-volatility
                      ingredient -- confirm or update today's unit cost before logging this movement.
                    </p>
                    <Input
                      type="number"
                      min={0}
                      step="0.01"
                      placeholder={`Cost per ${otherInfo ? (otherInfo.options.find((o) => o.key === otherUnitKey)?.name ?? otherInfo.baseUnit) : 'unit'}`}
                      value={unitCostSnapshot}
                      onChange={(e) => setUnitCostSnapshot(e.target.value)}
                    />
                  </div>
                )}
                {!needsCostCheck && (
                  <div className="space-y-1">
                    <Label>Cost per {otherInfo ? (otherInfo.options.find((o) => o.key === otherUnitKey)?.name ?? otherInfo.baseUnit) : 'unit'} (optional)</Label>
                    <Input
                      type="number"
                      min={0}
                      step="0.01"
                      value={unitCostSnapshot}
                      onChange={(e) => setUnitCostSnapshot(e.target.value)}
                    />
                  </div>
                )}

                <Button disabled={submitting} onClick={handleSubmit}>
                  {submitting ? 'Logging...' : 'Log movement'}
                </Button>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="history" className="pt-4">
            {loading && <p className="text-sm text-muted-foreground">Loading movements...</p>}
            {!loading && (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Item</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Quantity</TableHead>
                    <TableHead>Department</TableHead>
                    <TableHead>Unit Cost</TableHead>
                    <TableHead>Expiry</TableHead>
                    <TableHead>When</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {movements.map((m) => (
                    <TableRow key={m.id}>
                      <TableCell>{movementTargetName(m)}</TableCell>
                      <TableCell>
                        <Badge variant="outline">{m.type}</Badge>
                      </TableCell>
                      <TableCell>
                        {m.entered_unit && m.entered_quantity ? (
                          <>
                            {fmtQty(m.entered_quantity)} {m.entered_unit}{' '}
                            <span className="text-muted-foreground">
                              (= {fmtQty(m.quantity)} {movementBaseUnit(m)})
                            </span>
                          </>
                        ) : (
                          <>
                            {fmtQty(m.quantity)} {movementBaseUnit(m)}
                          </>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground">{m.department || '--'}</TableCell>
                      <TableCell>
                        {m.unit_cost_snapshot != null ? `${m.unit_cost_snapshot.toFixed(2)} / ${movementBaseUnit(m) || 'unit'}` : '--'}
                      </TableCell>
                      <TableCell className="text-muted-foreground">{m.expiry_date || '--'}</TableCell>
                      <TableCell className="text-muted-foreground">{formatDateTime12h(m.created_at)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </TabsContent>
        </Tabs>
      </div>
      <NewUnitDialog
        open={!!newUnitFor}
        onOpenChange={(open) => !open && setNewUnitFor(null)}
        itemName={newUnitInfo?.name ?? ''}
        baseUnit={newUnitInfo?.baseUnit ?? ''}
        target={newUnitInfo?.target ?? null}
        onCreated={handleUnitCreated}
      />
    </DashboardLayout>
  );
}
