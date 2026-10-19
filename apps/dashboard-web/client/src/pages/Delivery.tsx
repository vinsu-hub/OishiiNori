import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { DashboardLayout } from '@/components/DashboardLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { BellRing, CalendarClock, CheckCircle2, MapPin, PackageCheck, Volume2 } from 'lucide-react';
import { ApiDigitalOrder, ApiProduct, fetchDeliveries, markDeliveryDone } from '@/lib/api';
import { formatCurrency, formatDateTime12h } from '@/lib/utils';
import { useVisiblePolling } from '@/hooks/useVisiblePolling';
import { playRiderReadyAlert, unlockAudio } from '@/lib/orderSounds';

// Riders' phones check this often; GET /deliveries is live-cached server side.
const RIDER_POLL_MS = 15_000;
const ALERTS_KEY = 'rider-delivery-alerts-on';

// Food the rider can collect now: marked ready, or completed straight away
// by the kitchen's "already complete" button but not delivered yet.
function isReadyForPickup(order: ApiDigitalOrder): boolean {
  return order.kitchen_status === 'ready' || order.kitchen_status === 'completed';
}

function alertsSaved(): boolean {
  try {
    return localStorage.getItem(ALERTS_KEY) === '1';
  } catch {
    return false;
  }
}

type WakeLockSentinelLike = { release: () => Promise<void> };
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
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // "pending" = every undelivered order; "pickup" = the subset the kitchen has
  // marked ready, i.e. food the rider can physically collect and take out now.
  const [tab, setTab] = useState<'pending' | 'pickup'>('pending');
  // Alerts need one tap per session (phones block sound until then); the
  // saved flag just remembers the rider wanted them on.
  const [alertsOn, setAlertsOn] = useState(false);
  const wantsAlerts = useRef(alertsSaved());
  const seenReadyRef = useRef<Set<string> | null>(null);
  const wakeLockRef = useRef<WakeLockSentinelLike | null>(null);

  const keepScreenOn = useCallback(async () => {
    try {
      const wakeLock = (navigator as Navigator & { wakeLock?: { request: (type: 'screen') => Promise<WakeLockSentinelLike> } }).wakeLock;
      if (wakeLock && document.visibilityState === 'visible') wakeLockRef.current = await wakeLock.request('screen');
    } catch {
      // Not supported or refused (low battery): alerts still work while the screen is on.
    }
  }, []);

  async function turnOnAlerts() {
    unlockAudio();
    playRiderReadyAlert();
    try {
      if ('Notification' in window && Notification.permission === 'default') await Notification.requestPermission();
    } catch {
      // Older browsers: sound, vibration and the pop-up still work.
    }
    await keepScreenOn();
    try {
      localStorage.setItem(ALERTS_KEY, '1');
    } catch {
      // Storage blocked: they'll just tap again next time.
    }
    wantsAlerts.current = true;
    setAlertsOn(true);
    toast.success('Delivery alerts are on. Keep this page open during your shift.');
  }

  // The wake lock drops whenever the page is hidden; take it again on return.
  useEffect(() => {
    if (!alertsOn) return;
    const onVisible = () => { if (document.visibilityState === 'visible') void keepScreenOn(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      void wakeLockRef.current?.release().catch(() => {});
    };
  }, [alertsOn, keepScreenOn]);

  const announceReady = useCallback((fresh: ApiDigitalOrder[]) => {
    playRiderReadyAlert();
    try {
      navigator.vibrate?.([400, 200, 400, 200, 400]);
    } catch {
      // Vibration isn't available (iPhone, desktop).
    }
    for (const order of fresh) {
      const where = [order.delivery?.address, order.delivery?.barangay].filter(Boolean).join(', ');
      toast(`Order #${order.order_number} is ready for pickup`, {
        description: where || order.delivery?.customer_name || undefined,
        duration: Infinity,
        action: { label: 'Show', onClick: () => setTab('pickup') },
      });
      try {
        if ('Notification' in window && Notification.permission === 'granted') {
          new Notification(`Order #${order.order_number} is ready for pickup`, { body: where, tag: `delivery-ready-${order.id}` });
        }
      } catch {
        // Some phones only allow notifications from an installed app.
      }
    }
  }, []);

  const load = useCallback(() => {
    setError(null);
    fetchDeliveries()
      .then((rows) => {
        const ready = rows.filter(isReadyForPickup);
        const seen = seenReadyRef.current;
        // The first load sets the baseline, so already-ready orders don't ring.
        if (seen && wantsAlerts.current) {
          const fresh = ready.filter((o) => !seen.has(o.id));
          if (fresh.length) announceReady(fresh);
        }
        seenReadyRef.current = new Set(ready.map((o) => o.id));
        setOrders(rows);
      })
      .catch((e) => {
        const message = e instanceof Error ? e.message : 'Failed to load deliveries';
        setError(message);
        toast.error(message);
      })
      .finally(() => setLoading(false));
  }, [announceReady]);

  useVisiblePolling(load, RIDER_POLL_MS, { whileHidden: true });

  const sizeIndex = useMemo(() => {
    const map = new Map<string, { product: ApiProduct; size: ApiProduct['sizes'][number] }>();
    for (const product of products) {
      for (const size of product.sizes) {
        map.set(size.id, { product, size });
      }
    }
    return map;
  }, [products]);

  const readyCount = useMemo(() => orders.filter(isReadyForPickup).length, [orders]);
  const visibleOrders = tab === 'pickup' ? orders.filter(isReadyForPickup) : orders;

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
      <div className="space-y-4 p-4 sm:p-6">
        {alertsOn ? (
          <div className="flex max-w-2xl flex-wrap items-center gap-2 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-900" role="status">
            <BellRing className="size-4" aria-hidden="true" />
            <span className="font-medium">Delivery alerts on</span>
            <span className="text-emerald-800">· keep this page open</span>
            <Button variant="outline" size="sm" className="ml-auto min-h-9 gap-1" onClick={() => playRiderReadyAlert()}>
              <Volume2 className="size-4" aria-hidden="true" /> Test sound
            </Button>
          </div>
        ) : (
          <Card className="max-w-2xl border-2 border-primary">
            <CardContent className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="font-corp-display text-lg font-semibold">Turn on delivery alerts</p>
                <p className="text-sm text-muted-foreground">
                  Your phone will beep, vibrate and show a pop-up when the kitchen marks a delivery ready. Tap once at the start of each shift and keep this page open.
                </p>
              </div>
              <Button className="min-h-12 shrink-0 gap-2 text-base" onClick={() => void turnOnAlerts()}>
                <BellRing aria-hidden="true" /> Turn on alerts
              </Button>
            </CardContent>
          </Card>
        )}
        <Tabs value={tab} onValueChange={(v) => setTab(v as 'pending' | 'pickup')}>
          <TabsList className="h-auto min-h-11 max-w-full overflow-x-auto">
            <TabsTrigger className="min-h-11 px-4" value="pending">Delivery Pending ({orders.length})</TabsTrigger>
            <TabsTrigger className="min-h-11 px-4" value="pickup">For Pick Up ({readyCount})</TabsTrigger>
          </TabsList>
        </Tabs>
        {loading && <p className="text-sm text-muted-foreground" role="status">Loading deliveries…</p>}
        {!loading && error && (
          <Card className="max-w-2xl border-destructive/40">
            <CardContent className="flex flex-col items-start gap-3 py-5 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-destructive">Couldn’t load deliveries. {error}</p>
              <Button className="min-h-11" variant="outline" onClick={load}>Try again</Button>
            </CardContent>
          </Card>
        )}
        {!loading && !error && visibleOrders.length === 0 && (
          <Card className="max-w-2xl border-dashed">
            <CardHeader className="pb-2">
              <PackageCheck className="size-8 text-muted-foreground" aria-hidden="true" />
              <CardTitle className="font-corp-display text-lg">
                {tab === 'pickup' ? 'Nothing ready for pick up' : 'No deliveries yet'}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                {tab === 'pickup'
                  ? 'Orders show up here once the kitchen marks them ready.'
                  : 'Deliveries waiting for a rider show up here.'}
              </p>
            </CardContent>
          </Card>
        )}
        {!error && visibleOrders.map((order) => (
          <Card key={order.id} className="max-w-2xl">
            <CardContent className="space-y-3 py-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="font-corp-display text-lg font-semibold">Order #{order.order_number}</span>
                  {isReadyForPickup(order) && (
                    <Badge className="border-emerald-700/20 bg-emerald-700 text-white">
                      <CheckCircle2 aria-hidden="true" /> Ready
                    </Badge>
                  )}
                  {order.scheduled_for && (
                    <Badge variant="gold">
                      <CalendarClock aria-hidden="true" /> Scheduled {formatDateTime12h(order.scheduled_for)}
                    </Badge>
                  )}
                </div>
                <span className="font-semibold tabular-nums">
                  {formatCurrency(order.subtotal + (order.delivery?.delivery_fee ?? 0))}
                </span>
              </div>
              {order.payment_method?.startsWith('COLLECT CASH') && (
                <p className="rounded-md bg-primary px-3 py-2 text-center font-bold text-primary-foreground">
                  Collect {formatCurrency(order.subtotal + (order.delivery?.delivery_fee ?? 0))} cash — bring it back to the cashier
                </p>
              )}
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
                    className="mt-1 inline-flex min-h-11 items-center gap-2 rounded-md text-sm font-medium text-primary underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                      <MapPin className="size-4" aria-hidden="true" /> Open in Google Maps
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
              <Button
                className="min-h-12 w-full text-base sm:w-auto sm:min-w-44"
                disabled={busyId === order.id}
                onClick={() => handleDone(order)}
              >
                <CheckCircle2 aria-hidden="true" />
                {busyId === order.id ? 'Marking delivered…' : 'Delivery done'}
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>
    </DashboardLayout>
  );
}
