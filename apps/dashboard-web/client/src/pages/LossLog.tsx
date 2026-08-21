import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { DashboardLayout } from '@/components/DashboardLayout';
import { useAuth } from '@/contexts/AuthContext';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ApiIngredient, ApiLossRecord, LossReason, createLossRecord, fetchInventory, fetchLossRecords } from '@/lib/api';
import { LOSS_REASONS } from '@/lib/types';

const POLL_INTERVAL_MS = 20_000;

export default function LossLog() {
  const { user } = useAuth();
  const [ingredients, setIngredients] = useState<ApiIngredient[]>([]);
  const [records, setRecords] = useState<ApiLossRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const [ingredientId, setIngredientId] = useState('');
  const [reason, setReason] = useState<LossReason>('spoilage');
  const [quantity, setQuantity] = useState('');
  const [unitCost, setUnitCost] = useState('');
  const [skipStockDeduction, setSkipStockDeduction] = useState(false);

  const load = useCallback(() => {
    Promise.all([fetchInventory(), fetchLossRecords(50)])
      .then(([ing, rec]) => {
        setIngredients([...ing].sort((a, b) => a.name.localeCompare(b.name)));
        setRecords(rec);
      })
      .catch((e) => toast.error(`Failed to load loss log: ${e.message}`))
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

  function resetForm() {
    setIngredientId('');
    setReason('spoilage');
    setQuantity('');
    setUnitCost('');
    setSkipStockDeduction(false);
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
    setSubmitting(true);
    try {
      const record = await createLossRecord({
        ingredient_id: ingredientId,
        employee_id: user.id,
        reason,
        quantity: qty,
        unit_cost: unitCost.trim() ? Number(unitCost) : undefined,
        skip_stock_deduction: skipStockDeduction,
      });
      toast.success(`Loss logged -- cost impact ${record.cost_impact.toFixed(2)}`);
      resetForm();
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to log loss');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <DashboardLayout title="Loss Log">
      <div className="p-6 space-y-6">
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
                <Label>Reason</Label>
                <Select value={reason} onValueChange={(v) => setReason(v as LossReason)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LOSS_REASONS.map((r) => (
                      <SelectItem key={r.value} value={r.value}>
                        {r.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>Quantity {ingredientsById.get(ingredientId) ? `(${ingredientsById.get(ingredientId)?.base_unit})` : ''}</Label>
                <Input type="number" min={0} value={quantity} onChange={(e) => setQuantity(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label>Unit cost (optional)</Label>
                <Input type="number" min={0} step="0.01" value={unitCost} onChange={(e) => setUnitCost(e.target.value)} />
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Checkbox
                id="skip-deduction"
                checked={skipStockDeduction}
                onCheckedChange={(checked) => setSkipStockDeduction(checked === true)}
              />
              <Label htmlFor="skip-deduction" className="text-sm font-normal">
                Skip stock deduction (this loss was already reflected by a prior Count Stock adjustment)
              </Label>
            </div>

            <Button disabled={submitting} onClick={handleSubmit}>
              {submitting ? 'Logging...' : 'Log loss'}
            </Button>
          </CardContent>
        </Card>

        {loading && <p className="text-sm text-muted-foreground">Loading loss log...</p>}
        {!loading && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Ingredient</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead>Quantity</TableHead>
                <TableHead>Cost Impact</TableHead>
                <TableHead>When</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {records.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>{ingredientsById.get(r.ingredient_id)?.name || r.ingredient_id.slice(0, 8)}</TableCell>
                  <TableCell className="capitalize">{r.reason.replace('_', ' ')}</TableCell>
                  <TableCell>{r.quantity}</TableCell>
                  <TableCell>{r.cost_impact.toFixed(2)}</TableCell>
                  <TableCell className="text-muted-foreground">{new Date(r.created_at).toLocaleString()}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </DashboardLayout>
  );
}
