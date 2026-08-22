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
  Department,
  MovementType,
  createInventoryMovement,
  fetchInventory,
  fetchInventoryMovements,
} from '@/lib/api';

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

interface ShipmentRow {
  localId: string;
  ingredientId: string;
  quantity: string;
  unitCost: string;
  expiryDate: string;
}

function newShipmentRow(): ShipmentRow {
  return { localId: crypto.randomUUID(), ingredientId: '', quantity: '', unitCost: '', expiryDate: '' };
}

export default function InventoryMovements() {
  const { user } = useAuth();
  const [ingredients, setIngredients] = useState<ApiIngredient[]>([]);
  const [movements, setMovements] = useState<ApiInventoryMovement[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    Promise.all([fetchInventory(), fetchInventoryMovements({ limit: 50 })])
      .then(([ing, mov]) => {
        setIngredients([...ing].sort((a, b) => a.name.localeCompare(b.name)));
        setMovements(mov);
      })
      .catch((e) => toast.error(`Failed to load movements: ${e.message}`))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [load]);

  const ingredientsById = useMemo(() => {
    const map = new Map<string, ApiIngredient>();
    for (const ing of ingredients) map.set(ing.id, ing);
    return map;
  }, [ingredients]);

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
    const validRows = shipmentRows.filter((r) => r.ingredientId && Number(r.quantity) > 0);
    if (validRows.length === 0) {
      toast.error('Add at least one ingredient with a quantity greater than 0');
      return;
    }
    setReceiving(true);
    try {
      await Promise.all(
        validRows.map((r) =>
          createInventoryMovement({
            ingredient_id: r.ingredientId,
            type: 'delivery',
            quantity: Number(r.quantity),
            reason: supplierNote.trim() || undefined,
            employee_id: user.id,
            unit_cost_snapshot: r.unitCost.trim() ? Number(r.unitCost) : undefined,
            expiry_date: r.expiryDate || undefined,
          })
        )
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
  const [department, setDepartment] = useState<Department | 'none'>('none');
  const [reason, setReason] = useState('');
  const [unitCostSnapshot, setUnitCostSnapshot] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const selectedIngredient = ingredientId ? ingredientsById.get(ingredientId) : undefined;
  const needsCostCheck =
    (type === 'delivery' || type === 'trans_in') &&
    !!selectedIngredient?.cost_volatility_tier &&
    VOLATILE_TIERS.has(selectedIngredient.cost_volatility_tier);

  function resetForm() {
    setIngredientId('');
    setType('trans_out');
    setQuantity('');
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
    setSubmitting(true);
    try {
      await createInventoryMovement({
        ingredient_id: ingredientId,
        type,
        department: department === 'none' ? undefined : department,
        quantity: qty,
        reason: reason.trim() || undefined,
        employee_id: user.id,
        unit_cost_snapshot: unitCostSnapshot.trim() ? Number(unitCostSnapshot) : undefined,
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
                    const rowIngredient = row.ingredientId ? ingredientsById.get(row.ingredientId) : undefined;
                    return (
                      <div key={row.localId} className="grid grid-cols-12 gap-2 items-end">
                        <div className="col-span-4 space-y-1">
                          <Label className="text-xs">Ingredient</Label>
                          <Select value={row.ingredientId} onValueChange={(v) => updateShipmentRow(row.localId, { ingredientId: v })}>
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
                        <div className="col-span-2 space-y-1">
                          <Label className="text-xs">Quantity {rowIngredient ? `(${rowIngredient.base_unit})` : ''}</Label>
                          <Input
                            type="number"
                            min={0}
                            value={row.quantity}
                            onChange={(e) => updateShipmentRow(row.localId, { quantity: e.target.value })}
                          />
                        </div>
                        <div className="col-span-2 space-y-1">
                          <Label className="text-xs">Unit cost</Label>
                          <Input
                            type="number"
                            min={0}
                            step="0.01"
                            value={row.unitCost}
                            onChange={(e) => updateShipmentRow(row.localId, { unitCost: e.target.value })}
                          />
                        </div>
                        <div className="col-span-3 space-y-1">
                          <Label className="text-xs">Expiry date (optional)</Label>
                          <Input
                            type="date"
                            value={row.expiryDate}
                            onChange={(e) => updateShipmentRow(row.localId, { expiryDate: e.target.value })}
                          />
                        </div>
                        <div className="col-span-1">
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
                    <Select value={ingredientId} onValueChange={setIngredientId}>
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
                    <Label>Quantity {selectedIngredient ? `(${selectedIngredient.base_unit})` : ''}</Label>
                    <Input type="number" min={0} value={quantity} onChange={(e) => setQuantity(e.target.value)} />
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
                      placeholder="Unit cost"
                      value={unitCostSnapshot}
                      onChange={(e) => setUnitCostSnapshot(e.target.value)}
                    />
                  </div>
                )}
                {!needsCostCheck && (
                  <div className="space-y-1">
                    <Label>Unit cost snapshot (optional)</Label>
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
                    <TableHead>Ingredient</TableHead>
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
                      <TableCell>{ingredientsById.get(m.ingredient_id)?.name || m.ingredient_id.slice(0, 8)}</TableCell>
                      <TableCell>
                        <Badge variant="outline">{m.type}</Badge>
                      </TableCell>
                      <TableCell>{m.quantity}</TableCell>
                      <TableCell className="text-muted-foreground">{m.department || '--'}</TableCell>
                      <TableCell>{m.unit_cost_snapshot != null ? m.unit_cost_snapshot.toFixed(2) : '--'}</TableCell>
                      <TableCell className="text-muted-foreground">{m.expiry_date || '--'}</TableCell>
                      <TableCell className="text-muted-foreground">{new Date(m.created_at).toLocaleString()}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </TabsContent>
        </Tabs>
      </div>
    </DashboardLayout>
  );
}
