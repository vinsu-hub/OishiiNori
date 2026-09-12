import React, { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { DashboardLayout } from '@/components/DashboardLayout';
import { useAuth } from '@/contexts/AuthContext';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { formatCurrency } from '@/lib/utils';
import { DEPARTMENT_CONFIG } from '@/lib/types';
import { ApiPnL, PnLPeriod, fetchPnL } from '@/lib/api';

const PERIOD_LABELS: Record<PnLPeriod, string> = {
  today: 'Today',
  week: 'This Week',
  month: 'This Month',
};

function formatPct(pct: number | null): string {
  return pct !== null ? `${(pct * 100).toFixed(1)}%` : '--';
}

export default function PnL() {
  const { user } = useAuth();
  const [period, setPeriod] = useState<PnLPeriod>('today');
  const [pnl, setPnl] = useState<ApiPnL | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    fetchPnL(period)
      .then(setPnl)
      .catch((e) => toast.error(`Failed to load P&L: ${e.message}`))
      .finally(() => setLoading(false));
  }, [period]);

  useEffect(() => {
    load();
  }, [load]);

  if (user && user.role !== 'executive' && !user.extraPages.includes('pnl')) {
    return (
      <DashboardLayout title="P&L">
        <div className="p-6">
          <p className="text-sm text-muted-foreground">You don't have access to this page.</p>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout title="P&L">
      <div className="p-6 space-y-4">
        <Tabs value={period} onValueChange={(v) => setPeriod(v as PnLPeriod)}>
          <TabsList>
            {(Object.keys(PERIOD_LABELS) as PnLPeriod[]).map((p) => (
              <TabsTrigger key={p} value={p}>
                {PERIOD_LABELS[p]}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        {loading && <p className="text-sm text-muted-foreground">Loading P&L...</p>}

        {!loading && pnl && (
          <>
            {pnl.ingredients_missing_cost > 0 && (
              <div className="rounded-md border border-amber-400 bg-amber-50 p-3 text-sm text-amber-900">
                {pnl.ingredients_missing_cost} of {pnl.ingredients_total} ingredients still need a cost --
                COGS and food cost % below are understated until costs are entered (via Receive Shipment).
              </div>
            )}
            {pnl.unfulfilled_bundle_sales > 0 && (
              <div className="rounded-md border border-amber-400 bg-amber-50 p-3 text-sm text-amber-900">
                {pnl.unfulfilled_bundle_sales} bundle sale{pnl.unfulfilled_bundle_sales === 1 ? '' : 's'} this
                period {pnl.unfulfilled_bundle_sales === 1 ? 'has' : 'have'} no fulfillment record (counted as
                ₱0 COGS).
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <Card>
                <CardHeader>
                  <CardTitle className="font-corp-display text-sm text-muted-foreground">Revenue</CardTitle>
                </CardHeader>
                <CardContent className="text-2xl font-semibold">{formatCurrency(pnl.revenue)}</CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle className="font-corp-display text-sm text-muted-foreground">Gross profit</CardTitle>
                </CardHeader>
                <CardContent className={`text-2xl font-semibold ${pnl.gross_profit < 0 ? 'text-destructive' : ''}`}>
                  {formatCurrency(pnl.gross_profit)}
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle className="font-corp-display text-sm text-muted-foreground">Net profit</CardTitle>
                </CardHeader>
                <CardContent className={`text-2xl font-semibold ${pnl.net_profit < 0 ? 'text-destructive' : ''}`}>
                  {formatCurrency(pnl.net_profit)}
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle className="font-corp-display text-sm text-muted-foreground">Food cost %</CardTitle>
                </CardHeader>
                <CardContent className="text-2xl font-semibold">{formatPct(pnl.food_cost_pct)}</CardContent>
              </Card>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Card>
                <CardHeader>
                  <CardTitle className="font-corp-display">Cost breakdown</CardTitle>
                </CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Category</TableHead>
                        <TableHead>Cost</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      <TableRow>
                        <TableCell className="font-medium">COGS</TableCell>
                        <TableCell>{formatCurrency(pnl.costs.cogs)}</TableCell>
                      </TableRow>
                      <TableRow>
                        <TableCell className="font-medium">Payroll ({pnl.payroll_employee_count} employees)</TableCell>
                        <TableCell>{formatCurrency(pnl.costs.payroll)}</TableCell>
                      </TableRow>
                      <TableRow>
                        <TableCell className="font-medium">Utilities</TableCell>
                        <TableCell>{formatCurrency(pnl.costs.utilities)}</TableCell>
                      </TableRow>
                      <TableRow>
                        <TableCell className="font-medium">Losses</TableCell>
                        <TableCell>{formatCurrency(pnl.costs.losses)}</TableCell>
                      </TableRow>
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="font-corp-display">Margin by department</CardTitle>
                </CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Department</TableHead>
                        <TableHead>Revenue</TableHead>
                        <TableHead>COGS</TableHead>
                        <TableHead>Margin</TableHead>
                        <TableHead>Margin %</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {pnl.department_margins.map((d) => (
                        <TableRow key={d.department}>
                          <TableCell className="font-medium">{DEPARTMENT_CONFIG[d.department].name}</TableCell>
                          <TableCell>{formatCurrency(d.revenue)}</TableCell>
                          <TableCell>{formatCurrency(d.cogs)}</TableCell>
                          <TableCell>{formatCurrency(d.margin)}</TableCell>
                          <TableCell>{formatPct(d.margin_pct)}</TableCell>
                        </TableRow>
                      ))}
                      {pnl.department_margins.length === 0 && (
                        <TableRow>
                          <TableCell colSpan={5} className="text-center text-sm text-muted-foreground">
                            No sales in this period.
                          </TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            </div>

            {pnl.losses_by_reason.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="font-corp-display">Losses by reason</CardTitle>
                </CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Reason</TableHead>
                        <TableHead>Cost impact</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {pnl.losses_by_reason.map((l) => (
                        <TableRow key={l.reason}>
                          <TableCell className="capitalize">{l.reason.replace('_', ' ')}</TableCell>
                          <TableCell>{formatCurrency(l.cost_impact)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            )}
          </>
        )}
      </div>
    </DashboardLayout>
  );
}
