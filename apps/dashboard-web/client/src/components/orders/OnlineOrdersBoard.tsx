import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Banknote, Bike, CalendarClock, Gift, PackageCheck, ShoppingBag } from 'lucide-react';
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
  type ApiDigitalOrder,
  type ApiProduct,
  type DigitalBoardStage,
  apiErrorDetail,
  approveDigitalOrder,
  fetchBusinessSettings,
  fetchDigitalBoard,
  completeOnlineOrder,
  fetchTransaction,
  rejectDigitalOrder,
} from '@/lib/api';
import { formatCurrency, formatTimestamp12h } from '@/lib/utils';
import { POLL_INTERVAL_MS } from '@/lib/constants';
import { useVisiblePolling } from '@/hooks/useVisiblePolling';
import { useProductCatalog } from '@/hooks/useProductCatalog';
import { useAuth } from '@/contexts/AuthContext';
import {
  ReceiptDialog,
  receiptBusinessFromSettings,
  type ReceiptBusiness,
  type ReceiptData,
} from '@/components/pos/Receipt';

const STAGES: { key: DigitalBoardStage; label: string }[] = [
  { key: 'pending', label: 'Pending' },
  { key: 'in_queue', label: 'In queue' },
  { key: 'out_for_delivery', label: 'Out / ready for pickup' },
  { key: 'completed', label: 'Completed' },
];

type SizeIndex = Map<string, { product: ApiProduct; size: ApiProduct['sizes'][number] }>;

function orderTotal(order: ApiDigitalOrder): number {
  return order.subtotal + (order.packaging_fee ?? 0) + (order.delivery?.delivery_fee ?? 0);
}

function orderNumber(order: ApiDigitalOrder): string {
  return order.pos_order_number != null ? `#${order.pos_order_number}` : `Online #${order.order_number}`;
}

function kitchenLabel(order: ApiDigitalOrder): string | null {
  switch (order.kitchen_status) {
    case 'queued':
      return 'Waiting in kitchen';
    case 'preparing':
      return 'Preparing';
    case 'ready':
      return order.order_channel === 'delivery' ? 'Ready for rider' : 'Ready for pickup';
    case 'completed':
      return order.order_channel === 'delivery' ? 'With the rider' : 'Picked up';
    default:
      return order.status === 'approved' ? 'Confirmed · goes to the kitchen on schedule' : null;
  }
}

function needsCash(order: ApiDigitalOrder): boolean {
  return order.payment_status === 'unpaid';
}

function paymentLabel(method: string): string {
  return method === 'cash' ? 'Cash on delivery/pickup' : method;
}

