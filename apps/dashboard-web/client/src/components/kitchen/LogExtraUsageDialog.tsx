import React, { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ApiRecipeItem, LossReason, createLossRecord, fetchRecipe } from '@/lib/api';
import { LOSS_REASONS } from '@/lib/types';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  productSizeId: string;
  productName: string;
  employeeId: string;
}

// Wraps the existing Loss Log capability (POST /loss-records) right where an
// over-use mistake is actually noticed -- prepping the order -- instead of
// requiring a trip to the standalone Loss Log page later. No new backend
// endpoint: this is purely a closer-to-the-work UI for a capability that
// already fully existed.
export function LogExtraUsageDialog({ open, onOpenChange, productSizeId, productName, employeeId }: Props) {
  const [recipe, setRecipe] = useState<ApiRecipeItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [ingredientId, setIngredientId] = useState('');
  const [reason, setReason] = useState<LossReason>('prep_error');
  const [quantity, setQuantity] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setIngredientId('');
    setReason('prep_error');
    setQuantity('');
    setLoading(true);
    fetchRecipe(productSizeId)
      .then(setRecipe)
      .catch((e) => toast.error(e instanceof Error ? e.message : 'Failed to load recipe'))
      .finally(() => setLoading(false));
  }, [open, productSizeId]);

  const selected = recipe.find((r) => r.ingredient_id === ingredientId);

  async function handleSubmit() {
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
        employee_id: employeeId,
        reason,
        quantity: qty,
      });
      toast.success(`Logged -- cost impact ${record.cost_impact.toFixed(2)}`);
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to log extra usage');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Log Extra Usage -- {productName}</DialogTitle>
          <DialogDescription>
            Used more of an ingredient than the recipe calls for? Log the extra amount here -- it deducts stock
            immediately and shows up in Loss Log.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label>Ingredient</Label>
            <Select value={ingredientId} onValueChange={setIngredientId} disabled={loading}>
              <SelectTrigger>
                <SelectValue placeholder={loading ? 'Loading recipe...' : 'Select ingredient'} />
              </SelectTrigger>
              <SelectContent>
                {recipe.map((r) => (
                  <SelectItem key={r.ingredient_id} value={r.ingredient_id}>
                    {r.ingredient_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>Extra quantity{selected ? ` (${selected.unit})` : ''}</Label>
              <Input
                type="number"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                placeholder="0"
              />
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
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={submitting || loading}>
            Log Extra Usage
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
