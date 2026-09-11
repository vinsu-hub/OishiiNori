import React, { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { DashboardLayout } from '@/components/DashboardLayout';
import { useAuth } from '@/contexts/AuthContext';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Loader2 } from 'lucide-react';
import { ApiBusinessDay, fetchBusinessDays } from '@/lib/api';
import { formatCurrency } from '@/lib/utils';
import { STOCK_TABLE_CELL_CLASS, STOCK_TABLE_HEAD_CLASS, STOCK_TABLE_ROW_CLASS } from '@/components/stock/stockTableStyle';

// WS-13: register-vs-system close-out review -- manager/executive only.
// The cashier-facing endpoints never return cash_register_total/
// system_eod_total at all (see BusinessDayStatusOut on the backend); this
// page is the one place those numbers, and their variance, are visible.
export default function BusinessDayReport() {
  const { user } = useAuth();
  const [days, setDays] = useState<ApiBusinessDay[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    fetchBusinessDays()
      .then(setDays)
      .catch((e) => toast.error(e instanceof Error ? e.message : 'Failed to load business day report'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (user && user.role === 'employee') {
    return (
      <DashboardLayout title="Business Day Report">
        <div className="p-6">
          <p className="text-sm text-muted-foreground">You don't have access to this page.</p>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout title="Business Day Report">
      <div className="p-6 space-y-4">
        <Card>
          <CardHeader>
            <CardTitle className="font-corp-display text-base">
              {loading ? 'Loading...' : `${days.length} business day${days.length === 1 ? '' : 's'}`}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="flex items-center justify-center py-8 text-muted-foreground">
                <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                Loading...
              </div>
            ) : days.length === 0 ? (
              <p className="text-sm text-muted-foreground py-8 text-center">No business days recorded yet.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className={STOCK_TABLE_ROW_CLASS}>
                    <TableHead className={STOCK_TABLE_HEAD_CLASS}>Date</TableHead>
                    <TableHead className={STOCK_TABLE_HEAD_CLASS}>Status</TableHead>
                    <TableHead className={STOCK_TABLE_HEAD_CLASS}>Menu confirmed</TableHead>
                    <TableHead className={`${STOCK_TABLE_HEAD_CLASS} text-right`}>Register total</TableHead>
                    <TableHead className={`${STOCK_TABLE_HEAD_CLASS} text-right`}>System total</TableHead>
                    <TableHead className={`${STOCK_TABLE_HEAD_CLASS} text-right`}>Variance</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {days.map((d) => (
                    <TableRow key={d.id} className={STOCK_TABLE_ROW_CLASS}>
                      <TableCell className={`${STOCK_TABLE_CELL_CLASS} font-medium`}>{d.business_date}</TableCell>
                      <TableCell className={STOCK_TABLE_CELL_CLASS}>
                        <Badge variant={d.closed_at ? 'secondary' : 'default'}>
                          {d.closed_at ? 'Closed' : 'Open'}
                        </Badge>
                      </TableCell>
                      <TableCell className={STOCK_TABLE_CELL_CLASS}>
                        {d.menu_confirmed ? (
                          <Badge variant="secondary">Yes</Badge>
                        ) : (
                          <Badge variant="destructive">No</Badge>
                        )}
                      </TableCell>
                      <TableCell className={`${STOCK_TABLE_CELL_CLASS} text-right`}>
                        {d.cash_register_total != null ? formatCurrency(d.cash_register_total) : '--'}
                      </TableCell>
                      <TableCell className={`${STOCK_TABLE_CELL_CLASS} text-right`}>
                        {d.system_eod_total != null ? formatCurrency(d.system_eod_total) : '--'}
                      </TableCell>
                      <TableCell
                        className={`${STOCK_TABLE_CELL_CLASS} text-right font-semibold ${
                          d.variance != null && Math.abs(d.variance) > 0.01 ? 'text-destructive' : ''
                        }`}
                      >
                        {d.variance != null ? formatCurrency(d.variance) : '--'}
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