/** Order Queue → Online: website delivery/pickup orders, by stage. */
export function OnlineOrdersBoard({ onPendingCount }: { onPendingCount?: (count: number) => void }) {
  const { user } = useAuth();
  const { products } = useProductCatalog();
  const [orders, setOrders] = useState<ApiDigitalOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [stage, setStage] = useState<DigitalBoardStage>('pending');
  const [reviewTarget, setReviewTarget] = useState<ApiDigitalOrder | null>(null);
  const [declining, setDeclining] = useState(false);
  const [declineReason, setDeclineReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<ReceiptData | null>(null);
  const [business, setBusiness] = useState<ReceiptBusiness | null>(null);
  const [completeTarget, setCompleteTarget] = useState<ApiDigitalOrder | null>(null);
  const [cashReceived, setCashReceived] = useState('');

  useEffect(() => {
    fetchBusinessSettings().then((s) => setBusiness(receiptBusinessFromSettings(s))).catch(() => {});
  }, []);

  const load = useCallback(() => {
    fetchDigitalBoard()
      .then(setOrders)
      .catch((e) => toast.error(apiErrorDetail(e, 'Failed to load online orders')))
      .finally(() => setLoading(false));
  }, []);
  useVisiblePolling(load, POLL_INTERVAL_MS);

  const sizeIndex: SizeIndex = useMemo(() => {
    const map: SizeIndex = new Map();
    for (const product of products) for (const size of product.sizes) map.set(size.id, { product, size });
    return map;
  }, [products]);

  const byStage = useMemo(() => {
    const groups: Record<DigitalBoardStage, ApiDigitalOrder[]> = {
      pending: [], in_queue: [], out_for_delivery: [], completed: [],
    };
    for (const order of orders) if (order.stage) groups[order.stage].push(order);
    // Oldest first while it still needs work; newest first once done.
    groups.pending.sort((a, b) => a.created_at.localeCompare(b.created_at));
    groups.in_queue.sort((a, b) => a.created_at.localeCompare(b.created_at));
    groups.out_for_delivery.sort((a, b) => a.created_at.localeCompare(b.created_at));
    groups.completed.sort((a, b) => b.created_at.localeCompare(a.created_at));
    return groups;
  }, [orders]);

  useEffect(() => {
    onPendingCount?.(byStage.pending.length);
  }, [byStage.pending.length, onPendingCount]);

  function itemName(sizeId: string): string {
    const resolved = sizeIndex.get(sizeId);
    return resolved ? `${resolved.product.name} (${resolved.size.size_label})` : 'Item';
  }

  /** Customer receipt for an approved order, built from its new transaction. */
  async function buildReceipt(order: ApiDigitalOrder, transactionId: string): Promise<ReceiptData> {
    const tx = await fetchTransaction(transactionId);
    const deliveryFee = order.delivery?.delivery_fee ?? 0;
    const lines: ReceiptData['lines'] = tx.items.map((item) => ({
      name: itemName(item.product_size_id),
      quantity: item.quantity,
      unitPrice: item.unit_price,
      addons: [],
    }));
    for (const addon of order.addons) {
      lines.push({ name: addon.addon_name || 'Add-on', quantity: addon.quantity, unitPrice: addon.unit_price, addons: [] });
    }
    if ((order.packaging_fee ?? 0) > 0) {
      lines.push({ name: 'Take-out bowl', quantity: 1, unitPrice: order.packaging_fee ?? 0, addons: [] });
    }
    const cash = order.payment_method === 'cash';
    return {
      orderNumber: tx.order_number,
      openedAt: tx.opened_at,
      orderType: tx.order_type,
      tableNumber: null,
      lines,
      discountAmount: 0,
      taxAmount: tx.tax_amount,
      deliveryFee,
      totalAmount: tx.total_amount,
      paymentMethod: order.payment_method,
      delivery: order.order_channel === 'delivery' && order.delivery
        ? {
            customerName: order.delivery.customer_name,
            phone: order.delivery.customer_phone,
            address: order.delivery.address,
            barangay: order.delivery.barangay,
          }
        : null,
      business: business ?? { name: null, address: null, phone: null, tin: null, footer: null },
      cashierName: user?.name ?? null,
      reference: tx.id.slice(0, 8).toUpperCase(),
      subtotal: lines.reduce((sum, line) => sum + line.unitPrice * line.quantity, 0),
      discountLabel: null,
      vatExempt: false,
      cashTendered: null,
      changeDue: null,
      itemCount: tx.items.reduce((sum, item) => sum + item.quantity, 0),
      payOnDelivery: cash && order.order_channel === 'delivery',
      payOnPickup: cash && order.order_channel === 'pickup',
      scheduledFor: order.scheduled_for ?? null,
      pickupCustomerName: order.order_channel === 'pickup' ? order.delivery?.customer_name ?? null : null,
      pickupCustomerPhone: order.order_channel === 'pickup' ? order.delivery?.customer_phone ?? null : null,
    };
  }

  async function approve(order: ApiDigitalOrder) {
    setBusy(true);
    try {
      const approved = await approveDigitalOrder(order.id);
      setReviewTarget(null);
      if (approved.transaction_id) {
        toast.success(`${orderNumber(order)} approved — sent to the kitchen`);
        // The preview opens with a Print button: printing must happen inside a tap.
        setReceipt(await buildReceipt(order, approved.transaction_id));
      } else {
        toast.success(`${orderNumber(order)} confirmed — it goes to the kitchen before the requested time`);
      }
      load();
    } catch (e) {
      toast.error(apiErrorDetail(e, 'Could not approve the order'));
    } finally {
      setBusy(false);
    }
  }

  async function decline(order: ApiDigitalOrder) {
    if (!declineReason.trim()) {
      toast.error('Enter a reason for declining');
      return;
    }
    setBusy(true);
    try {
      await rejectDigitalOrder(order.id, declineReason.trim());
      toast.success(`${orderNumber(order)} declined`);
      setReviewTarget(null);
      setDeclining(false);
      setDeclineReason('');
      load();
    } catch (e) {
      toast.error(apiErrorDetail(e, 'Could not decline the order'));
    } finally {
      setBusy(false);
    }
  }

  async function complete(order: ApiDigitalOrder) {
    setBusy(true);
    try {
      await completeOnlineOrder(order.id);
      toast.success(needsCash(order)
        ? `${orderNumber(order)} — ${formatCurrency(orderTotal(order))} cash logged, order completed`
        : `${orderNumber(order)} completed`);
      setCompleteTarget(null);
      load();
    } catch (e) {
      toast.error(apiErrorDetail(e, 'Could not complete the order'));
    } finally {
      setBusy(false);
    }
  }

  const completeDue = completeTarget ? orderTotal(completeTarget) : 0;
  const cashNumber = Number(cashReceived);
  const changeDue = cashReceived.trim() && Number.isFinite(cashNumber) ? cashNumber - completeDue : null;

  const visible = byStage[stage];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Online order stage">
        {STAGES.map((s) => (
          <Button
            key={s.key}
            role="tab"
            aria-selected={stage === s.key}
            variant={stage === s.key ? 'default' : 'outline'}
            className="min-h-10 gap-2"
            onClick={() => setStage(s.key)}
          >
            {s.label}
            <span className={`rounded-full px-2 text-xs ${stage === s.key ? 'bg-primary-foreground/20' : 'bg-muted'}`}>
              {byStage[s.key].length}
            </span>
          </Button>
        ))}
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading online orders…</p>
      ) : visible.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          {stage === 'pending' ? 'No online orders waiting for review.' : 'Nothing here right now.'}
        </p>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
          {visible.map((order) => {
            const promo = order.items.some((item) => item.is_promo);
            const status = kitchenLabel(order);
            return (
              <Card key={order.id} className={order.stage === 'pending' ? 'border-2 border-amber-400' : ''}>
                <CardContent className="space-y-2 py-4">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="text-lg font-bold">{orderNumber(order)}</p>
                      <p className="text-xs text-muted-foreground">{formatTimestamp12h(order.created_at)}</p>
                    </div>
                    <p className="text-xl font-bold">{formatCurrency(orderTotal(order))}</p>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <Badge variant="outline" className="gap-1">
                      {order.order_channel === 'delivery' ? <Bike className="h-3.5 w-3.5" aria-hidden /> : <ShoppingBag className="h-3.5 w-3.5" aria-hidden />}
                      {order.order_channel === 'delivery' ? 'Delivery' : 'Pickup'}
                    </Badge>
                    {order.scheduled_for && (
                      <Badge variant="secondary" className="gap-1">
                        <CalendarClock className="h-3.5 w-3.5" aria-hidden /> {formatTimestamp12h(order.scheduled_for)}
                      </Badge>
                    )}
                    {promo && (
                      <Badge className="gap-1 bg-green-600 text-white hover:bg-green-600">
                        <Gift className="h-3.5 w-3.5" aria-hidden /> FREE first-order maki
                      </Badge>
                    )}
                    {status && <Badge variant="outline">{status}</Badge>}
                    {order.stage !== 'pending' && needsCash(order) && (
                      <Badge variant="destructive" className="gap-1">
                        <Banknote className="h-3.5 w-3.5" aria-hidden /> Unpaid · Cash
                      </Badge>
                    )}
                  </div>
                  {order.delivery && (
                    <div className="text-sm">
                      <p className="font-medium">{order.delivery.customer_name}</p>
                      <a className="text-muted-foreground underline-offset-2 hover:underline" href={`tel:${order.delivery.customer_phone}`}>
                        {order.delivery.customer_phone}
                      </a>
                      {order.order_channel === 'delivery' && (
                        <p className="text-muted-foreground">
                          {[order.delivery.address, order.delivery.barangay].filter(Boolean).join(', ')}
                        </p>
                      )}
                    </div>
                  )}
                  <p className="text-xs text-muted-foreground">Payment: {paymentLabel(order.payment_method)}</p>
                  {order.stage === 'pending' && (
                    <Button className="w-full min-h-11" onClick={() => { setDeclining(false); setDeclineReason(''); setReviewTarget(order); }}>
                      Review order
                    </Button>
                  )}
                  {/* Not while the kitchen is still cooking: closing the ticket clears it from the Kitchen Display. */}
                  {(order.stage === 'out_for_delivery' || (order.stage === 'in_queue' && order.kitchen_status === 'ready')) && order.pos_order_number != null && (
                    <Button
                      className="w-full min-h-11 gap-2"
                      variant={order.stage === 'out_for_delivery' ? 'default' : 'outline'}
                      onClick={() => { setCashReceived(''); setCompleteTarget(order); }}
                    >
                      {needsCash(order)
                        ? <><Banknote className="h-4 w-4" aria-hidden /> Cash received &amp; complete</>
                        : <><PackageCheck className="h-4 w-4" aria-hidden /> Complete order</>}
                    </Button>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <Dialog open={!!reviewTarget} onOpenChange={(open) => !open && setReviewTarget(null)}>
        <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto">
          {reviewTarget && (
            <>
              <DialogHeader>
                <DialogTitle>
                  Review {orderNumber(reviewTarget)} · {reviewTarget.order_channel === 'delivery' ? 'Delivery' : 'Pickup'}
                </DialogTitle>
                <DialogDescription>
                  Check the order and payment, then approve to send it to the kitchen and print the customer slip.
                </DialogDescription>
              </DialogHeader>
              {reviewTarget.delivery && (
                <div className="text-sm">
                  <p className="font-medium">{reviewTarget.delivery.customer_name} · {reviewTarget.delivery.customer_phone}</p>
                  {reviewTarget.order_channel === 'delivery' && (
                    <p className="text-muted-foreground">
                      {[reviewTarget.delivery.address, reviewTarget.delivery.barangay].filter(Boolean).join(', ')}
                      {reviewTarget.delivery.landmark ? ` (${reviewTarget.delivery.landmark})` : ''}
                    </p>
                  )}
                </div>
              )}
              {reviewTarget.scheduled_for && (
                <p className="text-sm font-medium">Requested for {formatTimestamp12h(reviewTarget.scheduled_for)}</p>
              )}
              <ul className="space-y-1 text-sm">
                {reviewTarget.items.map((item) => (
                  <li key={item.id} className="flex justify-between gap-3">
                    <span>
                      {item.quantity}x {itemName(item.product_size_id)}
                      {item.held_ingredients.length > 0 && (
                        <span className="text-destructive"> — hold: {item.held_ingredients.join(', ')}</span>
                      )}
                      {item.is_promo && <Badge className="ml-2 bg-green-600 text-white hover:bg-green-600">FREE · first online order today</Badge>}
                    </span>
                    <span className="tabular-nums">{item.is_promo ? 'FREE' : formatCurrency(item.unit_price * item.quantity)}</span>
                  </li>
                ))}
                {reviewTarget.addons.map((addon) => (
                  <li key={addon.id} className="flex justify-between gap-3">
                    <span>{addon.quantity}x {addon.addon_name || 'Add-on'}</span>
                    <span className="tabular-nums">{formatCurrency(addon.unit_price * addon.quantity)}</span>
                  </li>
                ))}
              </ul>
              <div className="space-y-0.5 border-t pt-2 text-sm">
                {(reviewTarget.packaging_fee ?? 0) > 0 && (
                  <p className="flex justify-between"><span>Take-out bowls</span><span>{formatCurrency(reviewTarget.packaging_fee ?? 0)}</span></p>
                )}
                {(reviewTarget.delivery?.delivery_fee ?? 0) > 0 && (
                  <p className="flex justify-between"><span>Delivery fee</span><span>{formatCurrency(reviewTarget.delivery?.delivery_fee ?? 0)}</span></p>
                )}
                <p className="flex justify-between font-bold"><span>Total</span><span>{formatCurrency(orderTotal(reviewTarget))}</span></p>
                <p className="text-muted-foreground">Payment: {paymentLabel(reviewTarget.payment_method)}</p>
              </div>
              {reviewTarget.customer_note && (
                <p className="text-sm italic text-muted-foreground">Note: {reviewTarget.customer_note}</p>
              )}
              {reviewTarget.payment_proof_url ? (
                <a href={reviewTarget.payment_proof_url} target="_blank" rel="noreferrer">
                  <img src={reviewTarget.payment_proof_url} alt="Proof of payment" className="max-h-72 w-full rounded-md border object-contain" />
                </a>
              ) : reviewTarget.payment_method !== 'cash' ? (
                <p className="text-sm text-destructive">No proof of payment was uploaded for this order.</p>
              ) : null}
              {declining && (
                <div className="space-y-1">
                  <label htmlFor="decline-reason" className="text-sm font-medium">Reason for declining</label>
                  <Input
                    id="decline-reason"
                    value={declineReason}
                    maxLength={300}
                    onChange={(e) => setDeclineReason(e.target.value)}
                    placeholder="e.g. out of stock, outside delivery area"
                  />
                </div>
              )}
              <DialogFooter className="gap-2">
                {declining ? (
                  <>
                    <Button variant="outline" onClick={() => setDeclining(false)} disabled={busy}>Back</Button>
                    <Button variant="destructive" onClick={() => decline(reviewTarget)} disabled={busy || !declineReason.trim()}>
                      {busy ? 'Declining…' : 'Decline order'}
                    </Button>
                  </>
                ) : (
                  <>
                    <Button variant="outline" onClick={() => setDeclining(true)} disabled={busy}>Decline</Button>
                    <Button onClick={() => approve(reviewTarget)} disabled={busy}>
                      {busy ? 'Approving…' : 'Approve & send to kitchen'}
                    </Button>
                  </>
                )}
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={!!completeTarget} onOpenChange={(open) => !open && !busy && setCompleteTarget(null)}>
        <DialogContent>
          {completeTarget && (
            <>
              <DialogHeader>
                <DialogTitle>
                  {needsCash(completeTarget) ? 'Cash received' : 'Complete'} · {orderNumber(completeTarget)}
                </DialogTitle>
                <DialogDescription>
                  {needsCash(completeTarget)
                    ? `Log the cash ${completeTarget.order_channel === 'delivery' ? 'the rider brought back' : 'from the customer'}. This marks the order ${completeTarget.order_channel === 'delivery' ? 'delivered' : 'picked up'} and finishes the ticket.`
                    : `Already paid (${paymentLabel(completeTarget.payment_method)}). This marks the order ${completeTarget.order_channel === 'delivery' ? 'delivered' : 'picked up'} and finishes the ticket.`}
                </DialogDescription>
              </DialogHeader>
              {completeTarget.delivery && (
                <p className="text-sm">
                  <span className="font-medium">{completeTarget.delivery.customer_name}</span>
                  <span className="text-muted-foreground"> · {completeTarget.delivery.customer_phone}</span>
                </p>
              )}
              <div className="space-y-0.5 border-t pt-2 text-sm">
                {(completeTarget.delivery?.delivery_fee ?? 0) > 0 && (
                  <p className="flex justify-between"><span>Delivery fee</span><span>{formatCurrency(completeTarget.delivery?.delivery_fee ?? 0)}</span></p>
                )}
                <p className="flex justify-between text-base font-bold">
                  <span>{needsCash(completeTarget) ? 'Amount to collect' : 'Order total'}</span>
                  <span>{formatCurrency(completeDue)}</span>
                </p>
              </div>
              {needsCash(completeTarget) && (
                <div className="space-y-1">
                  <label htmlFor="cash-received" className="text-sm font-medium">Cash received (optional, for change)</label>
                  <Input
                    id="cash-received"
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step="0.01"
                    value={cashReceived}
                    onChange={(e) => setCashReceived(e.target.value)}
                    placeholder={completeDue.toFixed(2)}
                  />
                  {changeDue !== null && (
                    <p className={`text-sm font-medium ${changeDue < 0 ? 'text-destructive' : ''}`}>
                      {changeDue < 0 ? `Short by ${formatCurrency(-changeDue)}` : `Change: ${formatCurrency(changeDue)}`}
                    </p>
                  )}
                </div>
              )}
              <DialogFooter className="gap-2">
                <Button variant="outline" onClick={() => setCompleteTarget(null)} disabled={busy}>Cancel</Button>
                <Button onClick={() => complete(completeTarget)} disabled={busy || (changeDue !== null && changeDue < 0)}>
                  {busy ? 'Saving…' : needsCash(completeTarget) ? `Log ${formatCurrency(completeDue)} & complete` : 'Complete order'}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      <ReceiptDialog
        receipt={receipt}
        onClose={() => setReceipt(null)}
        title={receipt?.orderNumber != null ? `Order #${receipt.orderNumber} approved — sent to the kitchen` : 'Order approved'}
        description="The kitchen ticket prints on the kitchen tablet. Print the customer slip here."
      />
    </div>
  );
}
