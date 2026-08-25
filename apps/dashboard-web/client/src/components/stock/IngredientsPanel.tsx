import React, { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useAuth } from '@/contexts/AuthContext';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ChevronDown, Clock, HelpCircle, Loader2 } from 'lucide-react';
import {
  ApiExpiringIngredient,
  ApiIngredient,
  ApiIngredientDailySummary,
  ApiIngredientRecipeUsage,
  CostVolatilityTier,
  fetchExpiringSoon,
  fetchIngredientCountEntries,
  fetchIngredientRecipeUsage,
  fetchInventory,
  overrideIngredientField,
  updateIngredient,
} from '@/lib/api';
import { formatCurrency } from '@/lib/utils';
import { LOSS_REASONS } from '@/lib/types';
import { LossRecordForm } from '@/components/shared/LossRecordForm';
import { STOCK_TABLE_CELL_CLASS, STOCK_TABLE_HEAD_CLASS, STOCK_TABLE_ROW_CLASS } from '@/components/stock/stockTableStyle';
import { SummaryFieldCell } from '@/components/stock/SummaryFieldCell';

const COST_VOLATILITY_TIERS: { value: CostVolatilityTier; label: string }[] = [
  { value: 'low', label: 'Low' },
  { value: 'low_medium', label: 'Low-medium' },
  { value: 'medium', label: 'Medium' },
  { value: 'medium_high', label: 'Medium-high' },
  { value: 'high', label: 'High' },
];

interface IngredientsPanelProps {
  onViewStations: () => void;
  // Edit-link parity with Station Items' "Edit in Ingredient Stock →": when
  // set, scroll that row into view, flash-highlight it, and (for an
  // executive, who's the only role that can actually edit) open straight
  // into its Edit dialog -- instead of leaving the user to hunt for one
  // row in a 70+ item list. onFocusIngredientConsumed clears it in the
  // parent so switching tabs away and back doesn't keep re-triggering it.
  focusIngredientId?: string;
  onFocusIngredientConsumed?: () => void;
}

