import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { DashboardLayout } from '@/components/DashboardLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Progress } from '@/components/ui/progress';
import { Volume2, VolumeX } from 'lucide-react';
import { BundleFulfillmentChecklist } from '@/components/kitchen/BundleFulfillmentChecklist';
import {
  ApiDigitalOrder,
  ApiProduct,
  ApiProductSize,
  ApiTransaction,
  ApiTransactionItem,
  KitchenStation,
  KitchenStatus,
  fetchDigitalOrders,
  fetchProducts,
  fetchTransactions,
  updateKitchenStatus,
} from '@/lib/api';
import { POLL_INTERVAL_MS, toIsoDatePH, todayIsoPH } from '@/lib/constants';
import { buildDigitalOrderLookup } from '@/lib/digitalOrderLookup';
import { DigitalOrderInfo } from '@/components/shared/DigitalOrderInfo';
import { playNewOrderBeep } from '@/lib/orderSounds';

const KITCHEN_STATUSES: KitchenStatus[] = ['queued', 'preparing', 'ready', 'completed'];

const STATUS_LABEL: Record<KitchenStatus, string> = {
  queued: 'Queued',
  preparing: 'Preparing',
  ready: 'Ready',
  completed: 'Completed',
};

const NEXT_STATUS: Record<KitchenStatus, KitchenStatus | null> = {
  queued: 'preparing',
  preparing: 'ready',
  ready: 'completed',
  completed: null,
};

const ACTION_LABEL: Record<KitchenStatus, string> = {
  queued: 'Accept',
  preparing: 'Mark Ready',
  ready: 'Complete',
  completed: '',
};

const STATIONS: { value: KitchenStation; label: string }[] = [
  { value: 'sushi_bar', label: 'Sushi Bar' },
  { value: 'sushi_bar_oven', label: 'Sushi Bar / Oven' },
  { value: 'hot_line', label: 'Hot Line' },
  { value: 'salad_cold_bar', label: 'Salad / Cold Bar' },
  { value: 'cafe_bar', label: 'Cafe Bar' },
];

const ROLL_CATEGORY = 'Oishii Maki Rolls';

// Hardcoded starting points (SMFC's own defaults), not per-branch
// configurable -- a settings surface for these is a reasonable future
// addition, not required now. "completed" never counts as delayed.
const DELAYED_THRESHOLD_SECONDS: Partial<Record<KitchenStatus, number>> = {
  queued: 15 * 60,
  preparing: 15 * 60,
  ready: 10 * 60,
};

function elapsedSeconds(since: string, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - new Date(since).getTime()) / 1000));
}

