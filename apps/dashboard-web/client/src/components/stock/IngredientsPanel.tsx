import React, { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useAuth } from '@/contexts/AuthContext';
import { useDraftPersistence } from '@/hooks/useDraftPersistence';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  CheckCircle,
  ChevronDown,
  ChevronUp,
  ChevronsUpDown,
  Clock,
  HelpCircle,
  Loader2,
  Package,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';
import {
  ApiExpiringIngredient,
  ApiIngredient,
  ApiIngredientRecipeUsage,
  CostVolatilityTier,
  LossReason,
  countStock,
  fetchExpiringSoon,
  fetchIngredientRecipeUsage,
  fetchInventory,
  updateIngredient,
} from '@/lib/api';
import { formatCurrency } from '@/lib/utils';
import { LossRecordForm } from '@/components/shared/LossRecordForm';

const COST_VOLATILITY_TIERS: { value: CostVolatilityTier; label: string }[] = [
  { value: 'low', label: 'Low' },
  { value: 'low_medium', label: 'Low-medium' },
  { value: 'medium', label: 'Medium' },
  { value: 'medium_high', label: 'Medium-high' },
  { value: 'high', label: 'High' },
];

type ItemStatus = 'pending' | 'counted' | 'overage' | 'shortage';
type SortKey = 'name' | 'category' | 'unit_cost' | 'expected' | 'variance' | 'status';
type SortDir = 'asc' | 'desc';

const STATUS_RANK: Record<ItemStatus, number> = { pending: 0, counted: 1, overage: 2, shortage: 3 };

const SHRINKAGE_REASONS: { value: LossReason; label: string }[] = [
  { value: 'shrinkage', label: 'Shrinkage (unexplained)' },
  { value: 'spoilage', label: 'Spoilage' },
  { value: 'breakage', label: 'Breakage' },
  { value: 'prep_error', label: 'Prep Error' },
  { value: 'comp', label: 'Complimentary' },
];

interface ShrinkageItem {
  ingredientId: string;
  ingredientName: string;
  unit: string;
  quantity: number;
  logged: boolean;
}

function computeStatus(expected: number, counted: number | null): ItemStatus {
  if (counted === null) return 'pending';
  const variancePercent = expected === 0 ? 0 : ((counted - expected) / expected) * 100;
  if (Math.abs(variancePercent) <= 5) return 'counted';
  return variancePercent > 0 ? 'overage' : 'shortage';
}

interface IngredientsPanelProps {
  onViewStations: () => void;
}

