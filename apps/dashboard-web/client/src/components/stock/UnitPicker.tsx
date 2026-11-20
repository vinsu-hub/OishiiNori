import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { createItemUnit, type ApiItemUnit } from '@/lib/api';
import { COMMON_UNIT_NAMES, describeSize, describeUnit, fmtQty, type UnitOption } from '@/lib/units';
import { EMPTY_SIZE, SizeFields, sizeDraftFactor, type SizeDraft } from './SizeFields';

const NEW_UNIT = '__new__';

/** Unit dropdown for one item: base unit, built-ins (kg / L), the item's
 * saved units, and "+ New unit…" which opens NewUnitDialog. */
export function UnitSelect({
  options,
  baseUnit,
  value,
  onChange,
  onRequestNew,
  disabled,
  id,
}: {
  options: UnitOption[];
  baseUnit: string;
  value: string;
  onChange: (key: string) => void;
  onRequestNew?: () => void;
  disabled?: boolean;
  id?: string;
}) {
  return (
    <Select
      value={value}
      disabled={disabled}
      onValueChange={(v) => (v === NEW_UNIT ? onRequestNew?.() : onChange(v))}
    >
      <SelectTrigger id={id} className="w-full">
        <SelectValue placeholder="Unit" />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.key} value={o.key}>
            {describeUnit(o, baseUnit)}
          </SelectItem>
        ))}
        {onRequestNew && (
          <>
            <SelectSeparator />
            <SelectItem value={NEW_UNIT}>+ New unit…</SelectItem>
          </>
        )}
      </SelectContent>
    </Select>
  );
}

/** "= 200 sheet" under a quantity entered in a non-base unit. */
export function ConversionHint({ qty, option, baseUnit }: { qty: string; option?: UnitOption; baseUnit: string }) {
  const n = Number(qty);
  if (!option || option.key === 'base' || !Number.isFinite(n) || n <= 0) return null;
  return (
    <p className="text-xs text-muted-foreground">
      = <span className="font-semibold text-foreground">{fmtQty(n * option.factor)} {baseUnit}</span>
    </p>
  );
}

/** Create a named unit for one item: "1 pack = __ sheet". */
export function NewUnitDialog({
  open,
  onOpenChange,
  itemName,
  baseUnit,
  target,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  itemName: string;
  baseUnit: string;
  target: { kind: 'ingredient' | 'stock_item'; id: string } | null;
  onCreated: (unit: ApiItemUnit) => void;
}) {
  const [draft, setDraft] = useState<SizeDraft>(EMPTY_SIZE);
  const [saving, setSaving] = useState(false);

  const name = draft.name;
  const factor = sizeDraftFactor(draft);
  const valid = factor != null;

  async function save() {
    if (!target || factor == null) return;
    setSaving(true);
    try {
      const unit = await createItemUnit({
        ingredient_id: target.kind === 'ingredient' ? target.id : undefined,
        stock_item_id: target.kind === 'stock_item' ? target.id : undefined,
        name: name.trim(),
        base_qty: factor,
      });
      toast.success(`Saved: ${describeSize(unit.name, unit.base_qty, baseUnit)}`);
      onCreated(unit);
      setDraft(EMPTY_SIZE);
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save the unit');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New unit for {itemName}</DialogTitle>
          <DialogDescription>
            Stock is counted in <b>{baseUnit}</b>. Say how the new unit compares to one {baseUnit} — next time just
            log “2 packs” (or “500 g”) and the {baseUnit} fill in automatically.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="flex flex-wrap gap-1.5">
            {COMMON_UNIT_NAMES.map((u) => (
              <button
                key={u}
                type="button"
                onClick={() => setDraft({ ...draft, name: u, direction: 'up' })}
                className={`rounded-full border px-2.5 py-1 text-xs ${
                  name.trim().toLowerCase() === u ? 'border-primary bg-primary/10 text-primary' : 'hover:bg-muted'
                }`}
              >
                {u}
              </button>
            ))}
          </div>
          <SizeFields draft={draft} onChange={setDraft} baseUnit={baseUnit} />
          <p className="text-xs text-muted-foreground">
            Smaller works too — a nori sheet cut in 4 is “1 sheet = 4 mini sheet”; a piece that weighs 120 g is “1 pcs = 120 g”.
          </p>
          {factor != null && (
            <p className="rounded-md bg-muted px-3 py-2 text-sm">
              <b>{describeSize(name.trim(), factor, baseUnit)}</b>
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!valid || saving || !target} onClick={save}>
            {saving ? 'Saving…' : 'Save unit'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
