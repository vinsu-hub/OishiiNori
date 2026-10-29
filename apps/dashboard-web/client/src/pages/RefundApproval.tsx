import React, { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { DashboardLayout } from '@/components/DashboardLayout';
import { useAuth } from '@/contexts/AuthContext';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Loader2 } from 'lucide-react';
import { ApiRefund, approveRefund, fetchRefunds, rejectRefund } from '@/lib/api';
import { toIsoDatePH, todayIsoPH } from '@/lib/constants';
import { formatCurrency, formatDateTime12h } from '@/lib/utils';

// WS-12: void is queued-only now -- once an order is preparing, ready or
// completed, the cashier files a refund request (Order Queue's Refund
// button) that lands here for a manager/executive to approve (voids the
// order, optionally giving the stock back) or reject.
export default function RefundApproval() {
  const { user } = useAuth();
  const [refunds, setRefunds] = useState<ApiRefund[]>([]);
  const [loading, setLoading] = useState(true);
  const [actingId, setActingId] = useState<string | null>(null);
  const [approveTarget, setApproveTarget] = useState<ApiRefund | null>(null);
  const [restoreStock, setRestoreStock] = useState(true);

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

  function openApprove(r: ApiRefund) {
    // A completed order was usually cooked and served; a double punch the
    // kitchen never made is the case for ticking this.
    setRestoreStock(r.kitchen_status !== 'completed');
    setApproveTarget(r);
  }

  async function handleApprove() {
    if (!approveTarget) return;
    const id = approveTarget.id;
    setActingId(id);
    try {
      await approveRefund(id, restoreStock);
      const paidCash = approveTarget.payment_status === 'paid' && approveTarget.payment_method === 'cash';
      toast.success(
        `Refund approved -- order voided${restoreStock ? ' and stock returned' : ''}.` +
          (paidCash ? ' Pay the customer, then record it in Shift Reports → Cash refund.' : ''),
      );
      setApproveTarget(null);
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
                    <div className="space-y-1">
                      <p className="text-sm font-medium flex flex-wrap items-center gap-2">
                        {r.order_number != null ? `#${r.order_number}` : r.transaction_id.slice(0, 8)}
                        {r.total_amount != null && (
                          <span className="text-muted-foreground font-normal">{formatCurrency(r.total_amount)}</span>
                        )}
                        {r.kitchen_status && <Badge variant="outline">{r.kitchen_status}</Badge>}
                        {r.payment_method && (
                          <span className="text-xs text-muted-foreground font-normal">
                            {r.payment_method}
                            {r.payment_status === 'unpaid' ? ' · unpaid' : ''}
                          </span>
                        )}
                      </p>
                      {r.items.length > 0 && <p className="text-xs">{r.items.join(', ')}</p>}
                      <p className="text-sm">
                        <span className="text-muted-foreground">Reason:</span> {r.reason}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {r.opened_at && <>ordered {formatDateTime12h(r.opened_at)}</>}
                        {r.opened_at && toIsoDatePH(r.opened_at) !== todayIsoPH() && (
                          <span className="text-amber-700"> (earlier day)</span>
                        )}
                        {' · '}requested {formatDateTime12h(r.requested_at)}
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
                      <Button size="sm" disabled={actingId === r.id} onClick={() => openApprove(r)}>
                        Approve
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

      <Dialog open={!!approveTarget} onOpenChange={(open) => !open && setApproveTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Approve refund for{' '}
              {approveTarget?.order_number != null ? `#${approveTarget.order_number}` : 'this order'}?
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            The order will be voided{approveTarget?.total_amount != null && ` (${formatCurrency(approveTarget.total_amount)})`}.
            {approveTarget?.payment_status === 'paid' && approveTarget.payment_method === 'cash' &&
              ' If you hand back cash, record it in Shift Reports → Cash refund.'}
          </p>
          <label className="flex items-start gap-3 rounded-md border p-3 cursor-pointer">
            <Checkbox checked={restoreStock} onCheckedChange={(v) => setRestoreStock(v === true)} className="mt-0.5" />
            <span className="text-sm">
              Put the ingredients back in stock (the food wasn't made)
              {approveTarget?.kitchen_status === 'completed' && (
                <span className="block text-xs text-muted-foreground">
                  This order is completed, so the food was probably served. Tick this for a double punch the
                  kitchen didn't make.
                </span>
              )}
            </span>
          </label>
          <DialogFooter>
            <Button variant="outline" onClick={() => setApproveTarget(null)}>
              Cancel
            </Button>
            <Button disabled={actingId === approveTarget?.id} onClick={handleApprove}>
              {actingId === approveTarget?.id ? 'Approving...' : 'Approve refund'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
}
