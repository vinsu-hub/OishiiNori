import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { ChefHat, Plus, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  type ApiItemUnit,
  type PrepBase,
  type RecipeCoverageIngredient,
  fetchPrepBases,
  makePrepBatch,
  removePrepBase,
  savePrepBase,
} from '@/lib/api';
import { fmtQty, unitOptionsFor, unitsForItem, type UnitOption } from '@/lib/units';
import { formatCurrency } from '@/lib/utils';
import { UnitSelect } from '@/components/stock/UnitPicker';
import { type CostImpact, UnitCostEntry, fmtUnitCost } from '@/components/stock/UnitCostEntry';

interface Props {
  ingredients: RecipeCoverageIngredient[];
  itemUnits: ApiItemUnit[];
  /** Owner: edit batch recipes and costs. */
  canEdit: boolean;
  /** Owner, manager, stocker: log "Made a batch". */
  canMake: boolean;
  impactFor: (ingredientId: string, newCost: number) => CostImpact;
  onUnitAdded: (unit: ApiItemUnit) => void;
  /** Costs changed -- the parent reloads recipes & food cost. */
  onChanged: () => void;
}

interface DraftRow {
  ingredient_id: string;
  qty: string;
  unitKey: string;
}

interface Draft {
  baseId: string;
  yieldQty: string;
  yieldKey: string;
  rows: DraftRow[];
}

function keyForName(options: UnitOption[], name: string | null | undefined): UnitOption {
  const lower = (name || '').toLowerCase();
  return options.find((o) => o.name.toLowerCase() === lower) ?? options[0];
}

/** "2 can" / "300 g" for a component, in the unit it was typed in. */
function describeQty(qty: number, baseUnit: string, unit: string | null, options: UnitOption[]): string {
  const opt = keyForName(options, unit);
  if (!unit || opt.key === 'base') return `${fmtQty(qty)} ${baseUnit}`;
  return `${fmtQty(qty / opt.factor)} ${opt.name} (${fmtQty(qty)} ${baseUnit})`;
}

/** Recipes & Costs -> Prep bases: things the kitchen makes in batches (Milk
 * tea base, Mousse, Hot Mayo). What one batch takes + how much it makes
 * gives the cost per scoop / ml, which every menu recipe using the base
 * then picks up. "Made a batch" takes the components off stock and adds the
 * batch to the base. */
