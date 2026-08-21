import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { DashboardLayout } from '@/components/DashboardLayout';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  ApiDigitalOrder,
  ApiProduct,
  approveDigitalOrder,
  fetchDigitalOrders,
  fetchProducts,
  rejectDigitalOrder,
} from '@/lib/api';
import { formatCurrency } from '@/lib/utils';
import { POLL_INTERVAL_MS } from '@/lib/constants';

export default function PendingOrders() {
  const [orders, setOrders] = useState<ApiDigitalOrder[]>([]);
  const [products, setProducts] = useState<ApiProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [approveTarget, setApproveTarget] = useState<ApiDigitalOrder | null>(null);
  const [rejectTarget, setRejectTarget] = useState<ApiDigitalOrder | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    Promise.all([fetchDigitalOrders('pending'), fetchProducts(true)])
      .then(([o, p]) => {
        setOrders([...o].sort((a, b) => a.order_number - b.order_number));
        setProducts(p);
      })
      .catch((e) => toast.error(`Failed to load pending orders: ${e instanceof Error ? e.message : 'Unknown error'}`))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [load]);

  const sizeIndex = useMemo(() => {
    const map = new Map<string, { product: ApiProduct; size: ApiProduct['sizes'][number] }>();
    for (const product of products) {
      for (const size of product.sizes) {
        map.set(size.id, { product, size });
      }
    }
    return map;
  }, [products]);

  async function handleApprove() {
    if (!approveTarget) return;
    setBusy(true);
    try {
      await approveDigitalOrder(approveTarget.id);
      toast.success(`Order #${approveTarget.order_number} approved`);
      setApproveTarget(null);
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to approve order');
    } finally {
      setBusy(false);
    }
  }

  async function handleReject() {
    if (!rejectTarget) return;
    if (!rejectReason.trim()) {
      toast.error('A decline reason is required');
      return;
    }
    setBusy(true);
    try {
      await rejectDigitalOrder(rejectTarget.id, rejectReason.trim());
      toast.success(`Order #${rejectTarget.order_number} declined`);
      setRejectTarget(null);
      setRejectReason('');
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to decline order');
    } finally {
      setBusy(false);
    }
  }

  return (
    <DashboardLayout title="Pending Orders">
      <div className="p-6 space-y-3">
        {loading && <p className="text-sm text-muted-foreground">Loading pending orders...</p>}
        {!loading && orders.length === 0 && (
          <p className="text-sm text-muted-foreground">No pending digital menu orders.</p>
        )}
        {orders.map((order) => (
          <Card key={order.id}>
            <CardContent className="py-3 space-y-2">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div className="flex items-center gap-2">
                  <span className="font-corp-display text-sm">Order #{order.order_number}</span>
                  <Badge variant="outline">Table {order.table_number}</Badge>
                  <Badge variant="gold">{order.payment_method === 'gcash' ? 'GCash' : 'Cash'}</Badge>
                </div>
                <span className="font-semibold">{formatCurrency(order.subtotal)}</span>
              </div>

              <ul className="text-sm text-muted-foreground space-y-0.5">
                {order.items.map((item) => {
                  const resolved = sizeIndex.get(item.product_size_id);
                  return (
                    <li key={item.id}>
                      {item.quantity}x {resolved ? `${resolved.product.name} (${resolved.size.size_label})` : 'Unknown item'}
                      {item.held_ingredients.length > 0 && (
                        <span className="text-destructive"> -- hold: {item.held_ingredients.join(', ')}</span>
                      )}
                    </li>
                  );
                })}
                {order.addons.map((addon) => (
                  <li key={addon.id}>
                    {addon.quantity}x {addon.addon_name || 'Add-on'}{' '}
                    <span className="text-xs">(add-on, {formatCurrency(addon.unit_price)} ea)</span>
                  </li>
                ))}
              </ul>

              {order.customer_note && (
                <p className="text-sm italic text-muted-foreground">Note: {order.customer_note}</p>
              )}

              <div className="flex items-center gap-2 pt-1">
                <Button size="sm" onClick={() => setApproveTarget(order)}>
                  Approve
                </Button>
                <Button size="sm" variant="destructive" onClick={() => setRejectTarget(order)}>
                  Decline
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Dialog open={!!approveTarget} onOpenChange={(open) => !open && setApproveTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm order #{approveTarget?.order_number}</DialogTitle>
            <DialogDescription>
              Confirm {approveTarget ? formatCurrency(approveTarget.subtotal) : ''} received via{' '}
              {approveTarget?.payment_method === 'gcash' ? 'GCash' : 'Cash'} for Table{' '}
              {approveTarget?.table_number}. This will create the sale and send it to the kitchen.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button disabled={busy} onClick={handleApprove}>
              {busy ? 'Confirming...' : 'Confirm payment received'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!rejectTarget} onOpenChange={(open) => !open && setRejectTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Decline order #{rejectTarget?.order_number}</DialogTitle>
          </DialogHeader>
          <Input
            placeholder="Reason for declining"
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
          />
          <DialogFooter>
            <Button variant="destructive" disabled={busy} onClick={handleReject}>
              {busy ? 'Declining...' : 'Decline order'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
}
