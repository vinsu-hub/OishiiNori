import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { DashboardLayout } from '@/components/DashboardLayout';
import { useAuth } from '@/contexts/AuthContext';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Loader2 } from 'lucide-react';
import {
  ApiEmployee,
  ApiIngredient,
  ApiInventoryMovement,
  ApiLossRecord,
  fetchEmployees,
  fetchInventory,
  fetchInventoryMovements,
  fetchLossRecords,
} from '@/lib/api';
import { LOSS_REASONS } from '@/lib/types';
import { formatCurrency } from '@/lib/utils';
import { StockStatusBadge } from '@/components/stock/StockStatusBadge';
import { STOCK_TABLE_CELL_CLASS, STOCK_TABLE_HEAD_CLASS, STOCK_TABLE_ROW_CLASS } from '@/components/stock/stockTableStyle';

const LOSS_REASON_LABELS: Record<string, string> = Object.fromEntries(LOSS_REASONS.map((r) => [r.value, r.label]));

type Kind = 'loss' | 'count_adjustment';

interface VarianceRow {
  key: string;
  createdAt: string;
  ingredientId: string;
  ingredientName: string;
  kind: Kind;
  quantityDisplay: string;
  costImpact: number | null;
  reason: string;
  recordedBy: string;
  idShort: string;
  idFull: string;
}

// The count-flow's own audit trail (services/api-fastapi/app/routers/
// inventory.py's apply_ingredient_count) only ever stores the unsigned
// magnitude in `quantity` -- the signed value lives inside its own
// generated `reason` text ("Stock count: 100 -> 95 (variance -5)"). Parsed
// here for a clearer +/- display; falls back to the plain magnitude for any
// count_adjustment not in that exact shape (e.g. one logged manually via
// Receive Shipment's "Log Other Movement" tab, which has no signed concept).
function parseSignedVariance(reason: string | null, magnitude: number): string {
  const match = reason?.match(/variance ([+-][\d.]+)/);
  if (match) return match[1];
  return String(magnitude);
}

