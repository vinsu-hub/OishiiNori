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
  DigitalOrderChannel,
  approveDigitalOrder,
  fetchDigitalOrders,
  rejectDigitalOrder,
} from '@/lib/api';
import { formatCurrency } from '@/lib/utils';
import { POLL_INTERVAL_MS } from '@/lib/constants';
import { useVisiblePolling } from '@/hooks/useVisiblePolling';
import { useProductCatalog } from '@/hooks/useProductCatalog';

// Shared list+approve/decline view for the three digital-order queues that
// share one underlying table (WS-7, Phase 6): the per-table QR flow
// ("Table Orders"), and the two channels fed by the general (non-table)
// ordering link ("Delivery Requests" / "Online Orders"). Approving any of
// them creates a real transaction through the same path (digital_menu.py's
// approve_digital_order), which is what actually reaches Order Queue/
// Kitchen Display -- this page is purely the pre-sale staging queue.
export function DigitalOrdersQueue({
  channel,
  title,
  emptyLabel,
  embedded,
}: {
  channel: DigitalOrderChannel;
  title: string;
  emptyLabel: string;
  // When true, renders just the list+dialogs (no DashboardLayout wrapper)
  // -- for a parent page that supplies its own layout/tabs, same pattern
  // as reservations/RequestsPanel.tsx under Reservations.tsx.
  embedded?: boolean;
}) {
  const [orders, setOrders] = useState<ApiDigitalOrder[]>([]);
  const { products, error: productsError } = useProductCatalog();
  const [loading, setLoading] = useState(true);
  const [detailTarget, setDetailTarget] = useState<ApiDigitalOrder | null>(null);
  const [approveTarget, setApproveTarget] = useState<ApiDigitalOrder | null>(null);
  const [rejectTarget, setRejectTarget] = useState<ApiDigitalOrder | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (productsError) toast.error(`Failed to load products: ${productsError}`);
  }, [productsError]);

  const load = useCallback(() => {
    fetchDigitalOrders('pending')
      .then((o) =>
        setOrders(
          o.filter((order) => order.order_channel === channel).sort((a, b) => a.order_number - b.order_number)
        )
      )
      .catch((e) => toast.error(`Failed to load orders: ${e instanceof Error ? e.message : 'Unknown error'}`))
      .finally(() => setLoading(false));
  }, [channel]);

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
      toast.error('A reason is required');
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

  const content = (
    <>
      <div className={embedded ? 'space-y-3' : 'p-6 space-y-3'}>
        {loading && <p className="text-sm text-muted-foreground">Loading...</p>}
        {!loading && orders.length === 0 && <p className="text-sm text-muted-foreground">{emptyLabel}</p>}
        {orders.map((order) => (
          <Card key={order.id}>
            <CardContent className="py-3 space-y-2">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="font-corp-display text-sm underline-offset-2 hover:underline"
                    onClick={() => setDetailTarget(order)}
                  >
                    Order #{order.order_number}
                  </button>
                  {channel === 'dine_in_qr' && <Badge variant="outline">Table {order.table_number}</Badge>}
                  {channel === 'delivery' && order.delivery?.barangay && (
                    <Badge variant="outline">{order.delivery.barangay}</Badge>
                  )}
                  <Badge variant="gold">{order.payment_method}</Badge>
                  {order.payment_proof_url && <Badge variant="outline">Proof attached</Badge>}
                </div>
                <span className="font-semibold">
                  {formatCurrency(order.subtotal + (order.delivery?.delivery_fee ?? 0))}
                </span>
              </div>

              {order.delivery && (
                <div className="text-sm text-muted-foreground">
                  <p>
                    {order.delivery.customer_name} &middot; {order.delivery.customer_phone}
                  </p>
                  {order.delivery.address && (
                    <p>
                      {order.delivery.address}
                      {order.delivery.landmark ? ` (${order.delivery.landmark})` : ''}
                    </p>
                  )}
                  {order.delivery.delivery_fee != null && (
                    <p>Delivery fee: {formatCurrency(order.delivery.delivery_fee)}</p>
                  )}
                </div>
              )}

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
                  {channel === 'dine_in_qr' ? 'Decline' : 'Delete / Decline'}
                </Button>
                {order.payment_proof_url && (
                  <Button size="sm" variant="outline" onClick={() => setDetailTarget(order)}>
                    Show proof of payment
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Dialog open={!!detailTarget} onOpenChange={(open) => !open && setDetailTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Order #{detailTarget?.order_number}</DialogTitle>
            <DialogDescription>
              {detailTarget
                ? formatCurrency(detailTarget.subtotal + (detailTarget.delivery?.delivery_fee ?? 0))
                : ''}{' '}
              via {detailTarget?.payment_method}
              {channel === 'dine_in_qr'
                ? ` -- Table ${detailTarget?.table_number}`
                : detailTarget?.delivery
                  ? ` -- ${detailTarget.delivery.customer_name}`
                  : ''}
            </DialogDescription>
          </DialogHeader>

          {detailTarget?.delivery && (
            <div className="text-sm text-muted-foreground">
              <p>
                {detailTarget.delivery.customer_name} &middot; {detailTarget.delivery.customer_phone}
              </p>
              {detailTarget.delivery.address && (
                <p>
                  {detailTarget.delivery.address}
                  {detailTarget.delivery.landmark ? ` (${detailTarget.delivery.landmark})` : ''}
                </p>
              )}
              {detailTarget.delivery.delivery_fee != null && (
                <p>Delivery fee: {formatCurrency(detailTarget.delivery.delivery_fee)}</p>
              )}
            </div>
          )}

          {detailTarget && (
            <ul className="text-sm text-muted-foreground space-y-0.5">
              {detailTarget.items.map((item) => {
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
              {detailTarget.addons.map((addon) => (
                <li key={addon.id}>
                  {addon.quantity}x {addon.addon_name || 'Add-on'}{' '}
                  <span className="text-xs">(add-on, {formatCurrency(addon.unit_price)} ea)</span>
                </li>
              ))}
            </ul>
          )}

          {detailTarget?.customer_note && (
            <p className="text-sm italic text-muted-foreground">Note: {detailTarget.customer_note}</p>
          )}

          {detailTarget?.payment_proof_url ? (
            <a href={detailTarget.payment_proof_url} target="_blank" rel="noreferrer">
              <img
                src={detailTarget.payment_proof_url}
                alt="Proof of payment"
                className="max-h-80 w-full rounded-md border object-contain"
              />
            </a>
          ) : (
            detailTarget?.payment_method !== 'cash' && (
              <p className="text-sm text-destructive">No proof of payment was uploaded for this order.</p>
            )
          )}

          <DialogFooter>
            <Button
              variant="destructive"
              onClick={() => {
                const order = detailTarget;
                setDetailTarget(null);
                setRejectTarget(order);
              }}
            >
              {channel === 'dine_in_qr' ? 'Decline' : 'Delete / Decline'}
            </Button>
            <Button
              onClick={() => {
                const order = detailTarget;
                setDetailTarget(null);
                setApproveTarget(order);
              }}
            >
              Approve
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!approveTarget} onOpenChange={(open) => !open && setApproveTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm order #{approveTarget?.order_number}</DialogTitle>
            <DialogDescription>
              Confirm{' '}
              {approveTarget
                ? formatCurrency(approveTarget.subtotal + (approveTarget.delivery?.delivery_fee ?? 0))
                : ''}{' '}
              received via {approveTarget?.payment_method}
              {channel === 'dine_in_qr'
                ? ` for Table ${approveTarget?.table_number}`
                : approveTarget?.delivery
                  ? ` from ${approveTarget.delivery.customer_name}`
                  : ''}
              . This will create the sale and send it to the kitchen{channel !== 'dine_in_qr' ? ' as a takeout order' : ''}.
            </DialogDescription>
          </DialogHeader>
          {approveTarget?.payment_proof_url ? (
            <a href={approveTarget.payment_proof_url} target="_blank" rel="noreferrer">
              <img
                src={approveTarget.payment_proof_url}
                alt="Proof of payment"
                className="max-h-80 w-full rounded-md border object-contain"
              />
            </a>
          ) : (
            approveTarget?.payment_method !== 'cash' && (
              <p className="text-sm text-destructive">
                No proof of payment was uploaded for this order -- verify payment before approving.
              </p>
            )
          )}
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
    </>
  );

  if (embedded) return content;
  return <DashboardLayout title={title}>{content}</DashboardLayout>;
}
