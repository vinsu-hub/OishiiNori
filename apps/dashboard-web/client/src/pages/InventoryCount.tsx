import React, { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { DashboardLayout } from '@/components/DashboardLayout';
import { useAuth } from '@/contexts/AuthContext';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ApiIngredient, countStock, fetchInventory } from '@/lib/api';

const POLL_INTERVAL_MS = 20_000;

const TIER_VARIANT: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  high: 'destructive',
  medium_high: 'secondary',
};

export default function InventoryCount() {
  const { user } = useAuth();
  const [ingredients, setIngredients] = useState<ApiIngredient[]>([]);
  const [loading, setLoading] = useState(true);
  const [target, setTarget] = useState<ApiIngredient | null>(null);
  const [countedStock, setCountedStock] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(() => {
    fetchInventory()
      .then((data) => setIngredients([...data].sort((a, b) => a.name.localeCompare(b.name))))
      .catch((e) => toast.error(`Failed to load inventory: ${e.message}`))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [load]);

  function openCount(ingredient: ApiIngredient) {
    setTarget(ingredient);
    setCountedStock(String(ingredient.current_stock));
  }

  async function handleSubmit() {
    if (!target || !user) return;
    const value = Number(countedStock);
    if (Number.isNaN(value) || value < 0) {
      toast.error('Enter a valid non-negative count');
      return;
    }
    setSubmitting(true);
    try {
      const result = await countStock(target.id, { employee_id: user.id, counted_stock: value });
      const varianceLabel = result.variance === 0 ? 'no variance' : `variance ${result.variance > 0 ? '+' : ''}${result.variance}`;
      toast.success(`${target.name} counted -- ${varianceLabel}`);
      setTarget(null);
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to submit count');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <DashboardLayout title="Inventory Count">
      <div className="p-6 space-y-3">
        {loading && <p className="text-sm text-muted-foreground">Loading inventory...</p>}
        {!loading && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Ingredient</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Current Stock</TableHead>
                <TableHead>Reorder Threshold</TableHead>
                <TableHead>Volatility</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {ingredients.map((ing) => (
                <TableRow key={ing.id}>
                  <TableCell className="font-medium">{ing.name}</TableCell>
                  <TableCell className="text-muted-foreground">{ing.category || '--'}</TableCell>
                  <TableCell>
                    {ing.current_stock} {ing.base_unit}
                  </TableCell>
                  <TableCell>
                    {ing.reorder_threshold} {ing.base_unit}
                  </TableCell>
                  <TableCell>
                    {ing.cost_volatility_tier && (
                      <Badge variant={TIER_VARIANT[ing.cost_volatility_tier] || 'outline'}>
                        {ing.cost_volatility_tier.replace('_', ' ')}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <Button size="sm" variant="outline" onClick={() => openCount(ing)}>
                      Count
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      <Dialog open={!!target} onOpenChange={(open) => !open && setTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Count {target?.name}</DialogTitle>
            <DialogDescription>
              System shows {target?.current_stock} {target?.base_unit}. Enter the actual physical count.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label>Counted stock ({target?.base_unit})</Label>
            <Input
              type="number"
              min={0}
              value={countedStock}
              onChange={(e) => setCountedStock(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button disabled={submitting} onClick={handleSubmit}>
              {submitting ? 'Submitting...' : 'Submit count'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
}
