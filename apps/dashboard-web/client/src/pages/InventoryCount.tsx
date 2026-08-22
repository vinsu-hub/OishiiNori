import React, { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { DashboardLayout } from '@/components/DashboardLayout';
import { useAuth } from '@/contexts/AuthContext';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { CheckCircle, ChevronDown, HelpCircle, Loader2, Package, TrendingDown, TrendingUp } from 'lucide-react';
import { ApiIngredient, LossReason, countStock, createLossRecord, fetchInventory } from '@/lib/api';

type ItemStatus = 'pending' | 'counted' | 'overage' | 'shortage';

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
  reason: LossReason;
  logged: boolean;
}

function computeStatus(expected: number, counted: number | null): ItemStatus {
  if (counted === null) return 'pending';
  const variancePercent = expected === 0 ? 0 : ((counted - expected) / expected) * 100;
  if (Math.abs(variancePercent) <= 5) return 'counted';
  return variancePercent > 0 ? 'overage' : 'shortage';
}

export default function InventoryCount() {
  const { user } = useAuth();
  const [ingredients, setIngredients] = useState<ApiIngredient[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [countedValues, setCountedValues] = useState<Record<string, string>>({});
  const [shrinkageDialogOpen, setShrinkageDialogOpen] = useState(false);
  const [shrinkageItems, setShrinkageItems] = useState<ShrinkageItem[]>([]);
  const [loggingId, setLoggingId] = useState<string | null>(null);
  const [howItWorksOpen, setHowItWorksOpen] = useState(true);

  const loadInventory = useCallback(() => {
    setLoading(true);
    fetchInventory()
      .then((data) => setIngredients([...data].sort((a, b) => a.name.localeCompare(b.name))))
      .catch(() => toast.error('Could not load inventory. Check your connection.'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    loadInventory();
  }, [loadInventory]);

  const updateCount = (id: string, value: string) => {
    setCountedValues({ ...countedValues, [id]: value });
  };

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
            reason: 'shrinkage',
            logged: false,
          })
        );

      setCountedValues({});
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

  const handleLogShrinkage = async (item: ShrinkageItem) => {
    if (!user?.id) return;
    setLoggingId(item.ingredientId);
    try {
      await createLossRecord({
        employee_id: user.id,
        ingredient_id: item.ingredientId,
        reason: item.reason,
        quantity: item.quantity,
        skip_stock_deduction: true,
      });
      toast.success(`${item.ingredientName} logged as a loss`);
      setShrinkageItems((prev) =>
        prev.map((i) => (i.ingredientId === item.ingredientId ? { ...i, logged: true } : i))
      );
    } catch (error) {
      toast.error(`Could not log ${item.ingredientName}. Try again.`);
      console.error(error);
    } finally {
      setLoggingId(null);
    }
  };

  const updateShrinkageReason = (ingredientId: string, reason: LossReason) => {
    setShrinkageItems((prev) =>
      prev.map((i) => (i.ingredientId === ingredientId ? { ...i, reason } : i))
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

  return (
    <DashboardLayout title="Inventory Count">
      <div className="p-6 space-y-6">
        {/* Progress Summary */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
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
        </div>

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
          <CardHeader>
            <CardTitle>Stock Count</CardTitle>
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
                    <TableHead>Item</TableHead>
                    <TableHead>Category</TableHead>
                    <TableHead className="text-right">Expected</TableHead>
                    <TableHead className="text-right">Counted</TableHead>
                    <TableHead className="text-right">Variance</TableHead>
                    <TableHead className="text-center">Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map(({ ingredient, counted, variance, variancePercent, status }) => (
                    <TableRow key={ingredient.id}>
                      <TableCell className="font-medium">{ingredient.name}</TableCell>
                      <TableCell className="text-muted-foreground">{ingredient.category || '--'}</TableCell>
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
                {rows
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
                  <div className="flex items-center gap-2 shrink-0">
                    <Select
                      value={item.reason}
                      onValueChange={(v) => updateShrinkageReason(item.ingredientId, v as LossReason)}
                    >
                      <SelectTrigger className="w-40 h-8 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {SHRINKAGE_REASONS.map((r) => (
                          <SelectItem key={r.value} value={r.value}>
                            {r.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={loggingId === item.ingredientId}
                      onClick={() => handleLogShrinkage(item)}
                    >
                      {loggingId === item.ingredientId ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        'Log Loss'
                      )}
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
          <Button variant="ghost" onClick={() => setShrinkageDialogOpen(false)} className="w-full">
            Done
          </Button>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
}
