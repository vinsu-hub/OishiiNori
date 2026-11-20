import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { AlertTriangle, History, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  type ApiItemUnit,
  type IngredientCostEntry,
  type RecipeCoverageIngredient,
  createItemUnit,
  fetchIngredientCostHistory,
  updateIngredient,
} from '@/lib/api';
import { describeSize, describeUnit, fmtQty, isCountUnit, measureOf, unitOptionsFor, type UnitOption } from '@/lib/units';
import { EMPTY_SIZE, SizeFields, sizeDraftFactor, type SizeDraft } from './SizeFields';
import { formatCurrency } from '@/lib/utils';

/** Food-cost effect of a new unit cost, worked out by the parent from the
 * recipes it already has loaded. */
export interface CostImpact {
  count: number;
  /** The menu item whose food-cost % moves the most. */
  biggest?: { label: string; before: number | null; after: number | null };
}

export function fmtUnitCost(value: number): string {
  // Costs per gram/ml are often centavos: keep 4 decimals there.
  return value < 1 ? `₱${value.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}` : formatCurrency(value);
}

export function describePurchase(p: IngredientCostEntry, baseUnit: string): string {
  if (p.price_paid == null) return `${fmtUnitCost(p.unit_cost)} per ${baseUnit}`;
  const qty = p.qty ?? 1;
  const unit = p.unit_name || baseUnit;
  const size = p.base_qty && p.base_qty !== 1 && p.unit_name ? ` (${fmtQty(qty * p.base_qty)} ${baseUnit})` : '';
  return `${formatCurrency(p.price_paid)} for ${fmtQty(qty)} ${unit}${size}`;
}

function fmtDay(iso: string) {
  return new Date(iso).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', timeZone: 'Asia/Manila' });
}

const SOURCE_LABEL: Record<string, string> = { manual: 'typed in', delivery: 'from a delivery', import: 'from the checklist' };

// Above these a cost is almost certainly a typo ("P1050 for 1 g" instead of 2 kg).
function looksTooHigh(cost: number, baseUnit: string) {
  return measureOf(baseUnit) ? cost > 20 : cost > 5000;
}

const WEIGH_PREFIX = 'weigh:';
const NEW_SIZE = 'new-size';

interface Props {
  ingredient: RecipeCoverageIngredient;
  /** Saved sizes for this ingredient (item_units). */
  units: ApiItemUnit[];
  impact?: (newCost: number) => CostImpact;
  /** Called after a save or a new size, so the parent reloads. */
  onSaved: () => void;
  onUnitAdded: (unit: ApiItemUnit) => void;
}

/** "Paid P[1050] for [2] [kg]" -- the one place a unit cost is typed, used by
 * both the Unit costs list and the Food cost breakdown. */
