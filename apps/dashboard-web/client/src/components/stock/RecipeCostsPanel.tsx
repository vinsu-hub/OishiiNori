import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation } from 'wouter';
import { toast } from 'sonner';
import { CheckCircle2, Download, Loader2, RefreshCw, Search } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  type ApiItemUnit,
  type RecipeCoverageIngredient,
  type RecipeCoverageProduct,
  fetchItemUnits,
  fetchRecipeCoverage,
  updateIngredient,
} from '@/lib/api';
import { fmtQty, unitOptionsFor, unitsForItem } from '@/lib/units';
import { formatCurrency } from '@/lib/utils';
import { StockStatTile } from '@/components/stock/StockStatTile';

type Section = 'costs' | 'recipes' | 'food-cost';

interface CostDraft {
  price: string;
  qty: string;
  unitKey: string;
}

/** A menu size counts as set up when sales deduct something for it: a recipe,
 * or a per-item stock rule (e.g. a bottled drink). */
function needsRecipe(size: RecipeCoverageProduct['sizes'][number]) {
  return size.recipe_lines === 0 && size.consumption_rules === 0;
}

function perUnitCost(draft: CostDraft | undefined, factor: number): number | null {
  if (!draft) return null;
  const price = Number(draft.price);
  const qty = Number(draft.qty || '1');
  if (!draft.price.trim() || !Number.isFinite(price) || price < 0 || !Number.isFinite(qty) || qty <= 0) return null;
  return price / (qty * factor);
}

function fmtUnitCost(value: number): string {
  // Costs per gram/ml are often centavos: keep 4 decimals there.
  return value < 1 ? `₱${value.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}` : formatCurrency(value);
}

