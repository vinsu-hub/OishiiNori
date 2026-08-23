import React, { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ApiLossRecord, LossReason, createLossRecord } from '@/lib/api';

interface IngredientOption {
  id: string;
  name: string;
  unit?: string;
}

interface LossRecordFormProps {
  employeeId: string;
  productId?: string | null;

  // Ingredient: a picker (pass ingredientOptions) or a fixed ingredient
  // (pass fixedIngredientId/fixedIngredientLabel) -- never both.
  ingredientOptions?: IngredientOption[];
  fixedIngredientId?: string;
  fixedIngredientLabel?: string;

  // Quantity: editable by default, or fixed/read-only (e.g. Inventory
  // Count's shrinkage row, where the quantity IS the measured variance).
  quantityEditable?: boolean;
  fixedQuantity?: number;
  quantityUnit?: string;

  reasonOptions: { value: LossReason; label: string }[];
  defaultReason: LossReason;

  // Stock-deduction. IMPORTANT: this must stay hardcoded (non-togglable)
  // at any call site whose flow already accounts for the stock change
  // itself -- Kitchen Display's "Log extra usage" relies on this actually
  // deducting stock (skipStockDeduction=false, allowSkipToggle=false);
  // Inventory Count's post-count shrinkage dialog relies on it NOT
  // deducting again, since the count save already set current_stock
  // (skipStockDeduction=true, allowSkipToggle=false). Only the standalone
  // Loss Log page (which isn't tied to an automatic deduction elsewhere)
  // should ever set allowSkipToggle.
  skipStockDeduction: boolean;
  allowSkipToggle?: boolean;
  allowUnitCostOverride?: boolean;

  submitLabel: string;
  successToast: (record: ApiLossRecord) => string;
  onSuccess: (record: ApiLossRecord) => void;

  // 'compact': just a Reason select + submit button in a row, no
  // Ingredient/Quantity fields rendered -- for a caller (Inventory Count's
  // shrinkage dialog) that already displays the fixed ingredient/quantity
  // itself and would otherwise show it twice.
  layout?: 'default' | 'compact';
}

export function LossRecordForm({
  employeeId,
  productId,
  ingredientOptions,
  fixedIngredientId,
  fixedIngredientLabel,
  quantityEditable = true,
  fixedQuantity,
  quantityUnit,
  reasonOptions,
  defaultReason,
  skipStockDeduction,
  allowSkipToggle = false,
  allowUnitCostOverride = false,
  submitLabel,
  successToast,
  onSuccess,
  layout = 'default',
}: LossRecordFormProps) {
  const [ingredientId, setIngredientId] = useState(fixedIngredientId ?? '');
  const [reason, setReason] = useState<LossReason>(defaultReason);
  const [quantity, setQuantity] = useState(fixedQuantity != null ? String(fixedQuantity) : '');
  const [unitCost, setUnitCost] = useState('');
  const [skip, setSkip] = useState(skipStockDeduction);
  const [submitting, setSubmitting] = useState(false);

  const selectedOption = ingredientOptions?.find((o) => o.id === ingredientId);
  const unitLabel = quantityUnit ?? selectedOption?.unit;

  async function handleSubmit() {
    if (!ingredientId) {
      toast.error('Select an ingredient');
      return;
    }
    const qty = quantityEditable ? Number(quantity) : (fixedQuantity ?? Number(quantity));
    if (!qty || qty <= 0) {
      toast.error('Enter a quantity greater than 0');
      return;
    }
    setSubmitting(true);
    try {
      const record = await createLossRecord({
        ingredient_id: ingredientId,
        product_id: productId ?? undefined,
        employee_id: employeeId,
        reason,
        quantity: qty,
        unit_cost: allowUnitCostOverride && unitCost.trim() ? Number(unitCost) : undefined,
        skip_stock_deduction: allowSkipToggle ? skip : skipStockDeduction,
      });
      toast.success(successToast(record));
      onSuccess(record);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to log loss');
    } finally {
      setSubmitting(false);
    }
  }

  if (layout === 'compact') {
    return (
      <div className="flex items-center gap-2 shrink-0">
        <Select value={reason} onValueChange={(v) => setReason(v as LossReason)}>
          <SelectTrigger className="w-40 h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {reasonOptions.map((r) => (
              <SelectItem key={r.value} value={r.value}>
                {r.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button size="sm" variant="outline" disabled={submitting} onClick={handleSubmit}>
          {submitting ? 'Logging...' : submitLabel}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label>Ingredient</Label>
          {ingredientOptions ? (
            <Select value={ingredientId} onValueChange={setIngredientId}>
              <SelectTrigger>
                <SelectValue placeholder="Select ingredient" />
              </SelectTrigger>
              <SelectContent>
                {ingredientOptions.map((o) => (
                  <SelectItem key={o.id} value={o.id}>
                    {o.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <p className="text-sm font-medium py-2">{fixedIngredientLabel}</p>
          )}
        </div>
        <div className="space-y-1">
          <Label>Reason</Label>
          <Select value={reason} onValueChange={(v) => setReason(v as LossReason)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {reasonOptions.map((r) => (
                <SelectItem key={r.value} value={r.value}>
                  {r.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label>Quantity{unitLabel ? ` (${unitLabel})` : ''}</Label>
          {quantityEditable ? (
            <Input type="number" min={0} value={quantity} onChange={(e) => setQuantity(e.target.value)} placeholder="0" />
          ) : (
            <p className="text-sm font-medium py-2">
              {fixedQuantity} {unitLabel}
            </p>
          )}
        </div>
        {allowUnitCostOverride && (
          <div className="space-y-1">
            <Label>Unit cost (optional)</Label>
            <Input type="number" min={0} step="0.01" value={unitCost} onChange={(e) => setUnitCost(e.target.value)} />
          </div>
        )}
      </div>

      {allowSkipToggle && (
        <div className="flex items-center gap-2">
          <Checkbox id="skip-deduction" checked={skip} onCheckedChange={(checked) => setSkip(checked === true)} />
          <Label htmlFor="skip-deduction" className="text-sm font-normal">
            Skip stock deduction (this loss was already reflected by a prior Count Stock adjustment)
          </Label>
        </div>
      )}

      <Button disabled={submitting} onClick={handleSubmit}>
        {submitting ? 'Logging...' : submitLabel}
      </Button>
    </div>
  );
}