function elapsedLabel(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

interface ResolvedItem {
  item: ApiTransactionItem;
  product: ApiProduct;
  size: ApiProductSize;
}

interface ChecklistTarget {
  transactionId: string;
  item: ApiTransactionItem;
  product: ApiProduct;
  size: ApiProductSize;
}

export default function KitchenDisplay() {
  const [transactions, setTransactions] = useState<ApiTransaction[]>([]);
  const [products, setProducts] = useState<ApiProduct[]>([]);
  const [digitalOrderLookup, setDigitalOrderLookup] = useState<Map<string, ApiDigitalOrder>>(new Map());
  const [loading, setLoading] = useState(true);
  const [stationFilter, setStationFilter] = useState<KitchenStation | 'all'>('all');
  const [fulfilledItemIds, setFulfilledItemIds] = useState<Set<string>>(new Set());
  const [checklistTarget, setChecklistTarget] = useState<ChecklistTarget | null>(null);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());
  const [soundOn, setSoundOn] = useState(true);
  const seenQueuedIdsRef = useRef<Set<string> | null>(null);

  // Separate 1s tick (elapsed-time labels/progress bars) from the 20s data
  // poll -- ticking doesn't need a network round trip.
  useEffect(() => {
    const tick = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(tick);
  }, []);

  const load = useCallback(() => {
    Promise.all([fetchTransactions(), fetchProducts(true), fetchDigitalOrders('approved')])
      .then(([t, p, digitalOrders]) => {
        setTransactions(t.filter((x) => x.status !== 'voided'));
        setProducts(p);
        setDigitalOrderLookup(buildDigitalOrderLookup(digitalOrders));
        // Bundle fulfillment is a real backend field now (bundle_fulfillments
        // is the source of truth) -- re-seed from every poll so a reload (or
        // another terminal's action) is reflected, not just this session's
        // own optimistic updates via onFulfilled below.
        setFulfilledItemIds((prev) => {
          const next = new Set(prev);
          for (const tx of t) {
            for (const item of tx.items) {
              if (item.bundle_fulfilled) next.add(item.id);
            }
          }
          return next;
        });

        // Chime on any order newly seen in "queued" -- skip entirely on the
        // very first load (ref starts null) so opening the page doesn't
        // chime for every already-queued order.
        const queuedIds = new Set(t.filter((tx) => tx.kitchen_status === 'queued').map((tx) => tx.id));
        if (seenQueuedIdsRef.current) {
          const isNew = Array.from(queuedIds).some((id) => !seenQueuedIdsRef.current!.has(id));
          if (isNew && soundOn) playNewOrderBeep();
        }
        seenQueuedIdsRef.current = queuedIds;
      })
      .catch((e) => toast.error(`Failed to load kitchen display: ${e instanceof Error ? e.message : 'Unknown error'}`))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [soundOn]);

  useEffect(() => {
    load();
    const interval = setInterval(load, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [load]);

  const sizeIndex = useMemo(() => {
    const map = new Map<string, { product: ApiProduct; size: ApiProductSize }>();
    for (const product of products) {
      for (const size of product.sizes) {
        map.set(size.id, { product, size });
      }
    }
    return map;
  }, [products]);

  const eligibleRolls = useMemo(
    () => products.filter((p) => p.category === ROLL_CATEGORY && !p.is_bundle),
    [products]
  );

  function resolveItems(order: ApiTransaction): ResolvedItem[] {
    return order.items
      .map((item) => {
        const resolved = sizeIndex.get(item.product_size_id);
        return resolved ? { item, product: resolved.product, size: resolved.size } : null;
      })
      .filter((x): x is ResolvedItem => x !== null);
  }

  const visibleOrders = useMemo(() => {
    if (stationFilter === 'all') return transactions;
    return transactions.filter((order) =>
      resolveItems(order).some((r) => r.product.station === stationFilter)
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transactions, stationFilter, sizeIndex]);

  const ordersByStatus = useMemo(() => {
    const map: Record<KitchenStatus, ApiTransaction[]> = { queued: [], preparing: [], ready: [], completed: [] };
    for (const order of visibleOrders) {
      map[order.kitchen_status].push(order);
    }
    return map;
  }, [visibleOrders]);

  const delayedCount = useMemo(() => {
    let count = 0;
    for (const order of visibleOrders) {
      const threshold = DELAYED_THRESHOLD_SECONDS[order.kitchen_status];
      if (threshold != null && elapsedSeconds(order.kitchen_status_updated_at || order.opened_at, now) > threshold) {
        count += 1;
      }
    }
    return count;
  }, [visibleOrders, now]);

  // Client-side approximation (no per-order "time entered preparing" field
  // exists) -- opened_at to kitchen_status_updated_at across today's
  // (Philippines-local calendar day, not UTC) completed orders, as a rough
  // "how long an order takes end to end" stand-in for a glance-at-the-board
  // metric. SMFC computes a true prep-time from a dedicated backend summary
  // endpoint; this avoids adding one, at the cost of precision. Unlike
  // delayedCount/longestOrder below (deliberately NOT date-scoped -- a
  // stuck order from yesterday should still count as delayed on the live
  // board), this metric's own label claims "today", so it has to actually
  // filter to today or it's misleading.
  const avgPrepSeconds = useMemo(() => {
    const today = todayIsoPH();
    const completed = visibleOrders.filter(
      (o) => o.kitchen_status === 'completed' && o.kitchen_status_updated_at && toIsoDatePH(o.opened_at) === today
    );
    if (completed.length === 0) return null;
    const total = completed.reduce((sum, o) => sum + elapsedSeconds(o.opened_at, new Date(o.kitchen_status_updated_at!)), 0);
    return Math.round(total / completed.length);
  }, [visibleOrders]);

  const longestOrder = useMemo(() => {
    const active = visibleOrders.filter((o) => o.kitchen_status !== 'completed');
    if (active.length === 0) return null;
    return active.reduce((longest, o) =>
      elapsedSeconds(o.opened_at, now) > elapsedSeconds(longest.opened_at, now) ? o : longest
    );
  }, [visibleOrders, now]);

  async function handleAdvance(order: ApiTransaction) {
    const next = NEXT_STATUS[order.kitchen_status];
    if (!next) return;
    setUpdatingId(order.id);
    try {
      await updateKitchenStatus(order.id, next);
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to update order');
    } finally {
      setUpdatingId(null);
    }
  }

  return (
    <DashboardLayout title="Kitchen Display">
      <div className="p-6 space-y-4">
        <div className="flex items-center justify-between">
          <div className="grid grid-cols-4 gap-3 flex-1 mr-4">
            {KITCHEN_STATUSES.map((status) => (
              <Card key={status}>
                <CardContent className="py-3">
                  <p className="text-xs text-muted-foreground">{STATUS_LABEL[status]}</p>
                  <p className="text-2xl font-semibold">{ordersByStatus[status].length}</p>
                </CardContent>
              </Card>
            ))}
          </div>
          <Select value={stationFilter} onValueChange={(v) => setStationFilter(v as KitchenStation | 'all')}>
            <SelectTrigger className="w-56">
              <SelectValue placeholder="All stations" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All stations</SelectItem>
              {STATIONS.map((s) => (
                <SelectItem key={s.value} value={s.value}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="icon"
            variant="outline"
            className="ml-2"
            onClick={() => setSoundOn((v) => !v)}
            aria-label={soundOn ? 'Mute new-order sound' : 'Unmute new-order sound'}
            title={soundOn ? 'Mute new-order sound' : 'Unmute new-order sound'}
          >
            {soundOn ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}
          </Button>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <Card>
            <CardContent className="py-3">
              <p className="text-xs text-muted-foreground">Delayed</p>
              <p className="text-2xl font-semibold text-destructive">{delayedCount}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="py-3">
              <p className="text-xs text-muted-foreground">Avg prep time</p>
              <p className="text-2xl font-semibold">{avgPrepSeconds != null ? elapsedLabel(avgPrepSeconds) : '--'}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="py-3">
              <p className="text-xs text-muted-foreground">Longest order</p>
              <p className="text-2xl font-semibold">
                {longestOrder ? `${longestOrder.id.slice(0, 8)} (${elapsedLabel(elapsedSeconds(longestOrder.opened_at, now))})` : '--'}
              </p>
            </CardContent>
          </Card>
        </div>

        {loading && <p className="text-sm text-muted-foreground">Loading kitchen display...</p>}

        {!loading && (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
            {KITCHEN_STATUSES.map((status) => (
              <div key={status} className="space-y-3">
                <h3 className="font-corp-display font-semibold text-sm text-muted-foreground">
                  {STATUS_LABEL[status]} ({ordersByStatus[status].length})
                </h3>
                {ordersByStatus[status].map((order) => {
                  const resolved = resolveItems(order);
                  const bundleItems = resolved.filter((r) => r.product.is_bundle);
                  const hasUnfulfilledBundle = bundleItems.some((r) => !fulfilledItemIds.has(r.item.id));
                  const next = NEXT_STATUS[order.kitchen_status];
                  const blockedByBundle = next === 'completed' && hasUnfulfilledBundle;
                  const digitalOrder = digitalOrderLookup.get(order.id);

                  return (
                    <Card key={order.id}>
                      <CardHeader className="pb-2">
                        <CardTitle className="text-sm flex items-center gap-2 flex-wrap">
                          <span className="font-mono text-xs text-muted-foreground">{order.id.slice(0, 8)}</span>
                          {order.is_owner_request && <Badge variant="secondary">Owner's Request</Badge>}
                        </CardTitle>
                        <p className="text-xs text-muted-foreground">
                          opened {new Date(order.opened_at).toLocaleTimeString()} &middot;{' '}
                          <span
                            className={
                              DELAYED_THRESHOLD_SECONDS[order.kitchen_status] != null &&
                              elapsedSeconds(order.kitchen_status_updated_at || order.opened_at, now) >
                                DELAYED_THRESHOLD_SECONDS[order.kitchen_status]!
                                ? 'text-destructive font-medium'
                                : undefined
                            }
                          >
                            {elapsedLabel(elapsedSeconds(order.opened_at, now))} elapsed
                          </span>
                        </p>
                        {status === 'preparing' && avgPrepSeconds != null && avgPrepSeconds > 0 && (
                          <Progress
                            value={Math.min(
                              100,
                              (elapsedSeconds(order.kitchen_status_updated_at || order.opened_at, now) / avgPrepSeconds) * 100
                            )}
                            className="h-1.5"
                          />
                        )}
                        {digitalOrder && <DigitalOrderInfo order={digitalOrder} />}
                      </CardHeader>
                      <CardContent className="space-y-2 pb-3">
                        <ul className="space-y-1 text-sm">
                          {resolved.map(({ item, product, size }) => {
                            const fulfilled = fulfilledItemIds.has(item.id);
                            return (
                              <li key={item.id} className="space-y-0.5">
                              <div className="flex items-center justify-between gap-2">
                                <span>
                                  {item.quantity}x {product.name} ({size.size_label})
                                </span>
                                {product.is_bundle &&
                                  (fulfilled ? (
                                    <Badge variant="default">Logged</Badge>
                                  ) : (
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      onClick={() =>
                                        setChecklistTarget({ transactionId: order.id, item, product, size })
                                      }
                                    >
                                      Log rolls used
                                    </Button>
                                  ))}
                              </div>
                              {item.held_ingredients.length > 0 && (
                                <p className="text-xs text-destructive">-- hold: {item.held_ingredients.join(', ')}</p>
                              )}
                              </li>
                            );
                          })}
                        </ul>

                        {next && (
                          <Button
                            className="w-full"
                            size="sm"
                            disabled={updatingId === order.id || blockedByBundle}
                            title={blockedByBundle ? 'Log rolls used for every bundle item first' : undefined}
                            onClick={() => handleAdvance(order)}
                          >
                            {blockedByBundle ? 'Fulfill bundle first' : ACTION_LABEL[order.kitchen_status]}
                          </Button>
                        )}
                      </CardContent>
                    </Card>
                  );
                })}
                {ordersByStatus[status].length === 0 && (
                  <p className="text-xs text-muted-foreground">No orders.</p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {checklistTarget && (
        <BundleFulfillmentChecklist
          open={!!checklistTarget}
          onOpenChange={(open) => !open && setChecklistTarget(null)}
          transactionId={checklistTarget.transactionId}
          itemId={checklistTarget.item.id}
          bundleProduct={checklistTarget.product}
          bundleSize={checklistTarget.size}
          itemQuantity={checklistTarget.item.quantity}
          eligibleRolls={eligibleRolls}
          onFulfilled={() =>
            setFulfilledItemIds((prev) => new Set(prev).add(checklistTarget.item.id))
          }
        />
      )}
    </DashboardLayout>
  );
}