function csvCell(value: string | number) {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Stock -> Recipes & Costs: the owner's checklist of unit costs and recipes
 * still to fill in, plus each menu item's food cost once they are. */
export function RecipeCostsPanel() {
  const { user } = useAuth();
  const canEditCosts = user?.role === 'executive';
  const [, navigate] = useLocation();
  const [section, setSection] = useState<Section>('costs');
  const [products, setProducts] = useState<RecipeCoverageProduct[]>([]);
  const [ingredients, setIngredients] = useState<RecipeCoverageIngredient[]>([]);
  const [itemUnits, setItemUnits] = useState<ApiItemUnit[]>([]);
  const [loading, setLoading] = useState(true);
  const [drafts, setDrafts] = useState<Record<string, CostDraft>>({});
  const [savingId, setSavingId] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [search, setSearch] = useState('');

  // Loaded when opened and on Refresh -- no polling.
  const load = useCallback(() => {
    setLoading(true);
    Promise.all([fetchRecipeCoverage(), fetchItemUnits().catch(() => [] as ApiItemUnit[])])
      .then(([coverage, units]) => {
        setProducts(coverage.products);
        setIngredients(coverage.ingredients);
        setItemUnits(units);
      })
      .catch((e) => toast.error(`Could not load recipes & costs: ${e instanceof Error ? e.message : e}`))
      .finally(() => setLoading(false));
  }, []);
  useEffect(load, [load]);

  const query = search.trim().toLowerCase();
  const matches = (...values: (string | null | undefined)[]) => !query || values.some((v) => (v || '').toLowerCase().includes(query));

  const missingCost = ingredients.filter((i) => i.used_in > 0 && i.unit_cost == null);
  const recipeProducts = products.filter((p) => !p.is_bundle && p.sizes.some(needsRecipe));
  const bundles = products.filter((p) => p.is_bundle);
  const costedSizes = products.flatMap((p) => p.sizes.filter((s) => s.recipe_lines > 0).map((s) => ({ product: p, size: s })));
  const fullyCosted = costedSizes.filter(({ size }) => size.missing_cost.length === 0);

  const costGroups = useMemo(() => {
    const rows = ingredients
      .filter((i) => (showAll ? true : i.used_in > 0 && i.unit_cost == null))
      .filter((i) => matches(i.name, i.category))
      .sort((a, b) => b.used_in - a.used_in || a.name.localeCompare(b.name));
    const groups = new Map<string, RecipeCoverageIngredient[]>();
    for (const row of rows) {
      const key = row.category || 'Uncategorized';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(row);
    }
    return Array.from(groups).sort((a, b) => a[0].localeCompare(b[0]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ingredients, showAll, query]);

  const recipeGroups = useMemo(() => {
    const groups = new Map<string, RecipeCoverageProduct[]>();
    for (const p of recipeProducts.filter((p) => matches(p.name, p.category))) {
      if (!groups.has(p.category)) groups.set(p.category, []);
      groups.get(p.category)!.push(p);
    }
    return Array.from(groups);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [products, query]);

  function draftFor(ingredient: RecipeCoverageIngredient): CostDraft {
    return drafts[ingredient.id] ?? { price: '', qty: '1', unitKey: 'base' };
  }

  function updateDraft(id: string, patch: Partial<CostDraft>, ingredient: RecipeCoverageIngredient) {
    setDrafts((prev) => ({ ...prev, [id]: { ...draftFor(ingredient), ...prev[id], ...patch } }));
  }

  async function saveCost(ingredient: RecipeCoverageIngredient, value: number) {
    setSavingId(ingredient.id);
    try {
      await updateIngredient(ingredient.id, { unit_cost: Math.round(value * 10000) / 10000 });
      toast.success(`${ingredient.name}: ${fmtUnitCost(value)} per ${ingredient.base_unit}`);
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[ingredient.id];
        return next;
      });
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save the unit cost');
    } finally {
      setSavingId(null);
    }
  }

  function downloadChecklist() {
    const lines: (string | number)[][] = [['List', 'Category', 'Name', 'Unit / sizes', 'Used in']];
    for (const i of [...missingCost].sort((a, b) => b.used_in - a.used_in)) {
      lines.push(['Unit cost missing', i.category || '', i.name, `per ${i.base_unit}`, `${i.used_in} menu item(s): ${i.used_in_examples.join('; ')}`]);
    }
    for (const p of recipeProducts) {
      lines.push(['Recipe missing', p.category, p.name, p.sizes.filter(needsRecipe).map((s) => s.size_label).join('; '), '']);
    }
    const blob = new Blob([lines.map((l) => l.map(csvCell).join(',')).join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'recipes-and-costs-checklist.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StockStatTile
          label="Ingredients with no unit cost"
          value={loading ? '…' : missingCost.length}
          hint="Used in a recipe but no price yet"
          accent={missingCost.length ? 'warning' : 'success'}
          onClick={() => { setSection('costs'); setShowAll(false); }}
        />
        <StockStatTile
          label="Menu items with no recipe"
          value={loading ? '…' : recipeProducts.length}
          hint="Sales of these don't deduct stock yet"
          accent={recipeProducts.length ? 'destructive' : 'success'}
          onClick={() => setSection('recipes')}
        />
        <StockStatTile
          label="Recipes fully costed"
          value={loading ? '…' : `${fullyCosted.length} / ${costedSizes.length}`}
          hint="Every ingredient has a unit cost"
          accent="primary"
          onClick={() => setSection('food-cost')}
        />
      </div>

      <Card>
        <CardHeader className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle>Recipes &amp; Costs</CardTitle>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={downloadChecklist} disabled={loading}>
                <Download className="mr-2 h-4 w-4" aria-hidden /> Download checklist
              </Button>
              <Button variant="outline" size="sm" onClick={load} disabled={loading}>
                <RefreshCw className={`mr-2 h-4 w-4 ${loading ? 'animate-spin' : ''}`} aria-hidden /> Refresh
              </Button>
            </div>
          </div>
          <Tabs value={section} onValueChange={(v) => setSection(v as Section)}>
            <TabsList className="h-auto flex-wrap">
              <TabsTrigger value="costs">1 · Unit costs ({missingCost.length})</TabsTrigger>
              <TabsTrigger value="recipes">2 · Recipes to add ({recipeProducts.length})</TabsTrigger>
              <TabsTrigger value="food-cost">3 · Food cost per item</TabsTrigger>
            </TabsList>
          </Tabs>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-56 flex-1 max-w-sm">
              <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" aria-hidden />
              <Input className="pl-9" placeholder="Search" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search recipes and costs" />
            </div>
            {section === 'costs' && (
              <Select value={showAll ? 'all' : 'missing'} onValueChange={(v) => setShowAll(v === 'all')}>
                <SelectTrigger className="w-64" aria-label="Which ingredients">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="missing">Missing a cost (used in recipes)</SelectItem>
                  <SelectItem value="all">All ingredients</SelectItem>
                </SelectContent>
              </Select>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {loading && <p className="text-sm text-muted-foreground">Loading…</p>}

          {!loading && section === 'costs' && (
            <div className="space-y-5">
              <p className="text-sm text-muted-foreground">
                Type what you paid and how much you got, e.g. <span className="font-medium text-foreground">₱450 for 1 kg</span> or{' '}
                <span className="font-medium text-foreground">₱120 for 1 pack</span>. The cost per unit is worked out for you.
                Most-used ingredients are listed first.
                {!canEditCosts && ' Only the owner (executive) can save costs.'}
              </p>
              {costGroups.length === 0 && (
                <p className="flex items-center gap-2 rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
                  <CheckCircle2 className="h-5 w-5 text-success" aria-hidden /> Every ingredient used in a recipe has a unit cost.
                </p>
              )}
              {costGroups.map(([category, rows]) => (
                <div key={category} className="space-y-2">
                  <h3 className="text-xs font-bold uppercase tracking-wide text-muted-foreground">{category} · {rows.length}</h3>
                  <div className="divide-y rounded-lg border">
                    {rows.map((ingredient) => {
                      const options = unitOptionsFor(ingredient.base_unit, unitsForItem(itemUnits, 'ingredient', ingredient.id));
                      const draft = draftFor(ingredient);
                      const option = options.find((o) => o.key === draft.unitKey) ?? options[0];
                      const computed = perUnitCost(drafts[ingredient.id], option.factor);
                      return (
                        <div key={ingredient.id} className="grid gap-2 p-3 md:grid-cols-[minmax(0,1.3fr)_minmax(0,2fr)] md:items-center">
                          <div className="min-w-0">
                            <p className="font-medium">{ingredient.name}</p>
                            <p className="text-xs text-muted-foreground" title={ingredient.used_in_examples.join(', ')}>
                              {ingredient.used_in > 0
                                ? `Used in ${ingredient.used_in} menu item${ingredient.used_in === 1 ? '' : 's'} · ${ingredient.used_in_examples.slice(0, 2).join(', ')}${ingredient.used_in > 2 ? '…' : ''}`
                                : 'Not in any recipe yet'}
                            </p>
                            <p className="text-xs">
                              Now:{' '}
                              {ingredient.unit_cost != null ? (
                                <span className="font-medium">{fmtUnitCost(ingredient.unit_cost)} per {ingredient.base_unit}</span>
                              ) : (
                                <Badge variant="outline" className="border-amber-400 text-amber-800">No cost yet</Badge>
                              )}
                            </p>
                          </div>
                          {canEditCosts ? (
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-sm text-muted-foreground">Paid ₱</span>
                              <Input
                                className="w-24"
                                inputMode="decimal"
                                type="number"
                                min={0}
                                step="0.01"
                                value={draft.price}
                                onChange={(e) => updateDraft(ingredient.id, { price: e.target.value }, ingredient)}
                                aria-label={`Price paid for ${ingredient.name}`}
                              />
                              <span className="text-sm text-muted-foreground">for</span>
                              <Input
                                className="w-20"
                                inputMode="decimal"
                                type="number"
                                min={0}
                                step="any"
                                value={draft.qty}
                                onChange={(e) => updateDraft(ingredient.id, { qty: e.target.value }, ingredient)}
                                aria-label={`Quantity bought of ${ingredient.name}`}
                              />
                              <Select value={option.key} onValueChange={(v) => updateDraft(ingredient.id, { unitKey: v }, ingredient)}>
                                <SelectTrigger className="w-36" aria-label="Unit bought">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  {options.map((o) => (
                                    <SelectItem key={o.key} value={o.key}>
                                      {o.key === 'base' ? o.name : `${o.name} (${fmtQty(o.factor)} ${ingredient.base_unit})`}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                              <Button
                                size="sm"
                                disabled={computed == null || savingId === ingredient.id}
                                onClick={() => computed != null && saveCost(ingredient, computed)}
                              >
                                {savingId === ingredient.id ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : 'Save'}
                              </Button>
                              {computed != null && (
                                <span className="text-sm font-medium text-primary">= {fmtUnitCost(computed)} per {ingredient.base_unit}</span>
                              )}
                            </div>
                          ) : (
                            <p className="text-sm text-muted-foreground">Ask the owner to add this cost.</p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}

          {!loading && section === 'recipes' && (
            <div className="space-y-5">
              <p className="text-sm text-muted-foreground">
                These menu items don't have a recipe yet, so selling them doesn't take anything off stock and their food cost
                is unknown. Tap <span className="font-medium text-foreground">Add recipe</span> to list each ingredient and how much one serving uses.
              </p>
              {recipeGroups.length === 0 && (
                <p className="flex items-center gap-2 rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
                  <CheckCircle2 className="h-5 w-5 text-success" aria-hidden /> Every menu item has a recipe.
                </p>
              )}
              {recipeGroups.map(([category, rows]) => (
                <div key={category} className="space-y-2">
                  <h3 className="text-xs font-bold uppercase tracking-wide text-muted-foreground">{category} · {rows.length}</h3>
                  <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                    {rows.map((product) => {
                      const missing = product.sizes.filter(needsRecipe);
                      return (
                        <div key={product.id} className="flex items-start justify-between gap-3 rounded-lg border p-3">
                          <div className="min-w-0">
                            <p className="font-medium">{product.name}</p>
                            <div className="mt-1 flex flex-wrap gap-1">
                              {missing.map((s) => (
                                <Badge key={s.id} variant="outline">{s.size_label}</Badge>
                              ))}
                            </div>
                            {missing.length < product.sizes.length && (
                              <p className="mt-1 text-xs text-muted-foreground">Other sizes already have a recipe.</p>
                            )}
                          </div>
                          <Button size="sm" variant="outline" onClick={() => navigate(`/menu-editing?edit=${product.id}`)}>
                            Add recipe
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
              {bundles.length > 0 && (
                <p className="rounded-md bg-muted/50 p-3 text-xs text-muted-foreground">
                  Not listed: {bundles.length} platters &amp; sushi boats ({bundles.slice(0, 3).map((b) => b.name).join(', ')}…). They
                  take stock from the flavours the kitchen picks for each order, so they don't need their own recipe.
                </p>
              )}
            </div>
          )}

          {!loading && section === 'food-cost' && (
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">
                Cost of the ingredients in one serving vs the menu price. Items marked <span className="font-medium text-amber-800">incomplete</span>{' '}
                have ingredients with no unit cost, so their real cost is higher than shown.
              </p>
              <div className="overflow-x-auto rounded-lg border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/60 text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2">Menu item</th>
                      <th className="px-3 py-2 text-right">Price</th>
                      <th className="px-3 py-2 text-right">Cost</th>
                      <th className="px-3 py-2 text-right">Food cost</th>
                      <th className="px-3 py-2">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {costedSizes.filter(({ product }) => matches(product.name, product.category)).map(({ product, size }) => {
                      const pct = size.cost != null && size.price > 0 ? (size.cost / size.price) * 100 : null;
                      const complete = size.missing_cost.length === 0;
                      return (
                        <tr key={size.id}>
                          <td className="px-3 py-2">
                            <p className="font-medium">{product.name}</p>
                            <p className="text-xs text-muted-foreground">{size.size_label} · {product.category}</p>
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">{formatCurrency(size.price)}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{size.cost != null ? formatCurrency(size.cost) : '—'}</td>
                          <td className={`px-3 py-2 text-right tabular-nums ${complete && pct != null && pct > 40 ? 'font-semibold text-destructive' : ''}`}>
                            {pct != null && size.cost ? `${pct.toFixed(0)}%` : '—'}
                          </td>
                          <td className="px-3 py-2">
                            {complete ? (
                              <Badge variant="secondary">Complete</Badge>
                            ) : (
                              <span className="text-xs text-amber-800">
                                Incomplete · no cost for {size.missing_cost.slice(0, 3).join(', ')}
                                {size.missing_cost.length > 3 ? ` +${size.missing_cost.length - 3} more` : ''}
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
