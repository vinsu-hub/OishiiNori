import React, { useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { DashboardLayout } from '@/components/DashboardLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { MapPin } from 'lucide-react';
import { ApiDigitalOrder, ApiProduct, fetchDeliveries, markDeliveryDone } from '@/lib/api';
import { formatCurrency } from '@/lib/utils';
import { POLL_INTERVAL_MS } from '@/lib/constants';
import { useVisiblePolling } from '@/hooks/useVisiblePolling';
import { useProductCatalog } from '@/hooks/useProductCatalog';

// WS-8: the rider's own delivery panel -- current/pending deliveries only,
// each with the order ticket, the customer's own details, and an optional
// Google Maps pin link. "Delivery done" marks it complete; it disappears
// from this list and updates the Delivery Requests tab / Order Queue.
export default function Delivery() {
  const [orders, setOrders] = useState<ApiDigitalOrder[]>([]);
  // Item names just fall back to "Item" below if this fails -- not worth
  // blocking the delivery list over, so productsError is deliberately unused.
  const { products } = useProductCatalog();
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  // "pending" = every undelivered order; "pickup" = the subset the kitchen has
  // marked ready, i.e. food the rider can physically collect and take out now.
  const [tab, setTab] = useState<'pending' | 'pickup'>('pending');

  const load = useCallback(() => {
    fetchDeliveries()
      .then(setOrders)
      .catch((e) => toast.error(e instanceof Error ? e.message : 'Failed to load deliveries'))
      .finally(() => setLoading(false));
  }, []);

  useVisiblePolling(load, POLL_INTERVAL_MS);

  const sizeIndex = useMemo(() => {
    const map = new Map<string, { product: ApiProduct; size: ApiProduct['sizes'][number] }>();
    for (const product of products) {
      for (const size of product.sizes) {
        map.set(size.id, { product, size });
      }
    }
    return map;
  }, [products]);

  const readyCount = useMemo(() => orders.filter((o) => o.kitchen_status === 'ready').length, [orders]);
  const visibleOrders = tab === 'pickup' ? orders.filter((o) => o.kitchen_status === 'ready') : orders;

  async function handleDone(order: ApiDigitalOrder) {
    setBusyId(order.id);
    try {
      await markDeliveryDone(order.id);
      toast.success(`Order #${order.order_number} marked delivered`);
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to mark delivered');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <DashboardLayout title="Delivery">
      <div className="p-6 space-y-3">
        <Tabs value={tab} onValueChange={(v) => setTab(v as 'pending' | 'pickup')}>
          <TabsList>
            <TabsTrigger value="pending">Delivery Pending ({orders.length})</TabsTrigger>
            <TabsTrigger value="pickup">For Pick Up ({readyCount})</TabsTrigger>
          </TabsList>
        </Tabs>
        {loading && <p className="text-sm text-muted-foreground">Loading deliveries...</p>}
        {!loading && visibleOrders.length === 0 && (
          <Card className="max-w-xl">
            <CardHeader>
              <CardTitle className="font-corp-display text-base">
                {tab === 'pickup' ? 'Nothing ready for pick up' : 'No deliveries yet'}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                {tab === 'pickup'
                  ? 'Orders show up here once the kitchen marks them ready.'
                  : 'Current and pending deliveries assigned to you will show up here.'}
              </p>
            </CardContent>
          </Card>
        )}
        {visibleOrders.map((order) => (
          <Card key={order.id} className="max-w-xl">
            <CardContent className="py-3 space-y-2">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <span className="font-corp-display text-sm">
                  Order #{order.order_number}
                  {order.kitchen_status === 'ready' && (
                    <Badge className="ml-2" variant="secondary">Ready</Badge>
                  )}
                </span>
                <span className="font-semibold">
                  {formatCurrency(order.subtotal + (order.delivery?.delivery_fee ?? 0))}
                </span>
              </div>
              {order.delivery && (
                <div className="text-sm">
                  <p className="font-medium">{order.delivery.customer_name}</p>
                  <p className="text-muted-foreground">{order.delivery.customer_phone}</p>
                  <p className="text-muted-foreground">
                    {order.delivery.address}
                    {order.delivery.landmark ? ` (${order.delivery.landmark})` : ''}
                  </p>
                  {order.delivery.barangay && <Badge variant="outline">{order.delivery.barangay}</Badge>}
                  {order.delivery.maps_pin_url && (
                    <a
                      href={order.delivery.maps_pin_url}
                      target="_blank"
                      rel="noreferrer"
                      className="flex items-center gap-1 text-xs text-primary underline underline-offset-2 mt-1"
                    >
                      <MapPin className="w-3 h-3" /> Open in Google Maps
                    </a>
                  )}
                </div>
              )}
              <ul className="text-sm text-muted-foreground space-y-0.5">
                {order.items.map((item) => {
                  const resolved = sizeIndex.get(item.product_size_id);
                  return (
                    <li key={item.id}>
                      {item.quantity}x {resolved ? `${resolved.product.name} (${resolved.size.size_label})` : 'Item'}
                    </li>
                  );
                })}
              </ul>
              <Button size="sm" disabled={busyId === order.id} onClick={() => handleDone(order)}>
                {busyId === order.id ? 'Working...' : 'Delivery done'}
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>
    </DashboardLayout>
  );
}
