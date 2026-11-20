import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  type ApiItemUnit,
  changeItemBaseUnit,
  createItemUnit,
  deleteItemUnit,
  updateIngredient,
  updateStockItem,
} from '@/lib/api';
import { describeSize, fmtQty, measureOf, type SizeDirection } from '@/lib/units';
import { EMPTY_SIZE, SizeFields, sizeDraftFactor, type SizeDraft } from './SizeFields';

export interface EditableItem {
  kind: 'ingredient' | 'stock_item';
  id: string;
  name: string;
  unit: string;
}

const COMMON_MAIN_UNITS = ['pcs', 'g', 'ml', 'pack', 'sachet', 'sheet'];

/** The API's {"detail": "..."} out of "API /x failed: 409 {...}". */
function apiMessage(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  const json = text.indexOf('{');
  if (json >= 0) {
    try {
      const detail = JSON.parse(text.slice(json)).detail;
      if (typeof detail === 'string') return detail;
    } catch {
      /* not JSON */
    }
  }
  return text;
}

/** How many NEW units one OLD unit is, when we already know it: g <-> kg,
 * ml <-> L, or the new unit is one of the item's saved sizes. */
function knownFactor(oldUnit: string, newUnit: string, sizes: ApiItemUnit[]): number | null {
  const o = oldUnit.trim().toLowerCase();
  const n = newUnit.trim().toLowerCase();
  if (!n || n === o) return null;
  const size = sizes.find((s) => s.name.toLowerCase() === n);
  if (size) return 1 / size.base_qty; // 1 size = base_qty old -> 1 old = 1/base_qty new
  const pairs: Record<string, number> = { 'kg>g': 1000, 'g>kg': 0.001, 'l>ml': 1000, 'ml>l': 0.001 };
  const key = `${measureOf(o) ?? o}>${measureOf(n) ?? n}`;
  return pairs[key] ?? null;
}

/** Edit button on EOD Stock Count and Unit costs: rename, change the main
 * unit (converting everything stored in it) and manage the saved sizes. */
