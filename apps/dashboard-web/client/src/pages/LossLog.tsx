import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { DashboardLayout } from '@/components/DashboardLayout';
import { useAuth } from '@/contexts/AuthContext';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Card, CardContent } from '@/components/ui/card';
import { LossRecordForm } from '@/components/shared/LossRecordForm';
import { ApiIngredient, ApiLossRecord, ApiStockItem, fetchInventory, fetchLossRecords, fetchStockItems } from '@/lib/api';
import { LOSS_REASONS } from '@/lib/types';
import { useVisiblePolling } from '@/hooks/useVisiblePolling';

const POLL_INTERVAL_MS = 20_000;

export default function LossLog() {
  const { user } = useAuth();
  const [ingredients, setIngredients] = useState<ApiIngredient[]>([]);
  const [stockItems, setStockItems] = useState<ApiStockItem[]>([]);
  const [records, setRecords] = useState<ApiLossRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [formKey, setFormKey] = useState(0);

  const load = useCallback(() => {
    Promise.all([fetchInventory(), fetchLossRecords(50), fetchStockItems({ active_only: false })])
      .then(([ing, rec, items]) => {
        setIngredients([...ing].sort((a, b) => a.name.localeCompare(b.name)));
        setRecords(rec);
        setStockItems(items);
      })
      .catch((e) => toast.error(`Failed to load loss log: ${e.message}`))
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

  function targetName(r: ApiLossRecord): string {
    if (r.ingredient_id) return ingredientsById.get(r.ingredient_id)?.name || r.ingredient_id.slice(0, 8);
    if (r.stock_item_id) return stockItemsById.get(r.stock_item_id)?.name || r.stock_item_id.slice(0, 8);
    return '--';
  }

  return (
    <DashboardLayout title="Loss Log">
      <div className="p-6 space-y-6">
        <Card>
          <CardContent className="pt-6">
            {user && (
              <LossRecordForm
                key={formKey}
                employeeId={user.id}
                ingredientOptions={ingredients.map((ing) => ({ id: ing.id, name: ing.name, unit: ing.base_unit }))}
                reasonOptions={LOSS_REASONS}
                defaultReason="spoilage"
                skipStockDeduction={false}
                allowSkipToggle
                allowUnitCostOverride
                submitLabel="Log loss"
                successToast={(record) => `Loss logged -- cost impact ${record.cost_impact.toFixed(2)}`}
                onSuccess={() => {
                  setFormKey((k) => k + 1);
                  load();
                }}
              />
            )}
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
                  <TableCell>{targetName(r)}</TableCell>
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
