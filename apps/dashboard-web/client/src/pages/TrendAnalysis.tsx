import React, { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import { DashboardLayout } from '@/components/DashboardLayout';
import { useAuth } from '@/contexts/AuthContext';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart';
import { ApiSalesTrend, ApiTopProducts, fetchSalesTrend, fetchTopProducts } from '@/lib/api';
import { daysAgoIsoPH } from '@/lib/constants';

const chartConfig: ChartConfig = {
  revenue: { label: 'Revenue', color: 'var(--primary)' },
};

export default function TrendAnalysis() {
  const { user } = useAuth();
  const [dateFrom, setDateFrom] = useState(daysAgoIsoPH(29));
  const [dateTo, setDateTo] = useState(daysAgoIsoPH(0));
  const [trend, setTrend] = useState<ApiSalesTrend | null>(null);
  const [topProducts, setTopProducts] = useState<ApiTopProducts | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      fetchSalesTrend({ date_from: dateFrom, date_to: dateTo }),
      fetchTopProducts({ date_from: dateFrom, date_to: dateTo, limit: 10 }),
    ])
      .then(([t, p]) => {
        setTrend(t);
        setTopProducts(p);
      })
      .catch((e) => toast.error(`Failed to load trend data: ${e.message}`))
      .finally(() => setLoading(false));
  }, [dateFrom, dateTo]);

  useEffect(() => {
    load();
  }, [load]);

  if (user && user.role !== 'executive' && !user.extraPages.includes('trends')) {
    return (
      <DashboardLayout title="Trend Analysis">
        <div className="p-6">
          <p className="text-sm text-muted-foreground">You don't have access to this page.</p>
        </div>
      </DashboardLayout>
    );
  }

  const chartData = (trend?.points ?? []).map((p) => ({
    date: p.date.slice(5),
    revenue: p.revenue,
  }));

  return (
    <DashboardLayout title="Trend Analysis">
      <div className="p-6 space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label>From</Label>
            <Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label>To</Label>
            <Input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
          </div>
        </div>

        {loading && <p className="text-sm text-muted-foreground">Loading trend data...</p>}

        {!loading && trend && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Card>
              <CardHeader>
                <CardTitle className="font-corp-display text-sm text-muted-foreground">Total revenue</CardTitle>
              </CardHeader>
              <CardContent className="text-2xl font-semibold">{trend.total_revenue.toFixed(2)}</CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="font-corp-display text-sm text-muted-foreground">Total orders</CardTitle>
              </CardHeader>
              <CardContent className="text-2xl font-semibold">{trend.total_orders}</CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="font-corp-display text-sm text-muted-foreground">Avg. order value</CardTitle>
              </CardHeader>
              <CardContent className="text-2xl font-semibold">
                {trend.total_orders > 0 ? (trend.total_revenue / trend.total_orders).toFixed(2) : '0.00'}
              </CardContent>
            </Card>
          </div>
        )}

        {!loading && trend && (
          <Card>
            <CardHeader>
              <CardTitle className="font-corp-display">Daily revenue</CardTitle>
            </CardHeader>
            <CardContent>
              <ChartContainer config={chartConfig} className="h-64 w-full">
                <BarChart data={chartData}>
                  <CartesianGrid vertical={false} />
                  <XAxis dataKey="date" tickLine={false} axisLine={false} />
                  <YAxis tickLine={false} axisLine={false} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Bar dataKey="revenue" fill="var(--color-revenue)" radius={4} />
                </BarChart>
              </ChartContainer>
            </CardContent>
          </Card>
        )}

        {!loading && topProducts && (
          <Card>
            <CardHeader>
              <CardTitle className="font-corp-display">Top products</CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Product</TableHead>
                    <TableHead>Quantity sold</TableHead>
                    <TableHead>Revenue</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {topProducts.products.map((p) => (
                    <TableRow key={p.product_id}>
                      <TableCell className="font-medium">{p.product_name}</TableCell>
                      <TableCell>{p.quantity_sold}</TableCell>
                      <TableCell>{p.revenue.toFixed(2)}</TableCell>
                    </TableRow>
                  ))}
                  {topProducts.products.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={3} className="text-center text-sm text-muted-foreground">
                        No sales in this range.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}
      </div>
    </DashboardLayout>
  );
}