export function PrepBasesPanel({ ingredients, itemUnits, canEdit, canMake, impactFor, onUnitAdded, onChanged }: Props) {
  const [bases, setBases] = useState<PrepBase[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [costFor, setCostFor] = useState<string | null>(null);
  const [making, setMaking] = useState<PrepBase | null>(null);
  const [batches, setBatches] = useState('1');

  const load = useCallback(() => {
    setLoading(true);
    fetchPrepBases()
      .then(setBases)
      .catch((e) => toast.error(`Could not load prep bases: ${e instanceof Error ? e.message : e}`))
      .finally(() => setLoading(false));
  }, []);
  useEffect(load, [load]);

  const byId = useMemo(() => new Map(ingredients.map((i) => [i.id, i])), [ingredients]);
  const optionsFor = (id: string) => unitOptionsFor(byId.get(id)?.base_unit, unitsForItem(itemUnits, 'ingredient', id));
  const baseIds = new Set(bases.map((b) => b.ingredient_id));
  const componentIds = new Set(bases.flatMap((b) => b.components.map((c) => c.ingredient_id)));
  const sortedIngredients = useMemo(() => [...ingredients].sort((a, b) => a.name.localeCompare(b.name)), [ingredients]);

  function startEdit(base: PrepBase | null) {
    if (!base) {
      setDraft({ baseId: '', yieldQty: '', yieldKey: 'base', rows: [{ ingredient_id: '', qty: '', unitKey: 'base' }] });
      return;
    }
    const yieldOpts = optionsFor(base.ingredient_id);
    setDraft({
      baseId: base.ingredient_id,
      yieldQty: base.prep_yield != null ? fmtQty(base.prep_yield) : '',
      yieldKey: yieldOpts[0].key,
      rows: base.components.map((c) => {
        const opt = keyForName(optionsFor(c.ingredient_id), c.unit);
        return { ingredient_id: c.ingredient_id, qty: fmtQty(c.qty / opt.factor), unitKey: opt.key };
      }),
    });
  }

  function setRow(i: number, patch: Partial<DraftRow>) {
    setDraft((d) => d && { ...d, rows: d.rows.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  }

  async function save() {
    if (!draft) return;
    const baseIng = byId.get(draft.baseId);
    if (!baseIng) return toast.error('Pick which ingredient this batch makes');
    const yieldOpt = optionsFor(draft.baseId).find((o) => o.key === draft.yieldKey) ?? optionsFor(draft.baseId)[0];
    const yieldNum = Number(draft.yieldQty) * yieldOpt.factor;
    if (!(yieldNum > 0)) return toast.error(`How much does one batch make? (in ${baseIng.base_unit})`);
    const components = [];
    for (const row of draft.rows) {
      if (!row.ingredient_id && !row.qty) continue;
      const opt = optionsFor(row.ingredient_id).find((o) => o.key === row.unitKey) ?? optionsFor(row.ingredient_id)[0];
      const qty = Number(row.qty) * opt.factor;
      if (!row.ingredient_id || !(qty > 0)) return toast.error('Every ingredient line needs an ingredient and an amount');
      components.push({ ingredient_id: row.ingredient_id, qty, unit: opt.name });
    }
    if (!components.length) return toast.error('Add at least one ingredient');
    setSaving(true);
    try {
      const saved = await savePrepBase(draft.baseId, { prep_yield: yieldNum, components });
      toast.success(
        saved.cost_per_unit != null
          ? `${saved.name}: ${fmtUnitCost(saved.cost_per_unit)} per ${saved.base_unit}`
          : `${saved.name} saved -- add the missing costs to get its cost per ${saved.base_unit}`,
      );
      setDraft(null);
      load();
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function remove(base: PrepBase) {
    if (!window.confirm(`Stop treating ${base.name} as a prep base? Its last cost stays; recipes that use it are not changed.`)) return;
    try {
      await removePrepBase(base.ingredient_id);
      setDraft(null);
      load();
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  async function confirmMake() {
    if (!making) return;
    const n = Number(batches);
    if (!(n > 0)) return toast.error('How many batches?');
    setSaving(true);
    try {
      const out = await makePrepBatch(making.ingredient_id, n);
      toast.success(`Added ${fmtQty(out.added)} ${making.base_unit} of ${making.name}`);
      setMaking(null);
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <p className="text-sm text-muted-foreground">Loading…</p>;

  const draftBase = draft ? byId.get(draft.baseId) : undefined;
  const makingN = Number(batches) > 0 ? Number(batches) : 0;

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Things the kitchen makes in batches: milk tea base, mousse, hot mayo. List what <span className="font-medium text-foreground">one batch</span>{' '}
        takes and how much it makes, and the cost per scoop or ml is worked out from the ingredients' own costs. Menu
        recipes keep using the base, so their food cost follows. When a batch is made, tap{' '}
        <span className="font-medium text-foreground">Made a batch</span>: its ingredients come off stock and the batch is added.
      </p>

      {bases.length === 0 && !draft && (
        <p className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">No prep bases yet.</p>
      )}

      {bases.map((base) => {
        if (draft?.baseId === base.ingredient_id) return null;
        const yieldText = base.prep_yield != null ? `${fmtQty(base.prep_yield)} ${base.base_unit}` : 'not set';
        return (
          <div key={base.ingredient_id} className="rounded-lg border">
            <div className="flex flex-wrap items-start justify-between gap-2 border-b p-3">
              <div className="min-w-0">
                <p className="flex items-center gap-2 font-semibold">
                  <ChefHat className="h-4 w-4 text-primary" aria-hidden /> {base.name}
                </p>
                <p className="text-xs text-muted-foreground">
                  One batch makes <span className={base.prep_yield ? 'font-medium text-foreground' : 'text-amber-800'}>{yieldText}</span>
                  {' · '}In stock: {fmtQty(base.current_stock)} {base.base_unit}
                </p>
              </div>
              <div className="text-right">
                {base.cost_per_unit != null ? (
                  <p className="text-lg font-semibold tabular-nums">
                    {fmtUnitCost(base.cost_per_unit)} <span className="text-sm font-normal text-muted-foreground">per {base.base_unit}</span>
                  </p>
                ) : (
                  <Badge variant="outline" className="border-amber-400 text-amber-800">
                    {base.prep_yield ? `No cost yet: ${base.missing_cost.join(', ')}` : 'Set how much one batch makes'}
                  </Badge>
                )}
                <p className="text-xs text-muted-foreground">Batch: {formatCurrency(base.batch_cost)}{base.missing_cost.length ? ' so far' : ''}</p>
              </div>
            </div>
            <div className="divide-y">
              {base.components.map((c) => {
                const ing = byId.get(c.ingredient_id);
                const open = costFor === `${base.ingredient_id}:${c.ingredient_id}`;
                return (
                  <div key={c.ingredient_id} className={`p-2 px-3 ${c.unit_cost == null ? 'bg-amber-50/60' : ''}`}>
                    <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                      <div className="min-w-0">
                        <p className="font-medium">{c.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {describeQty(c.qty, c.base_unit, c.unit, optionsFor(c.ingredient_id))} ×{' '}
                          {c.unit_cost != null ? `${fmtUnitCost(c.unit_cost)} per ${c.base_unit}` : <span className="text-amber-800">no cost yet</span>}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="tabular-nums">{c.line_cost != null ? formatCurrency(c.line_cost) : '—'}</span>
                        {canEdit && ing && (
                          <Button size="sm" variant="outline" onClick={() => setCostFor(open ? null : `${base.ingredient_id}:${c.ingredient_id}`)}>
                            {open ? 'Close' : c.unit_cost == null ? 'Add cost' : 'Edit cost'}
                          </Button>
                        )}
                      </div>
                    </div>
                    {open && ing && (
                      <div className="mt-2 border-t pt-2">
                        <UnitCostEntry
                          ingredient={ing}
                          units={unitsForItem(itemUnits, 'ingredient', ing.id)}
                          impact={(cost) => impactFor(ing.id, cost)}
                          onSaved={() => { setCostFor(null); load(); onChanged(); }}
                          onUnitAdded={onUnitAdded}
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 border-t bg-muted/30 p-2 px-3">
              <p className="text-xs text-muted-foreground">
                {base.cost_per_unit != null && base.prep_yield
                  ? `${formatCurrency(base.batch_cost)} ÷ ${fmtQty(base.prep_yield)} ${base.base_unit} = ${fmtUnitCost(base.cost_per_unit)} per ${base.base_unit}`
                  : 'The cost per unit appears once every ingredient has a cost.'}
              </p>
              <div className="flex gap-2">
                {canEdit && (
                  <Button size="sm" variant="ghost" onClick={() => startEdit(base)}>Edit batch recipe</Button>
                )}
                {canMake && base.prep_yield != null && base.components.length > 0 && (
                  <Button size="sm" onClick={() => { setBatches('1'); setMaking(base); }}>Made a batch</Button>
                )}
              </div>
            </div>
          </div>
        );
      })}

      {draft && (
        <div className="space-y-3 rounded-lg border-2 border-primary/40 p-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="prep-base">This batch makes</Label>
              {baseIds.has(draft.baseId) ? (
                <p id="prep-base" className="pt-2 font-semibold">{draftBase?.name}</p>
              ) : (
                <Select value={draft.baseId} onValueChange={(v) => setDraft({ ...draft, baseId: v, yieldKey: 'base' })}>
                  <SelectTrigger id="prep-base" className="w-full" aria-label="Prep base ingredient"><SelectValue placeholder="Pick the ingredient (e.g. Hot Mayo)" /></SelectTrigger>
                  <SelectContent>
                    {sortedIngredients
                      .filter((i) => !baseIds.has(i.id) && !componentIds.has(i.id))
                      .map((i) => <SelectItem key={i.id} value={i.id}>{i.name} ({i.base_unit})</SelectItem>)}
                  </SelectContent>
                </Select>
              )}
            </div>
            <div className="space-y-1">
              <Label htmlFor="prep-yield">How much one batch makes</Label>
              <div className="flex gap-2">
                <Input
                  id="prep-yield"
                  inputMode="decimal"
                  className="w-28 placeholder:text-muted-foreground/60"
                  placeholder="e.g. 40"
                  value={draft.yieldQty}
                  onChange={(e) => setDraft({ ...draft, yieldQty: e.target.value })}
                />
                <div className="flex-1">
                  <UnitSelect
                    options={draft.baseId ? optionsFor(draft.baseId) : [{ key: 'base', name: 'unit', factor: 1 }]}
                    baseUnit={draftBase?.base_unit || ''}
                    value={draft.yieldKey}
                    onChange={(k) => setDraft({ ...draft, yieldKey: k })}
                    disabled={!draft.baseId}
                  />
                </div>
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <p className="text-sm font-medium">What goes into one batch</p>
            {draft.rows.map((row, i) => {
              const options = row.ingredient_id ? optionsFor(row.ingredient_id) : [{ key: 'base', name: 'unit', factor: 1 }];
              const ing = byId.get(row.ingredient_id);
              return (
                <div key={i} className="grid grid-cols-[6rem_minmax(0,1fr)_auto] items-center gap-2 border-b pb-2 last:border-0 sm:grid-cols-[minmax(0,1fr)_6rem_minmax(0,9rem)_auto] sm:border-0 sm:pb-0">
                  <Select value={row.ingredient_id} onValueChange={(v) => setRow(i, { ingredient_id: v, unitKey: 'base' })}>
                    <SelectTrigger className="col-span-3 w-full sm:col-span-1" aria-label={`Ingredient ${i + 1}`}><SelectValue placeholder="Ingredient" /></SelectTrigger>
                    <SelectContent>
                      {sortedIngredients
                        .filter((x) => x.id !== draft.baseId && !baseIds.has(x.id))
                        .map((x) => <SelectItem key={x.id} value={x.id}>{x.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <Input
                    inputMode="decimal"
                    aria-label={`Amount of ingredient ${i + 1}`}
                    className="placeholder:text-muted-foreground/60"
                    placeholder="e.g. 300"
                    value={row.qty}
                    onChange={(e) => setRow(i, { qty: e.target.value })}
                  />
                  <UnitSelect options={options} baseUnit={ing?.base_unit || ''} value={row.unitKey} onChange={(k) => setRow(i, { unitKey: k })} disabled={!ing} />
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`Remove ingredient ${i + 1}`}
                    onClick={() => setDraft({ ...draft, rows: draft.rows.filter((_, j) => j !== i) })}
                  >
                    <Trash2 className="h-4 w-4" aria-hidden />
                  </Button>
                </div>
              );
            })}
            <Button size="sm" variant="outline" onClick={() => setDraft({ ...draft, rows: [...draft.rows, { ingredient_id: '', qty: '', unitKey: 'base' }] })}>
              <Plus className="mr-1 h-4 w-4" aria-hidden /> Add ingredient
            </Button>
          </div>

          <div className="flex flex-wrap justify-between gap-2">
            {baseIds.has(draft.baseId) ? (
              <Button size="sm" variant="ghost" className="text-destructive" onClick={() => remove(bases.find((b) => b.ingredient_id === draft.baseId)!)}>
                Not made in batches
              </Button>
            ) : <span />}
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => setDraft(null)} disabled={saving}>Cancel</Button>
              <Button size="sm" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save batch recipe'}</Button>
            </div>
          </div>
        </div>
      )}

      {canEdit && !draft && (
        <Button variant="outline" onClick={() => startEdit(null)}>
          <Plus className="mr-1 h-4 w-4" aria-hidden /> New prep base
        </Button>
      )}

      <Dialog open={making != null} onOpenChange={(o) => !o && setMaking(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Made {making?.name}</DialogTitle>
            <DialogDescription>Takes the ingredients off stock and adds the batch to {making?.name}.</DialogDescription>
          </DialogHeader>
          {making && (
            <div className="space-y-3 text-sm">
              <div className="flex items-center gap-2">
                <Label htmlFor="batches">How many batches</Label>
                <Input id="batches" inputMode="decimal" className="w-24" value={batches} onChange={(e) => setBatches(e.target.value)} />
              </div>
              <div>
                <p className="font-medium">Takes off stock</p>
                <ul className="list-disc pl-5 text-muted-foreground">
                  {making.components.map((c) => (
                    <li key={c.ingredient_id}>{describeQty(c.qty * makingN, c.base_unit, c.unit, optionsFor(c.ingredient_id))} {c.name}</li>
                  ))}
                </ul>
              </div>
              <p>
                <span className="font-medium">Adds</span>{' '}
                {fmtQty((making.prep_yield ?? 0) * makingN)} {making.base_unit} of {making.name}
              </p>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setMaking(null)} disabled={saving}>Cancel</Button>
            <Button onClick={confirmMake} disabled={saving || makingN <= 0}>{saving ? 'Saving…' : 'Confirm'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
