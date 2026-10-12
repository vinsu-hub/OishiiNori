import React, { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import { DashboardLayout } from '@/components/DashboardLayout';
import { useAuth } from '@/contexts/AuthContext';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart';
import { ApiCashExpense, ApiDashboardSummary, ApiSalesInsights, SalesPeriod, fetchCashExpenseReport, fetchDashboardSummary, fetchSalesInsights } from '@/lib/api';
import { DEPARTMENT_CONFIG } from '@/lib/types';
import { todayIsoPH } from '@/lib/constants';
import { useVisiblePolling } from '@/hooks/useVisiblePolling';
import { formatCurrency, formatTime12h, formatTimestamp12h } from '@/lib/utils';

// Polling, not websockets/Supabase realtime -- matches this app's established
// pattern (OrderQueue.tsx/KitchenDisplay.tsx), even though the SMFC
// reference's own Command Center uses Supabase Realtime.
const POLL_INTERVAL_MS = 30_000;
const SALES_POLL_INTERVAL_MS = 120_000;
const salesChartConfig: ChartConfig = { revenue: { label: 'Paid sales', color: 'var(--primary)' } };
const ORDER_TYPE_LABELS = { dine_in: 'Dine-in', takeout: 'Takeout', delivery: 'Delivery', unspecified: 'Unspecified' };
const SOURCE_LABELS = { pos: 'POS', online: 'Online', grab: 'Grab', qr: 'Table QR', unspecified: 'Unspecified' };
const CORE_PAYMENT_METHODS = ['cash', 'gcash', 'debit', 'credit', 'bdo', 'maya'];
function paymentLabel(method: string): string {
  return ({ cash: 'Cash', gcash: 'GCash', debit: 'Debit', credit: 'Credit', bdo: 'BDO', maya: 'Maya', unspecified_card: 'Unspecified card', unspecified: 'Unspecified' } as Record<string, string>)[method]
    ?? method;
}

function changeLabel(value: number | null): string {
  if (value === null) return '—';
  return `${value > 0 ? '+' : ''}${value.toFixed(1)}%`;
}

function localDateLabel(iso: string): string {
  return new Date(iso).toLocaleDateString('en-PH', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric', year: 'numeric' });
}

export default function CommandCenter() {
  const { user } = useAuth();
  const canView = !!user && (user.role === 'executive' || user.extraPages.includes('command-center'));
  const [summary, setSummary] = useState<ApiDashboardSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [salesPeriod, setSalesPeriod] = useState<SalesPeriod>('day');
  const [salesAnchor, setSalesAnchor] = useState(todayIsoPH);
  const [sales, setSales] = useState<ApiSalesInsights | null>(null);
  const [salesLoading, setSalesLoading] = useState(true);
  const [salesError, setSalesError] = useState<string | null>(null);
  const salesRequestId = useRef(0);
  const [expenses, setExpenses] = useState<ApiCashExpense[]>([]);
  const [expensesLoading, setExpensesLoading] = useState(false);
  const [expensesError, setExpensesError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!canView) return;
    fetchDashboardSummary(todayIsoPH())
      .then(setSummary)
      .catch((e) => toast.error(`Failed to load Command Center: ${e.message}`))
      .finally(() => setLoading(false));
  }, [canView]);

  useVisiblePolling(load, POLL_INTERVAL_MS);

  const loadSales = useCallback(() => {
    if (!canView) return;
    const requestId = ++salesRequestId.current;
    setSalesLoading(true);
    fetchSalesInsights(salesPeriod, salesAnchor)
      .then((result) => {
        if (requestId !== salesRequestId.current) return;
        setSales(result);
        setSalesError(null);
      })
      .catch((error) => {
        if (requestId !== salesRequestId.current) return;
        setSalesError(error.message || 'Unable to load sales analytics.');
      })
      .finally(() => {
        if (requestId === salesRequestId.current) setSalesLoading(false);
      });
  }, [canView, salesPeriod, salesAnchor]);

  useVisiblePolling(loadSales, SALES_POLL_INTERVAL_MS);

  useEffect(() => {
    if (!sales) {
      setExpenses([]);
      setExpensesError(null);
      setExpensesLoading(false);
      return;
    }
    let active = true;
    setExpensesLoading(true);
    setExpensesError(null);
    fetchCashExpenseReport(sales.period_start.slice(0, 10), sales.period_end.slice(0, 10))
      .then((rows) => { if (active) { setExpenses(rows); setExpensesError(null); } })
      .catch((error) => { if (active) setExpensesError(error.message || 'Could not load register expenses.'); })
      .finally(() => { if (active) setExpensesLoading(false); });
    return () => { active = false; };
  }, [sales]);

  const chartData = (sales?.series ?? []).map((point) => ({
    label: salesPeriod === 'day' ? formatTime12h(`${point.bucket.slice(-2)}:00`) : point.bucket.slice(5),
    revenue: point.revenue,
  }));
  const topItems = (sales?.categories ?? []).flatMap((category) => category.items)
    .sort((a, b) => b.item_revenue - a.item_revenue).slice(0, 5);
  const paymentRows = sales ? [
    ...CORE_PAYMENT_METHODS.map((method) => sales.by_payment_method.find((row) => row.payment_method === method)
      ?? { payment_method: method, revenue: 0, order_count: 0 }),
    ...sales.by_payment_method.filter((row) => !CORE_PAYMENT_METHODS.includes(row.payment_method)),
  ] : [];

  if (user && user.role !== 'executive' && !user.extraPages.includes('command-center')) {
    return (
      <DashboardLayout title="Command Center">
        <div className="p-6">
          <p className="text-sm text-muted-foreground">You don't have access to this page.</p>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout title="Command Center">
      <div className="p-6 space-y-4">
        <section className="space-y-4" aria-label="Paid sales analytics">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="font-corp-display text-xl font-semibold">Paid sales</h2>
              <p className="text-sm text-muted-foreground">Recorded orders, grouped by the date they were placed. Unpaid and voided orders are excluded.</p>
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <div className="space-y-1">
                <label htmlFor="sales-period" className="text-xs text-muted-foreground">View by</label>
                <Select value={salesPeriod} onValueChange={(value) => { setSales(null); setSalesError(null); setSalesPeriod(value as SalesPeriod); }}>
                  <SelectTrigger id="sales-period" aria-label="Sales period"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="day">Day</SelectItem>
                    <SelectItem value="week">Week</SelectItem>
                    <SelectItem value="month">Month</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <label htmlFor="sales-anchor" className="text-xs text-muted-foreground">Date</label>
                <Input id="sales-anchor" type="date" value={salesAnchor} max={todayIsoPH()} onChange={(event) => {
                  if (event.target.value) { setSales(null); setSalesError(null); setSalesAnchor(event.target.value); }
                }} />
              </div>
            </div>
          </div>

          {salesError && <div role="alert" className="rounded-md border border-destructive/40 p-3 text-sm">
            Sales analytics could not load: {salesError} <button type="button" className="ml-2 underline" onClick={loadSales}>Retry</button>
          </div>}
          {salesLoading && !sales && <p className="text-sm text-muted-foreground">Loading sales analytics...</p>}
          {sales && <>
            <p className="text-sm text-muted-foreground">
              {localDateLabel(sales.period_start)}–{localDateLabel(new Date(new Date(sales.period_end).getTime() - 1).toISOString())}
              {new Date(sales.as_of).getTime() < new Date(sales.period_end).getTime() ? ' · In progress; compared with the same elapsed portion of the prior period' : ''}
              {salesLoading ? ' · Refreshing…' : ''}
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
              <Card><CardHeader><CardTitle className="text-sm text-muted-foreground">Paid sales</CardTitle></CardHeader><CardContent className="text-2xl font-semibold">{formatCurrency(sales.revenue)}</CardContent></Card>
              <Card><CardHeader><CardTitle className="text-sm text-muted-foreground">Paid orders</CardTitle></CardHeader><CardContent className="text-2xl font-semibold">{sales.order_count}</CardContent></Card>
              <Card><CardHeader><CardTitle className="text-sm text-muted-foreground">Average order value</CardTitle></CardHeader><CardContent className="text-2xl font-semibold">{formatCurrency(sales.average_order_value)}</CardContent></Card>
              <Card><CardHeader><CardTitle className="text-sm text-muted-foreground">Versus previous period</CardTitle></CardHeader><CardContent><div className="text-2xl font-semibold">{changeLabel(sales.revenue_change_pct)}</div><p className="text-xs text-muted-foreground">Previous: {formatCurrency(sales.previous_revenue)}{sales.revenue_change_pct === null ? ' · no prior sales' : ''}</p></CardContent></Card>
            </div>

            <Card>
              <CardHeader><CardTitle className="font-corp-display">Sales over time</CardTitle></CardHeader>
              <CardContent>
                <ChartContainer config={salesChartConfig} className="h-64 w-full">
                  <BarChart data={chartData}><CartesianGrid vertical={false} /><XAxis dataKey="label" tickLine={false} axisLine={false} minTickGap={24} /><YAxis tickLine={false} axisLine={false} tickFormatter={(value) => `₱${value}`} /><ChartTooltip content={<ChartTooltipContent />} /><Bar dataKey="revenue" fill="var(--color-revenue)" radius={4} /></BarChart>
                </ChartContainer>
              </CardContent>
            </Card>

            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
              <Card><CardHeader><CardTitle className="font-corp-display">Dine-in, takeout & delivery</CardTitle></CardHeader><CardContent className="overflow-x-auto">
                <Table><TableHeader><TableRow><TableHead>Order type</TableHead><TableHead className="text-right">Orders</TableHead><TableHead className="text-right">Paid sales</TableHead><TableHead className="text-right">Share</TableHead><TableHead className="text-right">Avg. order</TableHead><TableHead className="text-right">Change</TableHead></TableRow></TableHeader><TableBody>
                  {sales.by_order_type.filter((row) => row.order_count || row.previous_revenue).map((row) => <TableRow key={row.order_type}><TableCell className="font-medium">{ORDER_TYPE_LABELS[row.order_type]}</TableCell><TableCell className="text-right">{row.order_count}</TableCell><TableCell className="text-right">{formatCurrency(row.revenue)}</TableCell><TableCell className="text-right">{row.share_pct.toFixed(1)}%</TableCell><TableCell className="text-right">{formatCurrency(row.average_order_value)}</TableCell><TableCell className="text-right">{changeLabel(row.change_pct)}</TableCell></TableRow>)}
                  {sales.order_count === 0 && <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground">No paid orders in this period.</TableCell></TableRow>}
                </TableBody></Table>
              </CardContent></Card>
              <Card><CardHeader><CardTitle className="font-corp-display">Order source</CardTitle></CardHeader><CardContent>
                <Table><TableHeader><TableRow><TableHead>Source</TableHead><TableHead className="text-right">Paid orders</TableHead><TableHead className="text-right">Paid sales</TableHead></TableRow></TableHeader><TableBody>
                  {sales.by_order_source.filter((row) => row.order_count).map((row) => <TableRow key={row.order_source}><TableCell>{SOURCE_LABELS[row.order_source]}</TableCell><TableCell className="text-right">{row.order_count}</TableCell><TableCell className="text-right">{formatCurrency(row.revenue)}</TableCell></TableRow>)}
                  {sales.order_count === 0 && <TableRow><TableCell colSpan={3} className="text-center text-muted-foreground">No paid orders in this period.</TableCell></TableRow>}
                </TableBody></Table>
              </CardContent></Card>
            </div>

            <section aria-label="Sales Breakdown" className="space-y-3">
              <h3 className="font-corp-display text-lg font-semibold">Sales Breakdown</h3>
              <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                <Card><CardHeader><CardTitle>Payment method</CardTitle></CardHeader><CardContent className="overflow-x-auto"><Table><TableHeader><TableRow><TableHead>Method</TableHead><TableHead className="text-right">Paid orders</TableHead><TableHead className="text-right">Paid sales</TableHead></TableRow></TableHeader><TableBody>
                  {paymentRows.map((row) => <TableRow key={row.payment_method}><TableCell>{paymentLabel(row.payment_method)}</TableCell><TableCell className="text-right">{row.order_count}</TableCell><TableCell className="text-right">{formatCurrency(row.revenue)}</TableCell></TableRow>)}
                </TableBody></Table></CardContent></Card>
                <Card><CardHeader><CardTitle>Payment by order source</CardTitle></CardHeader><CardContent className="overflow-x-auto"><Table><TableHeader><TableRow><TableHead>Source</TableHead><TableHead>Method</TableHead><TableHead className="text-right">Paid orders</TableHead><TableHead className="text-right">Paid sales</TableHead></TableRow></TableHeader><TableBody>
                  {sales.by_payment_source.map((row) => <TableRow key={`${row.order_source}-${row.payment_method}`}><TableCell>{SOURCE_LABELS[row.order_source]}</TableCell><TableCell>{paymentLabel(row.payment_method)}</TableCell><TableCell className="text-right">{row.order_count}</TableCell><TableCell className="text-right">{formatCurrency(row.revenue)}</TableCell></TableRow>)}
                  {sales.by_payment_source.length === 0 && <TableRow><TableCell colSpan={4}>No paid orders in this period.</TableCell></TableRow>}
                </TableBody></Table></CardContent></Card>
              </div>
            </section>

            <section aria-label="Register expense report">
              <Card>
                <CardHeader><CardTitle className="font-corp-display">Register expense report</CardTitle><p className="text-xs text-muted-foreground">Cash taken from the register for operating items during this period. Recorded separately from paid sales.</p></CardHeader>
                <CardContent className="space-y-3">
                  <p className="text-lg font-semibold">Total expenses: {formatCurrency(expenses.reduce((sum, row) => sum + row.amount, 0))}</p>
                  {expensesError && <p role="alert" className="text-sm text-destructive">{expensesError}</p>}
                  {expensesLoading && <p className="text-sm text-muted-foreground">Loading expenses…</p>}
                  <div className="overflow-x-auto"><Table><TableHeader><TableRow><TableHead>Date and time</TableHead><TableHead>Expense / purpose</TableHead><TableHead>Recorded by</TableHead><TableHead className="text-right">Amount</TableHead></TableRow></TableHeader><TableBody>
                    {expenses.map((row) => <TableRow key={row.id}><TableCell>{formatTimestamp12h(row.created_at)}</TableCell><TableCell>{row.description}</TableCell><TableCell>{row.recorded_by_name ?? 'Unknown staff'}</TableCell><TableCell className="text-right">{formatCurrency(row.amount)}</TableCell></TableRow>)}
                    {!expensesLoading && !expensesError && expenses.length === 0 && <TableRow><TableCell colSpan={4}>No register expenses in this period.</TableCell></TableRow>}
                  </TableBody></Table></div>
                </CardContent>
              </Card>
            </section>

            <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
              <Card className="xl:col-span-2"><CardHeader><CardTitle className="font-corp-display">Menu category sales</CardTitle><p className="text-xs text-muted-foreground">Gross item sales before order-level discounts; delivery fees are not assigned to items.</p></CardHeader><CardContent className="space-y-2">
                {sales.categories.map((category) => <details key={category.category} className="rounded-md border px-3 py-2"><summary className="flex cursor-pointer flex-wrap justify-between gap-2 font-medium"><span>{category.category}</span><span>{category.quantity_sold} sold · {formatCurrency(category.item_revenue)}</span></summary><div className="mt-2 overflow-x-auto"><Table><TableHeader><TableRow><TableHead>Item</TableHead><TableHead>Size</TableHead><TableHead className="text-right">Quantity</TableHead><TableHead className="text-right">Gross item sales</TableHead></TableRow></TableHeader><TableBody>{category.items.map((item) => <TableRow key={item.product_size_id}><TableCell>{item.product_name}</TableCell><TableCell>{item.size_label}</TableCell><TableCell className="text-right">{item.quantity_sold}</TableCell><TableCell className="text-right">{formatCurrency(item.item_revenue)}</TableCell></TableRow>)}</TableBody></Table></div></details>)}
                {sales.categories.length === 0 && <p className="text-sm text-muted-foreground">No menu items sold in this period.</p>}
              </CardContent></Card>
              <div className="space-y-4">
                <Card><CardHeader><CardTitle className="font-corp-display">Peak sales hour</CardTitle></CardHeader><CardContent><p className="text-2xl font-semibold">{sales.peak_hour === null ? '—' : `${formatTime12h(`${String(sales.peak_hour).padStart(2, '0')}:00`)}–${formatTime12h(`${String((sales.peak_hour + 1) % 24).padStart(2, '0')}:00`)}`}</p><p className="text-xs text-muted-foreground">Philippine time, by paid order value</p></CardContent></Card>
                <Card><CardHeader><CardTitle className="font-corp-display">Best-selling items</CardTitle></CardHeader><CardContent className="space-y-2">{topItems.map((item, index) => <div key={item.product_size_id} className="flex justify-between gap-2 text-sm"><span>{index + 1}. {item.product_name} ({item.size_label})</span><span className="font-medium whitespace-nowrap">{formatCurrency(item.item_revenue)}</span></div>)}{topItems.length === 0 && <p className="text-sm text-muted-foreground">No items sold.</p>}</CardContent></Card>
              </div>
            </div>
          </>}
        </section>

        <h2 className="font-corp-display text-xl font-semibold pt-4">Today’s operations</h2>
        {loading && <p className="text-sm text-muted-foreground">Loading today's summary...</p>}

        {!loading && summary && (
          <>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <Card>
                <CardHeader>
                  <CardTitle className="font-corp-display text-sm text-muted-foreground">Order value today (including unpaid)</CardTitle>
                </CardHeader>
                <CardContent className="text-2xl font-semibold">{summary.revenue.toFixed(2)}</CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle className="font-corp-display text-sm text-muted-foreground">Orders placed today</CardTitle>
                </CardHeader>
                <CardContent className="text-2xl font-semibold">{summary.order_count}</CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle className="font-corp-display text-sm text-muted-foreground">Losses today</CardTitle>
                </CardHeader>
                <CardContent className="text-2xl font-semibold text-destructive">
                  {summary.loss_total.toFixed(2)}
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle className="font-corp-display text-sm text-muted-foreground">Staff clocked in</CardTitle>
                </CardHeader>
                <CardContent className="text-2xl font-semibold">
                  {summary.hr_available ? summary.staff_clocked_in : '--'}
                </CardContent>
                {!summary.hr_available && (
                  <CardContent className="pt-0 text-xs text-muted-foreground">
                    Not available yet (hr schema not exposed)
                  </CardContent>
                )}
              </Card>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Card>
                <CardHeader>
                  <CardTitle className="font-corp-display">By department</CardTitle>
                </CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Department</TableHead>
                        <TableHead>Item revenue</TableHead>
                        <TableHead>Items sold</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {summary.by_department.map((d) => (
                        <TableRow key={d.department}>
                          <TableCell className="font-medium">{DEPARTMENT_CONFIG[d.department].name}</TableCell>
                          <TableCell>{d.item_revenue.toFixed(2)}</TableCell>
                          <TableCell>{d.item_count}</TableCell>
                        </TableRow>
                      ))}
                      {summary.by_department.length === 0 && (
                        <TableRow>
                          <TableCell colSpan={3} className="text-center text-sm text-muted-foreground">
                            No sales yet today.
                          </TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="font-corp-display">Utility cost today</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  <p className="text-2xl font-semibold">{summary.utility_cost_today.toFixed(2)}</p>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Type</TableHead>
                        <TableHead>Cost</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {summary.utility_breakdown.map((u) => (
                        <TableRow key={u.utility_type}>
                          <TableCell className="capitalize">{u.utility_type}</TableCell>
                          <TableCell>{u.cost.toFixed(2)}</TableCell>
                        </TableRow>
                      ))}
                      {summary.utility_breakdown.length === 0 && (
                        <TableRow>
                          <TableCell colSpan={2} className="text-center text-sm text-muted-foreground">
                            No utility readings logged today.
                          </TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            </div>

            <Card>
              <CardHeader><CardTitle className="font-corp-display">Orders by source today (including unpaid)</CardTitle></CardHeader>
              <CardContent>
                <Table>
                  <TableHeader><TableRow><TableHead>Source</TableHead><TableHead>Orders</TableHead><TableHead>Sales</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {summary.by_order_source.map((row) => (
                      <TableRow key={row.order_source}>
                        <TableCell className="font-medium">{{ pos: 'POS', online: 'Online', grab: 'Grab', qr: 'Table QR' }[row.order_source]}</TableCell>
                        <TableCell>{row.order_count}</TableCell>
                        <TableCell>{row.revenue.toFixed(2)}</TableCell>
                      </TableRow>
                    ))}
                    {summary.by_order_source.length === 0 && <TableRow><TableCell colSpan={3} className="text-center text-sm text-muted-foreground">No source-tagged orders today.</TableCell></TableRow>}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="font-corp-display">Low stock / reorder alerts</CardTitle>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Ingredient</TableHead>
                      <TableHead>Current stock</TableHead>
                      <TableHead>Reorder threshold</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {summary.low_stock_ingredients.map((i) => (
                      <TableRow key={i.id}>
                        <TableCell className="font-medium">{i.name}</TableCell>
                        <TableCell>
                          {i.current_stock} {i.base_unit}
                        </TableCell>
                        <TableCell>
                          {i.reorder_threshold} {i.base_unit}
                        </TableCell>
                        <TableCell>
                          <Badge variant="destructive">Reorder</Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                    {summary.low_stock_ingredients.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={4} className="text-center text-sm text-muted-foreground">
                          Nothing below its reorder threshold.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </DashboardLayout>
  );
}