export function IngredientsPanel({ onViewStations }: IngredientsPanelProps) {
  const { user } = useAuth();
  const [ingredients, setIngredients] = useState<ApiIngredient[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [countedValues, setCountedValues] = useState<Record<string, string>>({});
  const { clearDraft: clearCountDraft } = useDraftPersistence(
    'oishii-draft-inventory-count',
    countedValues,
    (restored) => {
      setCountedValues((prev) => {
        const ingredientIds = new Set(ingredients.map((i) => i.id));
        const merged = { ...prev };
        for (const [id, v] of Object.entries(restored)) {
          if (ingredientIds.size === 0 || ingredientIds.has(id)) merged[id] = v;
        }
        return merged;
      });
    }
  );
  const [unitCostValues, setUnitCostValues] = useState<Record<string, string>>({});
  const [savingCosts, setSavingCosts] = useState(false);
  const [shrinkageDialogOpen, setShrinkageDialogOpen] = useState(false);
  const [shrinkageItems, setShrinkageItems] = useState<ShrinkageItem[]>([]);
  const [howItWorksOpen, setHowItWorksOpen] = useState(true);
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [expiringSoon, setExpiringSoon] = useState<ApiExpiringIngredient[]>([]);

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

  function handleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  }

  function SortIcon({ column }: { column: SortKey }) {
    if (column !== sortKey) return <ChevronsUpDown className="w-3.5 h-3.5 text-muted-foreground/40" />;
    return sortDir === 'asc' ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />;
  }

  const loadInventory = useCallback(() => {
    setLoading(true);
    fetchInventory()
      .then((data) => setIngredients([...data].sort((a, b) => a.name.localeCompare(b.name))))
      .catch(() => toast.error('Could not load inventory. Check your connection.'))
      .finally(() => setLoading(false));
    fetchExpiringSoon().then(setExpiringSoon).catch(() => {
      // Non-critical -- the rest of the page still works without it.
    });
  }, []);

  useEffect(() => {
    loadInventory();
  }, [loadInventory]);

  const updateCount = (id: string, value: string) => {
    setCountedValues({ ...countedValues, [id]: value });
  };

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

  const handleSubmit = async () => {
    const entries = Object.entries(countedValues).filter(([, v]) => v !== '' && !isNaN(parseFloat(v)));
    if (entries.length === 0) {
      toast.error('Enter a counted value for at least one item first.');
      return;
    }
    if (!user?.id) {
      toast.error('No user account found');
      return;
    }

    setSubmitting(true);
    try {
      const results = await Promise.all(
        entries.map(([id, value]) =>
          countStock(id, { employee_id: user.id, counted_stock: parseFloat(value) })
        )
      );
      toast.success('Inventory count saved. Stock levels updated.');

      const shortages = results
        .filter((r) => r.variance < 0)
        .map(
          (r): ShrinkageItem => ({
            ingredientId: r.ingredient.id,
            ingredientName: r.ingredient.name,
            unit: r.ingredient.base_unit,
            quantity: Math.abs(r.variance),
            logged: false,
          })
        );

      setCountedValues({});
      clearCountDraft();
      loadInventory();

      if (shortages.length > 0) {
        setShrinkageItems(shortages);
        setShrinkageDialogOpen(true);
      }
    } catch (error) {
      toast.error('Could not save the count. Try again.');
      console.error(error);
    } finally {
      setSubmitting(false);
    }
  };

  const markShrinkageLogged = (ingredientId: string) => {
    setShrinkageItems((prev) =>
      prev.map((i) => (i.ingredientId === ingredientId ? { ...i, logged: true } : i))
    );
  };

  const getStatusIcon = (status: ItemStatus) => {
    switch (status) {
      case 'counted':
        return <CheckCircle className="w-4 h-4 text-success" />;
      case 'overage':
        return <TrendingUp className="w-4 h-4 text-warning" />;
      case 'shortage':
        return <TrendingDown className="w-4 h-4 text-destructive" />;
      default:
        return <Package className="w-4 h-4 text-muted-foreground" />;
    }
  };

  const getStatusLabel = (status: ItemStatus) => {
    switch (status) {
      case 'overage':
        return 'Overage';
      case 'shortage':
        return 'Shortage';
      default:
        return null;
    }
  };

  const getVarianceColor = (variancePercent: number | null) => {
    if (variancePercent === null) return 'text-muted-foreground';
    if (Math.abs(variancePercent) <= 5) return 'text-success';
    return variancePercent > 0 ? 'text-warning' : 'text-destructive';
  };

  const rows = ingredients.map((ingredient) => {
    const raw = countedValues[ingredient.id];
    const counted = raw !== undefined && raw !== '' && !isNaN(parseFloat(raw)) ? parseFloat(raw) : null;
    const variance = counted !== null ? counted - ingredient.current_stock : null;
    const variancePercent =
      counted !== null && ingredient.current_stock !== 0
        ? (variance! / ingredient.current_stock) * 100
        : counted !== null
          ? 0
          : null;
    const status = computeStatus(ingredient.current_stock, counted);
    return { ingredient, counted, variance, variancePercent, status };
  });

  const countedItems = rows.filter((r) => r.counted !== null).length;
  const varianceItems = rows.filter((r) => r.status === 'overage' || r.status === 'shortage').length;

  function compareRows(a: (typeof rows)[number], b: (typeof rows)[number]): number {
    switch (sortKey) {
      case 'name':
        return sortDir === 'asc'
          ? a.ingredient.name.localeCompare(b.ingredient.name)
          : b.ingredient.name.localeCompare(a.ingredient.name);
      case 'category': {
        const ac = a.ingredient.category;
        const bc = b.ingredient.category;
        if (ac === null && bc === null) return 0;
        if (ac === null) return 1; // uncategorized always sorts last
        if (bc === null) return -1;
        return sortDir === 'asc' ? ac.localeCompare(bc) : bc.localeCompare(ac);
      }
      case 'unit_cost': {
        const ac = a.ingredient.unit_cost;
        const bc = b.ingredient.unit_cost;
        if (ac === null && bc === null) return 0;
        if (ac === null) return 1; // uncosted always sorts last
        if (bc === null) return -1;
        return sortDir === 'asc' ? ac - bc : bc - ac;
      }
      case 'expected':
        return sortDir === 'asc'
          ? a.ingredient.current_stock - b.ingredient.current_stock
          : b.ingredient.current_stock - a.ingredient.current_stock;
      case 'variance': {
        if (a.variance === null && b.variance === null) return 0;
        if (a.variance === null) return 1; // not-yet-counted always sorts last
        if (b.variance === null) return -1;
        return sortDir === 'asc' ? a.variance - b.variance : b.variance - a.variance;
      }
      case 'status':
        return sortDir === 'asc'
          ? STATUS_RANK[a.status] - STATUS_RANK[b.status]
          : STATUS_RANK[b.status] - STATUS_RANK[a.status];
      default:
        return 0;
    }
  }

  const sortedRows = [...rows].sort(compareRows);

  return (
    <>
      <div className="space-y-6">
        {/* Progress Summary */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card className="border-l-4 border-l-success">
            <CardContent className="p-4">
              <p className="text-sm text-muted-foreground mb-1">Items Counted</p>
              <p className="text-3xl font-bold text-foreground">
                {countedItems}/{ingredients.length}
              </p>
              <div className="w-full bg-secondary rounded-full h-2 mt-3">
                <div
                  className="bg-success h-2 rounded-full transition-all"
                  style={{
                    width: `${ingredients.length ? (countedItems / ingredients.length) * 100 : 0}%`,
                  }}
                />
              </div>
            </CardContent>
          </Card>

          <Card className="border-l-4 border-l-warning">
            <CardContent className="p-4">
              <p className="text-sm text-muted-foreground mb-1">Variance Detected</p>
              <p className="text-3xl font-bold text-warning">{varianceItems}</p>
              <p className="text-xs text-muted-foreground mt-2">Items with &gt;5% difference</p>
            </CardContent>
          </Card>

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
                    <CardTitle className="text-base">How Stock Counting Works</CardTitle>
                  </div>
                  <ChevronDown
                    className={`w-4 h-4 text-muted-foreground transition-transform ${howItWorksOpen ? 'rotate-180' : ''}`}
                  />
                </CardHeader>
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <CardContent className="pt-0 space-y-4 text-sm">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="flex gap-2">
                    <span className="font-semibold text-muted-foreground">1.</span>
                    <p>
                      <span className="font-semibold text-foreground">Expected</span> is what the system currently
                      thinks you have on the shelf. <span className="font-semibold text-foreground">Counted</span>{' '}
                      is what you physically count and type in.
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <span className="font-semibold text-muted-foreground">2.</span>
                    <p>
                      <span className="font-semibold text-foreground">Variance</span> = Counted - Expected. Within
                      5% is treated as normal counting noise and shown in green -- nothing to worry about.
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <TrendingUp className="w-4 h-4 text-warning shrink-0 mt-0.5" />
                    <p>
                      <span className="font-semibold text-warning">Overage</span> -- you counted more than expected.
                      Often a past miscount or an uncounted delivery; worth a second look, not urgent.
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <TrendingDown className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
                    <p>
                      <span className="font-semibold text-destructive">Shortage</span> -- you counted less than
                      expected. Could be real loss (spoilage, theft, an unlogged use) or a miscount.
                    </p>
                  </div>
                </div>
                <div className="pt-3 border-t border-border space-y-2">
                  <p>
                    <span className="font-semibold text-foreground">You don't have to count everything at once</span>{' '}
                    -- Save works as soon as at least one item has a counted value; anything left blank is simply
                    skipped and stays untouched.
                  </p>
                  <p>
                    <span className="font-semibold text-foreground">When you save:</span> stock is set to exactly
                    what you counted. Any item that came out different from expected -- overage or shortage -- is
                    permanently logged as a stock count adjustment in{' '}
                    <span className="font-semibold text-foreground">Inventory Movements</span>, showing the before
                    and after value, who counted it, and when. An item that matched exactly logs nothing -- there's
                    no discrepancy to record.
                  </p>
                  <p>
                    <span className="font-semibold text-foreground">If anything comes up short,</span> you'll be
                    asked afterward whether to log it as a loss under "Shrinkage" so the cost is tracked. This is
                    always optional and never automatic -- a shortage might just be a miscount, so it's your call.
                  </p>
                </div>
              </CardContent>
            </CollapsibleContent>
          </Card>
        </Collapsible>

        {/* Inventory Table */}
        <Card className="border-l-4 border-l-primary">
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <div>
              <CardTitle>Recipe Ingredients</CardTitle>
              <button
                type="button"
                className="text-xs text-primary underline underline-offset-2 mt-0.5"
                onClick={onViewStations}
              >
                View Station Items &rarr;
              </button>
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
                  <TableRow>
                    <TableHead className="cursor-pointer select-none" onClick={() => handleSort('name')}>
                      <span className="inline-flex items-center gap-1">
                        Item <SortIcon column="name" />
                      </span>
                    </TableHead>
                    <TableHead className="cursor-pointer select-none" onClick={() => handleSort('category')}>
                      <span className="inline-flex items-center gap-1">
                        Category <SortIcon column="category" />
                      </span>
                    </TableHead>
                    <TableHead className="text-right cursor-pointer select-none" onClick={() => handleSort('unit_cost')}>
                      <span className="inline-flex items-center gap-1 justify-end">
                        Unit Cost <SortIcon column="unit_cost" />
                      </span>
                    </TableHead>
                    <TableHead className="text-right cursor-pointer select-none" onClick={() => handleSort('expected')}>
                      <span className="inline-flex items-center gap-1 justify-end">
                        Expected <SortIcon column="expected" />
                      </span>
                    </TableHead>
                    <TableHead className="text-right">Counted</TableHead>
                    <TableHead className="text-right cursor-pointer select-none" onClick={() => handleSort('variance')}>
                      <span className="inline-flex items-center gap-1 justify-end">
                        Variance <SortIcon column="variance" />
                      </span>
                    </TableHead>
                    <TableHead className="text-center cursor-pointer select-none" onClick={() => handleSort('status')}>
                      <span className="inline-flex items-center gap-1 justify-center">
                        Status <SortIcon column="status" />
                      </span>
                    </TableHead>
                    {user?.role === 'executive' && <TableHead />}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sortedRows.map(({ ingredient, counted, variance, variancePercent, status }) => (
                    <TableRow key={ingredient.id}>
                      <TableCell className="font-medium">{ingredient.name}</TableCell>
                      <TableCell className="text-muted-foreground">{ingredient.category || '--'}</TableCell>
                      <TableCell className="text-right">
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
                      <TableCell className="text-right">
                        {ingredient.current_stock} {ingredient.base_unit}
                      </TableCell>
                      <TableCell className="text-right">
                        <Input
                          type="number"
                          placeholder="0"
                          value={countedValues[ingredient.id] ?? ''}
                          onChange={(e) => updateCount(ingredient.id, e.target.value)}
                          className="w-24 text-right text-sm ml-auto"
                        />
                      </TableCell>
                      <TableCell className="text-right">
                        {variance !== null ? (
                          <span className={`font-semibold ${getVarianceColor(variancePercent)}`}>
                            {variance > 0 ? '+' : ''}
                            {variance.toFixed(1)} ({variancePercent?.toFixed(1)}%)
                          </span>
                        ) : (
                          <span className="text-muted-foreground">--</span>
                        )}
                      </TableCell>
                      <TableCell className="text-center">
                        <div className="flex items-center justify-center gap-1.5">
                          {getStatusIcon(status)}
                          {getStatusLabel(status) && (
                            <span
                              className={`text-xs ${status === 'overage' ? 'text-warning' : 'text-destructive'}`}
                            >
                              {getStatusLabel(status)}
                            </span>
                          )}
                        </div>
                      </TableCell>
                      {user?.role === 'executive' && (
                        <TableCell>
                          <Button size="sm" variant="outline" onClick={() => openEdit(ingredient)}>
                            Edit
                          </Button>
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {/* Variance Items */}
        {varianceItems > 0 && (
          <Card className="border-l-4 border-l-destructive bg-error-bg">
            <CardHeader>
              <CardTitle className="text-destructive">Items with Variance</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {sortedRows
                  .filter((r) => r.status === 'overage' || r.status === 'shortage')
                  .map(({ ingredient, counted, variancePercent, status }) => (
                    <div
                      key={ingredient.id}
                      className="flex justify-between items-center p-3 bg-card rounded-md border border-border"
                    >
                      <div>
                        <p className="font-semibold text-foreground">{ingredient.name}</p>
                        <p className="text-xs text-muted-foreground">
                          Expected: {ingredient.current_stock} {ingredient.base_unit} - Counted: {counted}{' '}
                          {ingredient.base_unit}
                        </p>
                      </div>
                      <Badge variant={status === 'overage' ? 'secondary' : 'destructive'} className="text-sm">
                        {getStatusLabel(status)} - {variancePercent?.toFixed(1)}%
                      </Badge>
                    </div>
                  ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Submit Button */}
        <div className="space-y-1.5">
          <Button
            onClick={handleSubmit}
            disabled={submitting || ingredients.length === 0 || countedItems === 0}
            className="w-full py-6"
          >
            {submitting ? <Loader2 className="w-5 h-5 mr-2 animate-spin" /> : null}
            Save Inventory Count
          </Button>
          {countedItems > 0 && countedItems < ingredients.length && (
            <p className="text-xs text-muted-foreground text-center">
              Only the {countedItems} item{countedItems === 1 ? '' : 's'} you've entered will be saved -- the rest
              are left as-is, you don't need to count everything at once.
            </p>
          )}
        </div>
      </div>

      {/* Shrinkage follow-up prompt */}
      <Dialog open={shrinkageDialogOpen} onOpenChange={setShrinkageDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Log Shortages as a Loss?</DialogTitle>
            <DialogDescription>
              This count came up short on {shrinkageItems.length} item{shrinkageItems.length === 1 ? '' : 's'}.
              Optionally log each as a loss so the cost is tracked -- this is never automatic, and skipping is fine.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 max-h-96 overflow-y-auto">
            {shrinkageItems.map((item) => (
              <div
                key={item.ingredientId}
                className="flex items-center justify-between gap-3 p-3 bg-card rounded-md border border-border"
              >
                <div className="min-w-0">
                  <p className="font-semibold text-foreground">{item.ingredientName}</p>
                  <p className="text-xs text-muted-foreground">
                    Short by {item.quantity} {item.unit}
                  </p>
                </div>
                {item.logged ? (
                  <Badge variant="secondary" className="text-xs shrink-0">
                    Logged
                  </Badge>
                ) : (
                  user?.id && (
                    <LossRecordForm
                      layout="compact"
                      employeeId={user.id}
                      fixedIngredientId={item.ingredientId}
                      fixedIngredientLabel={item.ingredientName}
                      quantityEditable={false}
                      fixedQuantity={item.quantity}
                      quantityUnit={item.unit}
                      reasonOptions={SHRINKAGE_REASONS}
                      defaultReason="shrinkage"
                      skipStockDeduction
                      submitLabel="Log Loss"
                      successToast={() => `${item.ingredientName} logged as a loss`}
                      onSuccess={() => markShrinkageLogged(item.ingredientId)}
                    />
                  )
                )}
              </div>
            ))}
          </div>
          <Button variant="ghost" onClick={() => setShrinkageDialogOpen(false)} className="w-full">
            Done
          </Button>
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
