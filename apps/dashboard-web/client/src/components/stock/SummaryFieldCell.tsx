import React, { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { TableCell } from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Flag } from 'lucide-react';
import { FieldOverride, StockSummaryField } from '@/lib/api';
import { STOCK_TABLE_CELL_CLASS } from '@/components/stock/stockTableStyle';

// Shared by Station Items and Ingredient Stock (0030) -- both render the
// same computed New Stocks/Beginning/Usage/Ending shape and correct it the
// same way: a per-field flag icon opens a dialog requiring a corrected
// value + reason, which the caller submits through its own field-override
// endpoint (overrideStockItemField / overrideIngredientField). Never a
// silent overwrite of the auto-computed value.
export const FIELD_LABELS: Record<StockSummaryField, string> = {
  new_stocks: 'New Stocks',
  beginning: 'Beginning',
  usage: 'Usage',
  ending: 'Ending',
};

export interface FieldSummaryLike {
  new_stocks: number;
  beginning: number;
  usage: number;
  ending: number;
  overrides: Partial<Record<StockSummaryField, FieldOverride>>;
}

interface SummaryFieldCellProps<T extends FieldSummaryLike> {
  field: StockSummaryField;
  itemName: string;
  summary: T | undefined;
  employeeId: string | undefined;
  onOverride: (field: StockSummaryField, correctedValue: number, reason: string, employeeId: string) => Promise<T>;
  onSaved: (summary: T) => void;
  extra?: React.ReactNode;
  // Appended to the flag button's tooltip when this field, for this row,
  // corrects something other than just this row's own number (e.g. Station
  // Items' linked-ingredient Ending/New Stocks).
  linkedHint?: string;
}

export function SummaryFieldCell<T extends FieldSummaryLike>({
  field,
  itemName,
  summary,
  employeeId,
  onOverride,
  onSaved,
  extra,
  linkedHint,
}: SummaryFieldCellProps<T>) {
  const [flagOpen, setFlagOpen] = useState(false);
  const [correctedValue, setCorrectedValue] = useState('');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  const value = summary?.[field];
  const override = summary?.overrides[field];

  function openFlag() {
    setCorrectedValue(value != null ? String(value) : '');
    setReason('');
    setFlagOpen(true);
  }

  async function handleSubmit() {
    if (!employeeId) return;
    const corrected = Number(correctedValue);
    if (correctedValue.trim() === '' || Number.isNaN(corrected)) {
      toast.error('Enter a corrected value');
      return;
    }
    if (!reason.trim()) {
      toast.error('A reason is required to flag/correct a field');
      return;
    }
    setSaving(true);
    try {
      const result = await onOverride(field, corrected, reason.trim(), employeeId);
      onSaved(result);
      toast.success(`${FIELD_LABELS[field]} corrected for ${itemName}`);
      setFlagOpen(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save correction');
    } finally {
      setSaving(false);
    }
  }

  return (
    <TableCell className={`${STOCK_TABLE_CELL_CLASS} text-right align-top`}>
      <div className="flex items-center justify-end gap-1">
        <span className={`text-sm font-medium ${override ? 'text-warning' : ''}`}>
          {value != null ? value : '--'}
        </span>
        <button
          type="button"
          className="text-muted-foreground hover:text-warning"
          title={linkedHint ? `Flag ${FIELD_LABELS[field]} as wrong (${linkedHint})` : `Flag ${FIELD_LABELS[field]} as wrong`}
          onClick={openFlag}
        >
          <Flag className="w-3.5 h-3.5" />
        </button>
      </div>
      {extra}
      {override && (
        <p className="text-[10px] text-warning mt-0.5" title={override.reason}>
          flagged: {override.reason}
        </p>
      )}

      <Dialog open={flagOpen} onOpenChange={setFlagOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Flag {FIELD_LABELS[field]} -- {itemName}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Auto-computed value: <span className="font-medium text-foreground">{value != null ? value : '--'}</span>
            </p>
            <div className="space-y-1">
              <Label>Corrected value</Label>
              <Input type="number" value={correctedValue} onChange={(e) => setCorrectedValue(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>Reason (required)</Label>
              <Input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. physical recount found 3 more cups"
              />
            </div>
          </div>
          <DialogFooter>
            <Button disabled={saving} onClick={handleSubmit}>
              {saving ? 'Saving...' : 'Save correction'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </TableCell>
  );
}
