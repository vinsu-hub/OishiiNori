import React, { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { DashboardLayout } from '@/components/DashboardLayout';
import { useAuth } from '@/contexts/AuthContext';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ApiDashboardSummary, fetchDashboardSummary } from '@/lib/api';
import { DEPARTMENT_CONFIG } from '@/lib/types';
import { todayIsoPH } from '@/lib/constants';
import { useVisiblePolling } from '@/hooks/useVisiblePolling';

// Polling, not websockets/Supabase realtime -- matches this app's established
// pattern (OrderQueue.tsx/KitchenDisplay.tsx), even though the SMFC
// reference's own Command Center uses Supabase Realtime.
const POLL_INTERVAL_MS = 30_000;

export default function CommandCenter() {
  const { user } = useAuth();
  const [summary, setSummary] = useState<ApiDashboardSummary | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    fetchDashboardSummary(todayIsoPH())
      .then(setSummary)
      .catch((e) => toast.error(`Failed to load Command Center: ${e.message}`))
      .finally(() => setLoading(false));
  }, []);

  useVisiblePolling(load, POLL_INTERVAL_MS);

  if (user && user.role !== 'executive') {
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
        {loading && <p className="text-sm text-muted-foreground">Loading today's summary...</p>}

        {!loading && summary && (
          <>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <Card>
                <CardHeader>
                  <CardTitle className="font-corp-display text-sm text-muted-foreground">Revenue today</CardTitle>
                </CardHeader>
                <CardContent className="text-2xl font-semibold">{summary.revenue.toFixed(2)}</CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle className="font-corp-display text-sm text-muted-foreground">Orders today</CardTitle>
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
