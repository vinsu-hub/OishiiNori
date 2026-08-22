import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { DashboardLayout } from '@/components/DashboardLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
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
import { POLL_INTERVAL_MS } from '@/lib/constants';
import { buildDigitalOrderLookup } from '@/lib/digitalOrderLookup';
import { DigitalOrderInfo } from '@/components/shared/DigitalOrderInfo';

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
      })
      .catch((e) => toast.error(`Failed to load kitchen display: ${e instanceof Error ? e.message : 'Unknown error'}`))
      .finally(() => setLoading(false));
  }, []);

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
                          opened {new Date(order.opened_at).toLocaleTimeString()}
                        </p>
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