export function UnitCostEntry({ ingredient, units, impact, onSaved, onUnitAdded }: Props) {
  const base = ingredient.base_unit || 'pcs';
  const countUnit = isCountUnit(base);
  const options = useMemo(() => unitOptionsFor(base, units), [base, units]);

  const defaultKey = useMemo(() => {
    const last = ingredient.last_purchase?.unit_name?.toLowerCase();
    const lastOpt = last ? options.find((o) => o.name.toLowerCase() === last) : undefined;
    if (lastOpt) return lastOpt.key;
    const pack = options.find((o) => o.savedId);
    if (pack) return pack.key;
    const std = options.find((o) => o.key.startsWith('std:'));
    return std ? std.key : 'base';
  }, [ingredient.last_purchase, options]);

  const [price, setPrice] = useState('');
  const [qty, setQty] = useState('');
  const [unitKey, setUnitKey] = useState<string | null>(null);
  const [weight, setWeight] = useState('');
  const [newSize, setNewSize] = useState<SizeDraft>(EMPTY_SIZE);
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [history, setHistory] = useState<IngredientCostEntry[] | null>(null);

  const key = unitKey ?? defaultKey;
  const weighMeasure = key.startsWith(WEIGH_PREFIX) ? (key.slice(WEIGH_PREFIX.length) as 'kg' | 'L') : null;
  const weighSmall = weighMeasure === 'L' ? 'ml' : 'g';
  const weightNum = Number(weight);
  // For "kg" on a scoop-counted ingredient: 1 kg = 1000 g / (g per scoop) scoops.
  const option: UnitOption | null = weighMeasure
    ? weightNum > 0
      ? { key, name: weighMeasure, factor: 1000 / weightNum }
      : null
    : key === NEW_SIZE
      ? null
      : options.find((o) => o.key === key) ?? options[0];

  const priceNum = Number(price);
  const qtyNum = Number(qty || '1');
  const valid = price.trim() !== '' && Number.isFinite(priceNum) && priceNum >= 0 && Number.isFinite(qtyNum) && qtyNum > 0;
  const computed = valid && option ? priceNum / (qtyNum * option.factor) : null;

  const tooHigh = computed != null && looksTooHigh(computed, base);
  const current = ingredient.unit_cost;
  const bigJump = computed != null && current != null && current > 0 && computed > 0 && (computed / current > 3 || current / computed > 3);
  const needsConfirm = tooHigh || bigJump;
  const effect = computed != null && impact ? impact(computed) : null;

  function pick(value: string) {
    setUnitKey(value);
    setConfirming(false);
  }

  async function addSize() {
    const factor = sizeDraftFactor(newSize);
    if (factor == null) return;
    try {
      const unit = await createItemUnit({ ingredient_id: ingredient.id, name: newSize.name.trim(), base_qty: factor });
      onUnitAdded(unit);
      setUnitKey(unit.id);
      setNewSize(EMPTY_SIZE);
      toast.success(`Added: ${describeSize(unit.name, unit.base_qty, base)}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not add the size');
    }
  }

  async function save() {
    if (computed == null || !option) return;
    if (needsConfirm && !confirming) {
      setConfirming(true);
      return;
    }
    setSaving(true);
    try {
      // A weighed scoop becomes a saved "kg = 40 scoop" size, so next time
      // it's just "P350 for 1 kg".
      if (weighMeasure && !units.some((u) => u.name.toLowerCase() === weighMeasure.toLowerCase())) {
        const unit = await createItemUnit({ ingredient_id: ingredient.id, name: weighMeasure, base_qty: Math.round(option.factor * 10000) / 10000 });
        onUnitAdded(unit);
      }
      await updateIngredient(ingredient.id, {
        unit_cost: Math.round(computed * 10000) / 10000,
        price_paid: priceNum,
        purchase_qty: qtyNum,
        purchase_unit: option.name,
        purchase_base_qty: option.factor,
      });
      toast.success(`${ingredient.name}: ${fmtUnitCost(computed)} per ${base}`);
      setPrice('');
      setQty('');
      setWeight('');
      setConfirming(false);
      setHistory(null);
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save the unit cost');
    } finally {
      setSaving(false);
    }
  }

  function loadHistory(open: boolean) {
    if (!open || history) return;
    fetchIngredientCostHistory(ingredient.id)
      .then(setHistory)
      .catch(() => setHistory([]));
  }

  const qtyPlaceholder = option && option.key !== 'base' ? 'e.g. 2' : measureOf(base) ? 'e.g. 1000' : 'e.g. 1';

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted-foreground">Paid ₱</span>
        <Input
          className="w-28 placeholder:text-muted-foreground/60"
          inputMode="decimal"
          type="number"
          min={0}
          step="0.01"
          placeholder="e.g. 1050"
          value={price}
          onChange={(e) => { setPrice(e.target.value); setConfirming(false); }}
          aria-label={`Price paid for ${ingredient.name}`}
        />
        <span className="text-sm text-muted-foreground">for</span>
        <Input
          className="w-24 placeholder:text-muted-foreground/60"
          inputMode="decimal"
          type="number"
          min={0}
          step="any"
          placeholder={qtyPlaceholder}
          value={qty}
          onChange={(e) => { setQty(e.target.value); setConfirming(false); }}
          aria-label={`Quantity bought of ${ingredient.name}`}
        />
        <Select value={key} onValueChange={pick}>
          <SelectTrigger className="w-44" aria-label="Unit bought">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {options.map((o) => (
              <SelectItem key={o.key} value={o.key}>
                {describeUnit(o, base)}
              </SelectItem>
            ))}
            {countUnit && !options.some((o) => o.name.toLowerCase() === 'kg') && (
              <SelectItem value={`${WEIGH_PREFIX}kg`}>kg (by weight)</SelectItem>
            )}
            {countUnit && !options.some((o) => o.name.toLowerCase() === 'l') && (
              <SelectItem value={`${WEIGH_PREFIX}L`}>L (by volume)</SelectItem>
            )}
            <SelectItem value={NEW_SIZE}>+ New size (box, pack, gallon…)</SelectItem>
          </SelectContent>
        </Select>
        <Button size="sm" variant={confirming ? 'destructive' : 'default'} disabled={computed == null || saving} onClick={save}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : confirming ? 'Save anyway' : 'Save'}
        </Button>
        {computed != null && (
          <span className="text-sm font-medium text-primary">= {fmtUnitCost(computed)} per {base}</span>
        )}
      </div>

      {weighMeasure && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">1 {base} weighs</span>
          <Input
            className="w-20"
            inputMode="decimal"
            type="number"
            min={0}
            step="any"
            placeholder="e.g. 25"
            value={weight}
            onChange={(e) => setWeight(e.target.value)}
            aria-label={`How much one ${base} of ${ingredient.name} weighs`}
          />
          <span className="text-muted-foreground">{weighSmall}</span>
          {weightNum > 0 && (
            <span className="text-xs text-muted-foreground">
              → 1 {weighMeasure} = {fmtQty(1000 / weightNum)} {base}
            </span>
          )}
        </div>
      )}

      {key === NEW_SIZE && (
        <div className="flex flex-wrap items-end gap-2">
          <SizeFields draft={newSize} onChange={setNewSize} baseUnit={base} />
          <Button size="sm" variant="outline" disabled={sizeDraftFactor(newSize) == null} onClick={addSize}>
            Add size
          </Button>
        </div>
      )}

      {confirming && tooHigh && computed != null && (
        <p className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          That's {fmtUnitCost(computed)} for every single {base}. If you bought a box or a kilo, put how much was in it
          (e.g. 2 kg) and pick its unit. Tap Save anyway if it's right.
        </p>
      )}
      {confirming && !tooHigh && bigJump && computed != null && current != null && (
        <p className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          Big change: {fmtUnitCost(current)} → {fmtUnitCost(computed)} per {base}. Check the amount and unit, then tap Save anyway.
        </p>
      )}

      {effect && effect.count > 0 && (
        <p className="text-xs text-muted-foreground">
          Changes the food cost of {effect.count} menu item{effect.count === 1 ? '' : 's'}
          {effect.biggest && effect.biggest.after != null && (
            <>
              {' '}· {effect.biggest.label}{' '}
              {effect.biggest.before != null ? `${effect.biggest.before.toFixed(0)}% → ` : ''}
              <span className={effect.biggest.after > 40 ? 'font-semibold text-destructive' : 'font-medium text-foreground'}>
                {effect.biggest.after.toFixed(0)}%
              </span>
            </>
          )}
        </p>
      )}

      {ingredient.last_purchase && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>
            Last: {describePurchase(ingredient.last_purchase, base)} · {fmtDay(ingredient.last_purchase.created_at)}
            {ingredient.last_purchase.changed_by_name ? ` · ${ingredient.last_purchase.changed_by_name}` : ''}
          </span>
          <Popover onOpenChange={loadHistory}>
            <PopoverTrigger asChild>
              <button type="button" className="inline-flex items-center gap-1 underline underline-offset-2 hover:text-foreground">
                <History className="h-3 w-3" aria-hidden /> History
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-80 text-xs" align="start">
              <p className="mb-2 font-semibold">{ingredient.name}: price history</p>
              {history == null && <p className="text-muted-foreground">Loading…</p>}
              {history?.length === 0 && <p className="text-muted-foreground">No history yet.</p>}
              <ul className="max-h-64 space-y-2 overflow-y-auto">
                {history?.map((h, i) => (
                  <li key={i} className="border-b pb-1 last:border-0">
                    <p className="font-medium">
                      {fmtUnitCost(h.unit_cost)} per {base}
                      {h.previous_unit_cost != null && (
                        <span className="font-normal text-muted-foreground"> (was {fmtUnitCost(h.previous_unit_cost)})</span>
                      )}
                    </p>
                    <p className="text-muted-foreground">
                      {describePurchase(h, base)} · {fmtDay(h.created_at)} · {SOURCE_LABEL[h.source] ?? h.source}
                      {h.changed_by_name ? ` · ${h.changed_by_name}` : ''}
                    </p>
                    {h.note && <p className="text-muted-foreground">{h.note}</p>}
                  </li>
                ))}
              </ul>
            </PopoverContent>
          </Popover>
        </div>
      )}
    </div>
  );
}
