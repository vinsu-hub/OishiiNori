import React, { useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { LossRecordForm } from '@/components/shared/LossRecordForm';
import { ApiRecipeItem, fetchRecipe } from '@/lib/api';
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

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    fetchRecipe(productSizeId)
      .then(setRecipe)
      .catch((e) => toast.error(e instanceof Error ? e.message : 'Failed to load recipe'))
      .finally(() => setLoading(false));
  }, [open, productSizeId]);

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
        {!loading && (
          <LossRecordForm
            key={productSizeId}
            employeeId={employeeId}
            ingredientOptions={recipe.map((r) => ({ id: r.ingredient_id, name: r.ingredient_name, unit: r.unit }))}
            reasonOptions={LOSS_REASONS}
            defaultReason="prep_error"
            skipStockDeduction={false}
            submitLabel="Log Extra Usage"
            successToast={(record) => `Logged -- cost impact ${record.cost_impact.toFixed(2)}`}
            onSuccess={() => onOpenChange(false)}
          />
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