export function EditItemDialog({
  item,
  sizes,
  onOpenChange,
  onSaved,
}: {
  item: EditableItem | null;
  /** The item's saved sizes (item_units). */
  sizes: ApiItemUnit[];
  onOpenChange: (open: boolean) => void;
  /** Reload after any change (name, unit or sizes). */
  onSaved: () => void;
}) {
  const [name, setName] = useState('');
  const [unit, setUnit] = useState('');
  const [direction, setDirection] = useState<SizeDirection>('up');
  const [qty, setQty] = useState('');
  const [newSize, setNewSize] = useState<SizeDraft>(EMPTY_SIZE);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!item) return;
    setName(item.name);
    setUnit(item.unit);
    setQty('');
    setDirection('up');
    setNewSize(EMPTY_SIZE);
  }, [item]);

  const oldUnit = item?.unit ?? '';
  const unitChanged = !!item && unit.trim() !== '' && unit.trim().toLowerCase() !== oldUnit.trim().toLowerCase();
  const nameChanged = !!item && name.trim() !== '' && name.trim() !== item.name;
  const known = useMemo(() => (unitChanged ? knownFactor(oldUnit, unit, sizes) : null), [unitChanged, oldUnit, unit, sizes]);
  const qtyNum = Number(qty);
  // factor = how many NEW units one OLD unit is.
  const typedFactor = Number.isFinite(qtyNum) && qtyNum > 0 ? (direction === 'up' ? qtyNum : 1 / qtyNum) : null;
  const factor = qty.trim() ? typedFactor : known;
  const canSave = !!item && !saving && (nameChanged || unitChanged) && (!unitChanged || factor != null);

  async function save() {
    if (!item || !canSave) return;
    setSaving(true);
    try {
      if (nameChanged) {
        if (item.kind === 'ingredient') await updateIngredient(item.id, { name: name.trim() });
        else await updateStockItem(item.id, { name: name.trim() });
      }
      if (unitChanged && factor != null) {
        await changeItemBaseUnit(item.kind, item.id, { new_unit: unit.trim(), factor });
      }
      toast.success(
        unitChanged && factor != null
          ? `${name.trim()}: now counted in ${unit.trim().toLowerCase()} (1 ${oldUnit} = ${fmtQty(factor)} ${unit.trim().toLowerCase()})`
          : `Renamed to ${name.trim()}`
      );
      onSaved();
      onOpenChange(false);
    } catch (e) {
      toast.error(apiMessage(e));
    } finally {
      setSaving(false);
    }
  }

  async function addSize() {
    if (!item) return;
    const f = sizeDraftFactor(newSize);
    if (f == null) return;
    try {
      const u = await createItemUnit({
        ingredient_id: item.kind === 'ingredient' ? item.id : undefined,
        stock_item_id: item.kind === 'stock_item' ? item.id : undefined,
        name: newSize.name.trim(),
        base_qty: f,
      });
      toast.success(`Added: ${describeSize(u.name, u.base_qty, oldUnit)}`);
      setNewSize(EMPTY_SIZE);
      onSaved();
    } catch (e) {
      toast.error(apiMessage(e));
    }
  }

  async function removeSize(u: ApiItemUnit) {
    try {
      await deleteItemUnit(u.id);
      toast.success(`Removed size: ${u.name}`);
      onSaved();
    } catch (e) {
      toast.error(apiMessage(e));
    }
  }

  const newUnitLabel = unit.trim().toLowerCase() || 'new unit';

  return (
    <Dialog open={!!item} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit {item?.name}</DialogTitle>
          <DialogDescription>Change the name, the unit it's counted in, or its sizes (pack, box, tray…).</DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="edit-item-name">Name</Label>
            <Input id="edit-item-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
          </div>

          <div className="space-y-2">
            <Label htmlFor="edit-item-unit">Main unit (stock is kept in this)</Label>
            <Input id="edit-item-unit" value={unit} onChange={(e) => setUnit(e.target.value)} maxLength={30} className="w-40" />
            <div className="flex flex-wrap gap-1.5">
              {COMMON_MAIN_UNITS.map((u) => (
                <button
                  key={u}
                  type="button"
                  onClick={() => setUnit(u)}
                  className={`rounded-full border px-2.5 py-1 text-xs ${
                    unit.trim().toLowerCase() === u ? 'border-primary bg-primary/10 text-primary' : 'hover:bg-muted'
                  }`}
                >
                  {u}
                </button>
              ))}
            </div>
            {unitChanged && (
              <div className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
                <p>
                  How do <b>{oldUnit}</b> and <b>{newUnitLabel}</b> compare? Stock, sizes, recipes, batch recipes and count
                  history are all converted with this.
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {(
                    [
                      ['up', `1 ${oldUnit} = ? ${newUnitLabel}`],
                      ['down', `1 ${newUnitLabel} = ? ${oldUnit}`],
                    ] as const
                  ).map(([dir, label]) => (
                    <button
                      key={dir}
                      type="button"
                      onClick={() => setDirection(dir)}
                      className={`rounded-full border px-2.5 py-1 text-xs ${
                        direction === dir ? 'border-primary bg-white text-primary' : 'border-amber-300 hover:bg-white'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span>1 {direction === 'up' ? oldUnit : newUnitLabel} =</span>
                  <Input
                    className="h-8 w-24 bg-white"
                    type="number"
                    min={0}
                    step="any"
                    inputMode="decimal"
                    placeholder={known != null ? fmtQty(direction === 'up' ? known : 1 / known) : 'e.g. 120'}
                    value={qty}
                    onChange={(e) => setQty(e.target.value)}
                    aria-label="Conversion"
                  />
                  <span>{direction === 'up' ? newUnitLabel : oldUnit}</span>
                </div>
                {factor != null ? (
                  <p className="text-xs">
                    So 1 {oldUnit} = <b>{fmtQty(factor)} {newUnitLabel}</b>. “{oldUnit}” stays as a size, so counting in{' '}
                    {oldUnit} still works.
                  </p>
                ) : (
                  <p className="text-xs">Fill this in to save the new unit.</p>
                )}
              </div>
            )}
          </div>

          <div className="space-y-2">
            <Label>Sizes</Label>
            {sizes.length === 0 ? (
              <p className="text-xs text-muted-foreground">No sizes yet: it's counted in {oldUnit} only.</p>
            ) : (
              <ul className="space-y-1">
                {[...sizes].sort((a, b) => b.base_qty - a.base_qty).map((u) => (
                  <li key={u.id} className="flex items-center justify-between rounded-md border px-3 py-1.5 text-sm">
                    <span>
                      <b>{u.name}</b> · {describeSize(u.name, u.base_qty, oldUnit)}
                    </span>
                    <Button size="icon" variant="ghost" className="h-7 w-7" aria-label={`Remove size ${u.name}`} onClick={() => removeSize(u)}>
                      <Trash2 className="h-4 w-4" aria-hidden />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            {unitChanged ? (
              <p className="text-xs text-muted-foreground">Save the new unit first, then add sizes.</p>
            ) : (
              <div className="space-y-2 rounded-md bg-muted/50 p-3">
                <SizeFields draft={newSize} onChange={setNewSize} baseUnit={oldUnit} />
                <Button size="sm" variant="outline" disabled={sizeDraftFactor(newSize) == null} onClick={addSize}>
                  Add size
                </Button>
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button disabled={!canSave} onClick={save}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