export function IngredientsPanel({ onViewStations, focusIngredientId, onFocusIngredientConsumed }: IngredientsPanelProps) {
  const { user } = useAuth();
  const [ingredients, setIngredients] = useState<ApiIngredient[]>([]);
  const [summaries, setSummaries] = useState<Record<string, ApiIngredientDailySummary>>({});
  const [loading, setLoading] = useState(true);
  const [unitCostValues, setUnitCostValues] = useState<Record<string, string>>({});
  const [savingCosts, setSavingCosts] = useState(false);
  const [howItWorksOpen, setHowItWorksOpen] = useState(true);
  const [expiringSoon, setExpiringSoon] = useState<ApiExpiringIngredient[]>([]);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const [lossIngredient, setLossIngredient] = useState<ApiIngredient | null>(null);
  const rowRefs = useRef<Record<string, HTMLTableRowElement | null>>({});

  // --- Edit ingredient (full catalog fields) ---
  const [editingIngredient, setEditingIngredient] = useState<ApiIngredient | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [editName, setEditName] = useState('');
  const [editCategory, setEditCategory] = useState('');
  const [editBaseUnit, setEditBaseUnit] = useState('');
  const [editSuggestedReorderUnit, setEditSuggestedReorderUnit] = useState('');
  const [editReorderThreshold, setEditReorderThreshold] = useState('');
  const [editCostVolatilityTier, setEditCostVolatilityTier] = useState<CostVolatilityTier | 'none'>('none');
  const [editShelfLifeNote, setEditShelfLifeNote] = useState('');
  const [editUsedInNote, setEditUsedInNote] = useState('');
  const [recipeUsage, setRecipeUsage] = useState<ApiIngredientRecipeUsage[]>([]);
  const [loadingUsage, setLoadingUsage] = useState(false);
  const [savingEdit, setSavingEdit] = useState(false);

  const loadInventory = useCallback(() => {
    setLoading(true);
    Promise.all([fetchInventory(), fetchIngredientCountEntries()])
      .then(([ingredientsData, summaryData]) => {
        setIngredients([...ingredientsData].sort((a, b) => a.name.localeCompare(b.name)));
        const byId: Record<string, ApiIngredientDailySummary> = {};
        for (const s of summaryData) byId[s.ingredient_id] = s;
        setSummaries(byId);
      })
      .catch(() => toast.error('Could not load inventory. Check your connection.'))
      .finally(() => setLoading(false));
    fetchExpiringSoon().then(setExpiringSoon).catch(() => {
      // Non-critical -- the rest of the page still works without it.
    });
  }, []);

  useEffect(() => {
    loadInventory();
  }, [loadInventory]);

  const updateUnitCost = (id: string, value: string) => {
    setUnitCostValues({ ...unitCostValues, [id]: value });
  };

  const handleSaveCosts = async () => {
    const entries = Object.entries(unitCostValues).filter(([id, v]) => {
      const ingredient = ingredients.find((i) => i.id === id);
      const current = ingredient?.unit_cost != null ? String(ingredient.unit_cost) : '';
      return v !== current;
    });
    if (entries.length === 0) {
      toast.error('Change at least one unit cost first.');
      return;
    }
    setSavingCosts(true);
    try {
      await Promise.all(
        entries.map(([id, value]) => updateIngredient(id, { unit_cost: value === '' ? null : parseFloat(value) }))
      );
      toast.success('Unit costs saved.');
      setUnitCostValues({});
      loadInventory();
    } catch (error) {
      toast.error('Could not save unit costs. Try again.');
      console.error(error);
    } finally {
      setSavingCosts(false);
    }
  };

  function openEdit(ingredient: ApiIngredient) {
    setEditingIngredient(ingredient);
    setEditName(ingredient.name);
    setEditCategory(ingredient.category || '');
    setEditBaseUnit(ingredient.base_unit);
    setEditSuggestedReorderUnit(ingredient.suggested_reorder_unit || '');
    setEditReorderThreshold(String(ingredient.reorder_threshold));
    setEditCostVolatilityTier((ingredient.cost_volatility_tier as CostVolatilityTier | null) || 'none');
    setEditShelfLifeNote(ingredient.shelf_life_note || '');
    setEditUsedInNote(ingredient.used_in_note || '');
    setRecipeUsage([]);
    setEditOpen(true);
    setLoadingUsage(true);
    fetchIngredientRecipeUsage(ingredient.id)
      .then(setRecipeUsage)
      .catch(() => {
        // Non-critical -- the edit dialog still works without the usage list.
      })
      .finally(() => setLoadingUsage(false));
  }

  // Edit-link parity: Station Items' "Edit in Ingredient Stock →" sets
  // focusIngredientId. Once that ingredient's row actually exists (list
  // loaded), scroll to it and flash-highlight it; an executive also gets
  // dropped straight into Edit, since that's the only role that can act
  // on it further. Runs once per focusIngredientId value via the "consumed"
  // callback rather than a loop guard, so re-clicking the same link later
  // (id unchanged in the DOM sense but a fresh state set) still re-fires.
  useEffect(() => {
    if (!focusIngredientId || loading) return;
    const ingredient = ingredients.find((i) => i.id === focusIngredientId);
    if (!ingredient) {
      onFocusIngredientConsumed?.();
      return;
    }
    const row = rowRefs.current[focusIngredientId];
    row?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setHighlightedId(focusIngredientId);
    const clearHighlight = setTimeout(() => setHighlightedId(null), 2500);
    if (user?.role === 'executive') {
      openEdit(ingredient);
    }
    onFocusIngredientConsumed?.();
    return () => clearTimeout(clearHighlight);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusIngredientId, loading, ingredients]);

  const unitChanged = editingIngredient != null && editBaseUnit.trim() !== editingIngredient.base_unit;

  async function handleSaveIngredient() {
    if (!editingIngredient) return;
    if (!editName.trim() || !editBaseUnit.trim()) {
      toast.error('Name and base unit are required');
      return;
    }
    const threshold = Number(editReorderThreshold);
    if (!Number.isFinite(threshold) || threshold < 0) {
      toast.error('Reorder threshold must be 0 or more');
      return;
    }
    setSavingEdit(true);
    try {
      await updateIngredient(editingIngredient.id, {
        name: editName.trim(),
        category: editCategory.trim() || null,
        base_unit: editBaseUnit.trim(),
        suggested_reorder_unit: editSuggestedReorderUnit.trim() || null,
        reorder_threshold: threshold,
        cost_volatility_tier: editCostVolatilityTier === 'none' ? null : editCostVolatilityTier,
        shelf_life_note: editShelfLifeNote.trim() || null,
        used_in_note: editUsedInNote.trim() || null,
      });
      toast.success(`${editName.trim()} saved`);
      setEditOpen(false);
      loadInventory();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to save ingredient');
    } finally {
      setSavingEdit(false);
    }
  }

  function handleOverrideSaved(summary: ApiIngredientDailySummary) {
    setSummaries((prev) => ({ ...prev, [summary.ingredient_id]: summary }));
  }

  return (
    <>
      <div className="space-y-6">
        {/* Expiring Soon */}
        <div className="grid grid-cols-1 md:grid-cols-1 gap-4">
          <Card className="border-l-4 border-l-destructive">
            <CardContent className="p-4">
              <p className="text-sm text-muted-foreground mb-1">Expiring Soon</p>
              <p className="text-3xl font-bold text-destructive">{expiringSoon.length}</p>
              {expiringSoon.length > 0 ? (
                <p className="text-xs text-muted-foreground mt-2 truncate">
                  {expiringSoon[0].ingredient_name} in {expiringSoon[0].days_until_expiry}d
                  {expiringSoon.length > 1 ? ` +${expiringSoon.length - 1} more` : ''}
                </p>
              ) : (
                <p className="text-xs text-muted-foreground mt-2">None within 7 days (advisory only)</p>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Expiring Soon detail */}
        {expiringSoon.length > 0 && (
          <Card className="border-l-4 border-l-destructive bg-error-bg">
            <CardHeader>
              <CardTitle className="text-destructive flex items-center gap-2">
                <Clock className="w-4 h-4" />
                Expiring Soon
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-muted-foreground mb-3">
                Based on each ingredient's most recent delivery date -- advisory only, not exact remaining-batch
                tracking.
              </p>
              <div className="space-y-2">
                {expiringSoon.map((item) => (
                  <div
                    key={item.ingredient_id}
                    className="flex justify-between items-center p-3 bg-card rounded-md border border-border"
                  >
                    <p className="font-semibold text-foreground">{item.ingredient_name}</p>
                    <Badge variant="destructive" className="text-xs">
                      {item.days_until_expiry <= 0 ? 'Expired' : `${item.days_until_expiry}d left`} -- {item.expiry_date}
                    </Badge>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* How It Works */}
        <Collapsible open={howItWorksOpen} onOpenChange={setHowItWorksOpen}>
          <Card className="border-l-4 border-l-accent-soft bg-accent-soft/30">
            <CollapsibleTrigger asChild>
              <button className="w-full text-left" type="button">
                <CardHeader className="flex flex-row items-center justify-between space-y-0 py-4">
                  <div className="flex items-center gap-2">
                    <HelpCircle className="w-4 h-4 text-muted-foreground" />
                    <CardTitle className="text-base">How Ingredient Stock Works</CardTitle>
                  </div>
                  <ChevronDown
                    className={`w-4 h-4 text-muted-foreground transition-transform ${howItWorksOpen ? 'rotate-180' : ''}`}
                  />
                </CardHeader>
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <CardContent className="pt-0 space-y-2 text-sm">
                <p>
                  <span className="font-semibold text-foreground">New Stocks, Beginning, Usage and Ending are
                  auto-filled</span> from real sales (every recipe-based deduction), deliveries and logged losses --
                  the same automation Station Items uses. This is already a done list, not a form to fill in.
                </p>
                <p>
                  <span className="font-semibold text-foreground">Only flag a field if it looks wrong.</span> Click
                  the flag icon next to a number, enter what it should actually be and why -- that writes a real,
                  audited correction (visible on Variance Log) instead of silently overwriting the computed value.
                </p>
                <p>
                  <span className="font-semibold text-foreground">Found a real shortage during a physical check?</span>{' '}
                  Use "Log Loss" on that row so the cost is tracked, same as before.
                </p>
              </CardContent>
            </CollapsibleContent>
          </Card>
        </Collapsible>

        {/* Ingredient Stock Table */}
        <Card className="border-l-4 border-l-primary">
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <div>
              <CardTitle>Ingredient Stock -- today's count</CardTitle>
              <p className="text-xs text-muted-foreground mt-0.5">
                Auto-filled from sales, losses and deliveries. Already a done list -- flag a field only if it looks
                wrong.{' '}
                <button type="button" className="text-primary underline underline-offset-2" onClick={onViewStations}>
                  View Station Items &rarr;
                </button>
              </p>
            </div>
            {user?.role === 'executive' && (
              <Button
                size="sm"
                variant="outline"
                onClick={handleSaveCosts}
                disabled={savingCosts || Object.keys(unitCostValues).length === 0}
              >
                {savingCosts ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                Save Unit Costs
              </Button>
            )}
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="flex items-center justify-center py-8 text-muted-foreground">
                <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                Loading inventory...
              </div>
            ) : ingredients.length === 0 ? (
              <p className="text-center text-muted-foreground py-8">No ingredients set up yet.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className={STOCK_TABLE_ROW_CLASS}>
                    <TableHead className={STOCK_TABLE_HEAD_CLASS}>Item</TableHead>
                    <TableHead className={STOCK_TABLE_HEAD_CLASS}>Category</TableHead>
                    <TableHead className={`${STOCK_TABLE_HEAD_CLASS} text-right`}>Unit Cost</TableHead>
                    <TableHead className={`${STOCK_TABLE_HEAD_CLASS} text-right`}>New Stocks</TableHead>
                    <TableHead className={`${STOCK_TABLE_HEAD_CLASS} text-right`}>Beginning</TableHead>
                    <TableHead className={`${STOCK_TABLE_HEAD_CLASS} text-right`}>Usage</TableHead>
                    <TableHead className={`${STOCK_TABLE_HEAD_CLASS} text-right`}>Ending</TableHead>
                    <TableHead className={STOCK_TABLE_HEAD_CLASS} />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {ingredients.map((ingredient) => {
                    const summary = summaries[ingredient.id];
                    return (
                      <TableRow
                        key={ingredient.id}
                        ref={(el) => {
                          rowRefs.current[ingredient.id] = el;
                        }}
                        className={`${STOCK_TABLE_ROW_CLASS} ${
                          highlightedId === ingredient.id ? 'bg-accent-soft/60 transition-colors duration-1000' : ''
                        }`}
                      >
                        <TableCell className={`${STOCK_TABLE_CELL_CLASS} font-medium`}>
                          {ingredient.name}
                          <p className="text-xs text-muted-foreground">{ingredient.base_unit}</p>
                        </TableCell>
                        <TableCell className={`${STOCK_TABLE_CELL_CLASS} text-muted-foreground`}>{ingredient.category || '--'}</TableCell>
                        <TableCell className={`${STOCK_TABLE_CELL_CLASS} text-right`}>
                          {user?.role === 'executive' ? (
                            <Input
                              type="number"
                              placeholder="--"
                              value={unitCostValues[ingredient.id] ?? (ingredient.unit_cost != null ? String(ingredient.unit_cost) : '')}
                              onChange={(e) => updateUnitCost(ingredient.id, e.target.value)}
                              className="w-24 text-right text-sm ml-auto"
                            />
                          ) : ingredient.unit_cost != null ? (
                            formatCurrency(ingredient.unit_cost)
                          ) : (
                            <span className="text-muted-foreground">--</span>
                          )}
                        </TableCell>
                        <SummaryFieldCell
                          field="new_stocks"
                          itemName={ingredient.name}
                          summary={summary}
                          employeeId={user?.id}
                          onOverride={(field, correctedValue, reason, employeeId) =>
                            overrideIngredientField(ingredient.id, { field, corrected_value: correctedValue, reason, employee_id: employeeId })
                          }
                          onSaved={handleOverrideSaved}
                        />
                        <SummaryFieldCell
                          field="beginning"
                          itemName={ingredient.name}
                          summary={summary}
                          employeeId={user?.id}
                          onOverride={(field, correctedValue, reason, employeeId) =>
                            overrideIngredientField(ingredient.id, { field, corrected_value: correctedValue, reason, employee_id: employeeId })
                          }
                          onSaved={handleOverrideSaved}
                          extra={
                            summary && !summary.overrides.beginning ? (
                              <p className="text-[10px] text-muted-foreground">
                                {summary.beginning_source === 'carry_forward' ? "from yesterday's ending" : 'no prior count'}
                              </p>
                            ) : null
                          }
                        />
                        <SummaryFieldCell
                          field="usage"
                          itemName={ingredient.name}
                          summary={summary}
                          employeeId={user?.id}
                          onOverride={(field, correctedValue, reason, employeeId) =>
                            overrideIngredientField(ingredient.id, { field, corrected_value: correctedValue, reason, employee_id: employeeId })
                          }
                          onSaved={handleOverrideSaved}
                        />
                        <SummaryFieldCell
                          field="ending"
                          itemName={ingredient.name}
                          summary={summary}
                          employeeId={user?.id}
                          onOverride={(field, correctedValue, reason, employeeId) =>
                            overrideIngredientField(ingredient.id, { field, corrected_value: correctedValue, reason, employee_id: employeeId })
                          }
                          onSaved={handleOverrideSaved}
                        />
                        <TableCell className={`${STOCK_TABLE_CELL_CLASS} space-x-2 whitespace-nowrap`}>
                          <Button size="sm" variant="ghost" onClick={() => setLossIngredient(ingredient)}>
                            Log Loss
                          </Button>
                          {user?.role === 'executive' && (
                            <Button size="sm" variant="outline" onClick={() => openEdit(ingredient)}>
                              Edit
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Log Loss */}
      <Dialog open={!!lossIngredient} onOpenChange={(open) => !open && setLossIngredient(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Log Loss -- {lossIngredient?.name}</DialogTitle>
          </DialogHeader>
          {lossIngredient && user?.id && (
            <LossRecordForm
              employeeId={user.id}
              fixedIngredientId={lossIngredient.id}
              fixedIngredientLabel={lossIngredient.name}
              reasonOptions={LOSS_REASONS}
              defaultReason="spoilage"
              skipStockDeduction={false}
              submitLabel="Log Loss"
              successToast={() => `Loss logged for ${lossIngredient.name}`}
              onSuccess={() => {
                setLossIngredient(null);
                loadInventory();
              }}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* Edit ingredient (full catalog fields) */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit {editingIngredient?.name}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>Name</Label>
                <Input value={editName} onChange={(e) => setEditName(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label>Category</Label>
                <Input value={editCategory} onChange={(e) => setEditCategory(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label>Base unit</Label>
                <Input
                  value={editBaseUnit}
                  onChange={(e) => setEditBaseUnit(e.target.value)}
                  placeholder="e.g. g, ml, pcs, pack"
                />
              </div>
              <div className="space-y-1">
                <Label>Suggested reorder unit</Label>
                <Input
                  value={editSuggestedReorderUnit}
                  onChange={(e) => setEditSuggestedReorderUnit(e.target.value)}
                  placeholder="e.g. kg sack, case of 24"
                />
              </div>
              <div className="space-y-1">
                <Label>Reorder threshold ({editBaseUnit || 'unit'})</Label>
                <Input
                  type="number"
                  min={0}
                  value={editReorderThreshold}
                  onChange={(e) => setEditReorderThreshold(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label>Cost volatility</Label>
                <Select
                  value={editCostVolatilityTier}
                  onValueChange={(v) => setEditCostVolatilityTier(v as CostVolatilityTier | 'none')}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Not set</SelectItem>
                    {COST_VOLATILITY_TIERS.map((t) => (
                      <SelectItem key={t.value} value={t.value}>
                        {t.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1">
              <Label>Shelf life note</Label>
              <Input value={editShelfLifeNote} onChange={(e) => setEditShelfLifeNote(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>Used in (note)</Label>
              <Input value={editUsedInNote} onChange={(e) => setEditUsedInNote(e.target.value)} />
            </div>

            {unitChanged && editingIngredient && (
              <div className="rounded-md border border-amber-400 bg-amber-50 p-3 space-y-2">
                <p className="text-sm font-medium text-amber-900">
                  Changing the unit from "{editingIngredient.base_unit}" to "{editBaseUnit.trim()}" does not convert
                  any existing numbers -- current stock ({editingIngredient.current_stock}{' '}
                  {editingIngredient.base_unit}) and reorder threshold ({editingIngredient.reorder_threshold}{' '}
                  {editingIngredient.base_unit}) will keep their old values, now mislabeled. You'll need to update
                  those, and every recipe below, to the new unit's scale yourself.
                </p>
                {loadingUsage ? (
                  <p className="text-xs text-amber-900">Checking recipe usage...</p>
                ) : recipeUsage.length > 0 ? (
                  <div className="text-xs text-amber-900 space-y-1">
                    <p className="font-medium">Used in {recipeUsage.length} recipe line(s):</p>
                    <ul className="list-disc list-inside">
                      {recipeUsage.map((u, i) => (
                        <li key={i}>
                          {u.product_name} ({u.size_label}) -- {u.qty_per_serving} {u.unit}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <p className="text-xs text-amber-900">Not currently used in any recipe.</p>
                )}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button disabled={savingEdit} onClick={handleSaveIngredient}>
              {savingEdit ? 'Saving...' : 'Save changes'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