export default function StockVarianceLog() {
  const { user } = useAuth();

  const [lossRecords, setLossRecords] = useState<ApiLossRecord[]>([]);
  const [adjustments, setAdjustments] = useState<ApiInventoryMovement[]>([]);
  const [ingredients, setIngredients] = useState<ApiIngredient[]>([]);
  const [employees, setEmployees] = useState<ApiEmployee[]>([]);
  const [loading, setLoading] = useState(true);

  const [kindFilter, setKindFilter] = useState<'all' | Kind>('all');
  const [ingredientFilter, setIngredientFilter] = useState<string>('all');

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      fetchLossRecords(50),
      fetchInventoryMovements({ type: 'count_adjustment', limit: 50 }),
      fetchInventory(),
      fetchEmployees(),
    ])
      .then(([losses, moves, ing, emps]) => {
        setLossRecords(losses);
        setAdjustments(moves);
        setIngredients(ing);
        setEmployees(emps);
      })
      .catch((e) => toast.error(`Failed to load Variance Log: ${e.message}`))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const ingredientById = useMemo(() => new Map(ingredients.map((i) => [i.id, i])), [ingredients]);
  const employeeById = useMemo(() => new Map(employees.map((e) => [e.id, e])), [employees]);

  const rows = useMemo<VarianceRow[]>(() => {
    const lossRows: VarianceRow[] = lossRecords.map((r) => ({
      key: `loss-${r.id}`,
      createdAt: r.created_at,
      ingredientId: r.ingredient_id,
      ingredientName: ingredientById.get(r.ingredient_id)?.name || r.ingredient_id.slice(0, 8),
      kind: 'loss',
      quantityDisplay: `-${r.quantity}`,
      costImpact: r.cost_impact,
      reason: LOSS_REASON_LABELS[r.reason] || r.reason,
      recordedBy: employeeById.get(r.employee_id)?.full_name || r.employee_id.slice(0, 8),
      idShort: r.id.slice(0, 8),
      idFull: r.id,
    }));
    const adjustmentRows: VarianceRow[] = adjustments.map((m) => ({
      key: `adj-${m.id}`,
      createdAt: m.created_at,
      ingredientId: m.ingredient_id,
      ingredientName: ingredientById.get(m.ingredient_id)?.name || m.ingredient_id.slice(0, 8),
      kind: 'count_adjustment',
      quantityDisplay: parseSignedVariance(m.reason, m.quantity),
      costImpact: m.unit_cost_snapshot != null ? m.unit_cost_snapshot * m.quantity : null,
      reason: m.reason || '--',
      recordedBy: employeeById.get(m.employee_id)?.full_name || m.employee_id.slice(0, 8),
      idShort: m.id.slice(0, 8),
      idFull: m.id,
    }));
    return [...lossRows, ...adjustmentRows].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }, [lossRecords, adjustments, ingredientById, employeeById]);

  const filteredRows = rows
    .filter((r) => kindFilter === 'all' || r.kind === kindFilter)
    .filter((r) => ingredientFilter === 'all' || r.ingredientId === ingredientFilter);

  if (user && user.role === 'employee') {
    return (
      <DashboardLayout title="Variance Log">
        <div className="p-6">
          <p className="text-sm text-muted-foreground">You don't have access to this page.</p>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout title="Variance Log">
      <div className="p-6 space-y-4">
        <Card>
          <CardHeader>
            <CardTitle className="font-corp-display text-base">
              {loading ? 'Loading...' : `${filteredRows.length} of ${rows.length} entries`}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground mb-3">
              The most recent 50 loss records and 50 count adjustments -- there's no server-side date range today, so
              this reflects that fixed window, not a wider history search.
            </p>
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Kind</label>
                <Select value={kindFilter} onValueChange={(v) => setKindFilter(v as 'all' | Kind)}>
                  <SelectTrigger className="w-48">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All kinds</SelectItem>
                    <SelectItem value="loss">Loss Record</SelectItem>
                    <SelectItem value="count_adjustment">Count Adjustment</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1 flex-1 min-w-[200px]">
                <label className="text-xs text-muted-foreground">Ingredient</label>
                <Select value={ingredientFilter} onValueChange={setIngredientFilter}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All ingredients</SelectItem>
                    {ingredients.map((i) => (
                      <SelectItem key={i.id} value={i.id}>
                        {i.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            {loading ? (
              <div className="flex items-center justify-center py-8 text-muted-foreground">
                <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                Loading variance log...
              </div>
            ) : filteredRows.length === 0 ? (
              <p className="text-sm text-muted-foreground py-8 text-center">
                {rows.length === 0 ? 'No loss records or count adjustments logged yet.' : 'No entries match these filters.'}
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className={STOCK_TABLE_ROW_CLASS}>
                    <TableHead className={STOCK_TABLE_HEAD_CLASS}>Date</TableHead>
                    <TableHead className={STOCK_TABLE_HEAD_CLASS}>Ingredient</TableHead>
                    <TableHead className={STOCK_TABLE_HEAD_CLASS}>Kind</TableHead>
                    <TableHead className={`${STOCK_TABLE_HEAD_CLASS} text-right`}>Variance</TableHead>
                    <TableHead className={`${STOCK_TABLE_HEAD_CLASS} text-right`}>Cost Impact</TableHead>
                    <TableHead className={STOCK_TABLE_HEAD_CLASS}>Reason</TableHead>
                    <TableHead className={STOCK_TABLE_HEAD_CLASS}>Recorded By</TableHead>
                    <TableHead className={STOCK_TABLE_HEAD_CLASS}>ID</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredRows.map((row) => (
                    <TableRow key={row.key} className={STOCK_TABLE_ROW_CLASS}>
                      <TableCell className={`${STOCK_TABLE_CELL_CLASS} text-muted-foreground`}>
                        {new Date(row.createdAt).toLocaleString()}
                      </TableCell>
                      <TableCell className={`${STOCK_TABLE_CELL_CLASS} font-medium`}>{row.ingredientName}</TableCell>
                      <TableCell className={STOCK_TABLE_CELL_CLASS}>
                        <StockStatusBadge variant={row.kind === 'loss' ? 'critical' : 'neutral'}>
                          {row.kind === 'loss' ? 'Loss Record' : 'Count Adjustment'}
                        </StockStatusBadge>
                      </TableCell>
                      <TableCell className={`${STOCK_TABLE_CELL_CLASS} text-right font-semibold`}>
                        {row.quantityDisplay}
                      </TableCell>
                      <TableCell className={`${STOCK_TABLE_CELL_CLASS} text-right`}>
                        {row.costImpact != null ? formatCurrency(row.costImpact) : <span className="text-muted-foreground">--</span>}
                      </TableCell>
                      <TableCell className={`${STOCK_TABLE_CELL_CLASS} text-muted-foreground max-w-[280px] truncate`} title={row.reason}>
                        {row.reason}
                      </TableCell>
                      <TableCell className={STOCK_TABLE_CELL_CLASS}>{row.recordedBy}</TableCell>
                      <TableCell className={`${STOCK_TABLE_CELL_CLASS} text-muted-foreground font-corp-mono text-xs`} title={row.idFull}>
                        {row.idShort}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
