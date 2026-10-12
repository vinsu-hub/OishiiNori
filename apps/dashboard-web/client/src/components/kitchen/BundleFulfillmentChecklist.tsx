import React, { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ApiProduct, ApiProductSize, submitBundleFulfillment } from '@/lib/api';

// No schema flag distinguishes "premium" rolls -- per the locked Sushi Boat
// scope decision (SESSION_HANDOFF.md 2026-08-21), "classic flavors" excludes
// exactly these two catalog items, matched by their real product names (not
// "Dragon Roll" as the handoff's shorthand phrasing suggested).
const PREMIUM_ROLLS = ['Dragon Maki', 'Oishii Maki'];

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  transactionId: string;
  itemId: string;
  bundleProduct: ApiProduct;
  bundleSize: ApiProductSize;
  itemQuantity: number;
  eligibleRolls: ApiProduct[];
  onFulfilled: () => void;
}

export function BundleFulfillmentChecklist({
  open,
  onOpenChange,
  transactionId,
  itemId,
  bundleProduct,
  bundleSize,
  itemQuantity,
  eligibleRolls,
  onFulfilled,
}: Props) {
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [submitting, setSubmitting] = useState(false);

  const isSushiBoat = bundleProduct.name.includes('Sushi Boat');
  const rolls = useMemo(
    () => eligibleRolls.filter((r) => !(isSushiBoat && PREMIUM_ROLLS.includes(r.name))),
    [eligibleRolls, isSushiBoat]
  );

  const requiredTotal = bundleSize.total_pieces != null ? bundleSize.total_pieces * itemQuantity : null;
  const runningTotal = Object.values(quantities).reduce((sum, q) => sum + q, 0);
  const matches = requiredTotal != null && runningTotal === requiredTotal;

  function setQty(productId: string, delta: number) {
    setQuantities((prev) => {
      const next = Math.max(0, (prev[productId] || 0) + delta);
      return { ...prev, [productId]: next };
    });
  }

  async function handleSubmit() {
    if (!matches) return;
    const lines = Object.entries(quantities)
      .filter(([, q]) => q > 0)
      .map(([maki_roll_product_id, quantity]) => ({ maki_roll_product_id, quantity }));
    setSubmitting(true);
    try {
      const result = await submitBundleFulfillment(transactionId, itemId, lines);
      if (result.stock_deduction_status === 'pending_recipe') {
        toast.warning(`${bundleProduct.name} rolls logged. Stock deduction is pending a verified recipe; the ticket can move on.`);
      } else {
        toast.success(`${bundleProduct.name} rolls logged and stock deducted`);
      }
      setQuantities({});
      onFulfilled();
      onOpenChange(false);
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Failed to log rolls';
      // Identical retries succeed on the server. A conflict may instead be a
      // partial legacy fulfillment; never turn an error into local success.
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{bundleProduct.name} -- rolls used</DialogTitle>
          <DialogDescription>
            {requiredTotal != null
              ? `Log the actual rolls used for this ${itemQuantity > 1 ? `${itemQuantity}x ` : ''}${bundleSize.size_label}. Must total exactly ${requiredTotal} pieces.`
              : 'No bundle configuration found for this size -- cannot log a checklist.'}
          </DialogDescription>
        </DialogHeader>

        {requiredTotal != null && (
          <>
            <div className="space-y-2 max-h-80 overflow-auto">
              {rolls.map((roll) => (
                <div key={roll.id} className="flex items-center justify-between text-sm border-b pb-2">
                  <span>{roll.name}</span>
                  <div className="flex items-center gap-2">
                    <Button size="icon" variant="outline" className="h-6 w-6" onClick={() => setQty(roll.id, -1)}>
                      -
                    </Button>
                    <span className="w-6 text-center">{quantities[roll.id] || 0}</span>
                    <Button size="icon" variant="outline" className="h-6 w-6" onClick={() => setQty(roll.id, 1)}>
                      +
                    </Button>
                  </div>
                </div>
              ))}
            </div>

            <div className="flex items-center justify-between pt-2">
              <span className="text-sm text-muted-foreground">Running total</span>
              <Badge variant={matches ? 'default' : 'secondary'}>
                {runningTotal} / {requiredTotal}
              </Badge>
            </div>
          </>
        )}

        <DialogFooter>
          <Button disabled={!matches || submitting} onClick={handleSubmit}>
            {submitting ? 'Logging...' : 'Submit'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
