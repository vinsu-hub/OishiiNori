import React, { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { DashboardLayout } from '@/components/DashboardLayout';
import { useAuth } from '@/contexts/AuthContext';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Loader2 } from 'lucide-react';
import { ApiRefund, approveRefund, fetchRefunds, rejectRefund } from '@/lib/api';
import { formatCurrency, formatDateTime12h } from '@/lib/utils';

// WS-12: void is queued-only now -- a preparing/ready order's cashier
// files a refund request (Order Queue's Refund button) that lands here for
// a manager/executive to approve (performs the actual void + stock
// restore) or reject.
export default function RefundApproval() {
  const { user } = useAuth();
  const [refunds, setRefunds] = useState<ApiRefund[]>([]);
  const [loading, setLoading] = useState(true);
  const [actingId, setActingId] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    fetchRefunds()
      .then(setRefunds)
      .catch((e) => toast.error(e instanceof Error ? e.message : 'Failed to load refund requests'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleApprove(id: string) {
    setActingId(id);
    try {
      await approveRefund(id);
      toast.success('Refund approved -- order voided and stock restored');
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to approve refund');
    } finally {
      setActingId(null);
    }
  }

  async function handleReject(id: string) {
    setActingId(id);
    try {
      await rejectRefund(id);
      toast.success('Refund rejected');
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to reject refund');
    } finally {
      setActingId(null);
    }
  }

  if (user && user.role === 'employee' && !user.extraPages.includes('refund-approval')) {
    return (
      <DashboardLayout title="Refund Approval">
        <div className="p-6">
          <p className="text-sm text-muted-foreground">You don't have access to this page.</p>
        </div>
      </DashboardLayout>
    );
  }

  const pending = refunds.filter((r) => r.status === 'pending');
  const reviewed = refunds.filter((r) => r.status !== 'pending');

  return (
    <DashboardLayout title="Refund Approval">
      <div className="p-6 space-y-4">
        <Card>
          <CardHeader>
            <CardTitle className="font-corp-display text-base">
              {loading ? 'Loading...' : `${pending.length} pending request${pending.length === 1 ? '' : 's'}`}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="flex items-center justify-center py-8 text-muted-foreground">
                <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                Loading...
              </div>
            ) : pending.length === 0 ? (
              <p className="text-sm text-muted-foreground py-8 text-center">No pending refund requests.</p>
            ) : (
              <div className="space-y-2">
                {pending.map((r) => (
                  <div key={r.id} className="border rounded-md p-3 flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium">
                        {r.order_number != null ? `#${r.order_number}` : r.transaction_id.slice(0, 8)}
                        {r.total_amount != null && (
                          <span className="text-muted-foreground font-normal"> · {formatCurrency(r.total_amount)}</span>
                        )}
                      </p>
                      <p className="text-xs text-muted-foreground">{r.reason}</p>
                      <p className="text-xs text-muted-foreground">
                        requested {formatDateTime12h(r.requested_at)}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={actingId === r.id}
                        onClick={() => handleReject(r.id)}
                      >
                        Reject
                      </Button>
                      <Button size="sm" disabled={actingId === r.id} onClick={() => handleApprove(r.id)}>
                        {actingId === r.id ? 'Working...' : 'Approve'}
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {reviewed.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="font-corp-display text-base">Reviewed</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {reviewed.map((r) => (
                <div key={r.id} className="flex items-center justify-between text-sm border-b pb-2">
                  <span>
                    {r.order_number != null ? `#${r.order_number}` : r.transaction_id.slice(0, 8)}{' '}
                    <span className="text-muted-foreground">{r.reason}</span>
                  </span>
                  <Badge variant={r.status === 'approved' ? 'default' : 'secondary'}>{r.status}</Badge>
                </div>
              ))}
            </CardContent>
          </Card>
        )}
      </div>
    </DashboardLayout>
  );
}
