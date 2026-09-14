import React, { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ApiDigitalOrder, fetchDeliveries } from '@/lib/api';
import { formatCurrency, formatDateTime12h } from '@/lib/utils';
import { POLL_INTERVAL_MS } from '@/lib/constants';
import { useVisiblePolling } from '@/hooks/useVisiblePolling';

// Admin/executive monitoring view of the rider delivery pipeline -- unlike
// the rider's own Delivery.tsx (an action page, pending-only, no history)
// or Delivery Requests' own "Requests" tab (pre-approval staging), this
// shows the full lifecycle of already-approved delivery orders: out for
// delivery (no delivered_at yet) and completed (delivered_at set, with
// who delivered it and when). Read-only -- nothing here can be actioned,
// only watched; the rider's own page is still where "Delivery done" lives.
export function DeliveryMonitor() {
  const [pending, setPending] = useState<ApiDigitalOrder[]>([]);
  const [completed, setCompleted] = useState<ApiDigitalOrder[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    Promise.all([fetchDeliveries('pending'), fetchDeliveries('completed')])
      .then(([p, c]) => {
        setPending(p);
        setCompleted(
          [...c].sort((a, b) => (b.delivery?.delivered_at ?? '').localeCompare(a.delivery?.delivered_at ?? ''))
        );
      })
      .catch((e) => toast.error(`Failed to load deliveries: ${e instanceof Error ? e.message : 'Unknown error'}`))
      .finally(() => setLoading(false));
  }, []);

  useVisiblePolling(load, POLL_INTERVAL_MS);

  function OrderCard({ order, showCompletion }: { order: ApiDigitalOrder; showCompletion: boolean }) {
    return (
      <Card key={order.id}>
        <CardContent className="py-3 space-y-1">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-2">
              <span className="font-corp-display text-sm">Order #{order.order_number}</span>
              {order.delivery?.barangay && <Badge variant="outline">{order.delivery.barangay}</Badge>}
            </div>
            <span className="font-semibold">
              {formatCurrency(order.subtotal + (order.delivery?.delivery_fee ?? 0))}
            </span>
          </div>
          {order.delivery && (
            <p className="text-sm text-muted-foreground">
              {order.delivery.customer_name} &middot; {order.delivery.customer_phone}
              {order.delivery.address ? ` -- ${order.delivery.address}` : ''}
            </p>
          )}
          {showCompletion && order.delivery?.delivered_at && (
            <p className="text-sm text-muted-foreground">
              Delivered by {order.delivery.rider_name || 'a rider'} at{' '}
              {formatDateTime12h(order.delivery.delivered_at)}
            </p>
          )}
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {loading && <p className="text-sm text-muted-foreground">Loading...</p>}
      {!loading && (
        <>
          <div className="space-y-2">
            <h3 className="font-corp-display text-sm text-muted-foreground">
              Out for delivery ({pending.length})
            </h3>
            {pending.length === 0 && <p className="text-sm text-muted-foreground">Nothing out for delivery.</p>}
            {pending.map((order) => (
              <OrderCard key={order.id} order={order} showCompletion={false} />
            ))}
          </div>

          <div className="space-y-2">
            <h3 className="font-corp-display text-sm text-muted-foreground">
              Completed ({completed.length})
            </h3>
            {completed.length === 0 && <p className="text-sm text-muted-foreground">No completed deliveries yet.</p>}
            {completed.map((order) => (
              <OrderCard key={order.id} order={order} showCompletion />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
