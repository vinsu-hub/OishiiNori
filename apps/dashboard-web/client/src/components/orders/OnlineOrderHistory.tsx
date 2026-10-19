import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bike, RefreshCw, Search, ShoppingBag, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { eraseOnlineOrder, fetchOrderHistory, type OrderHistoryEntry } from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';
import { EraseOrderDialog } from '@/components/shared/EraseOrderDialog';
import { orderHistoryDateIsoPH } from '@/lib/constants';
import { formatCurrency, formatTimestamp12h } from '@/lib/utils';

function statusLabel(order: OrderHistoryEntry): string {
  if (order.approval_status === 'rejected') return 'Declined';
  if (order.approval_status === 'pending') return 'Waiting for review';
  if (order.voided_at || order.status === 'voided') return 'Voided';
  if (order.closed_at) return 'Completed';
  if (order.delivered_at) return 'Delivered';
  const delivery = order.labels.includes('Delivery');
  if (order.kitchen_status === 'completed') return delivery ? 'With the rider' : 'Picked up';
  if (order.kitchen_status === 'ready') return delivery ? 'Ready for rider' : 'Ready for pickup';
  if (order.kitchen_status) return 'In the kitchen';
  return 'Confirmed · scheduled';
}

function paymentLabel(order: OrderHistoryEntry): string | null {
  if (order.approval_status === 'rejected') return null;
  if (order.payment_status === 'paid') return 'Paid';
  if (order.payment_status === 'unpaid') return 'Unpaid';
  return order.payment_method === 'cash' ? 'Pay on delivery/pickup' : 'Proof sent';
}

function OnlineHistoryCard({ order, onDelete }: { order: OrderHistoryEntry; onDelete?: () => void }) {
  const delivery = order.labels.includes('Delivery');
  const status = statusLabel(order);
  const payment = paymentLabel(order);
  return (
    <Card>
      <CardContent className="space-y-2 py-4 text-sm">
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="text-base font-bold">{order.order_number != null ? `Online #${order.order_number}` : 'Online order'}</p>
            <p className="text-xs text-muted-foreground">{formatTimestamp12h(order.placed_at)}</p>
          </div>
          <p className="text-lg font-bold">{formatCurrency(order.total_due)}</p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Badge variant="outline" className="gap-1">
            {delivery ? <Bike className="h-3.5 w-3.5" aria-hidden /> : <ShoppingBag className="h-3.5 w-3.5" aria-hidden />}
            {delivery ? 'Delivery' : 'Pickup'}
          </Badge>
          <Badge variant={status === 'Declined' || status === 'Voided' ? 'destructive' : 'secondary'}>{status}</Badge>
          {payment && (
            <Badge variant={order.payment_status === 'unpaid' ? 'destructive' : 'outline'}>
              {payment} · {order.payment_method ?? '—'}
            </Badge>
          )}
        </div>
        {order.customer_name && (
          <p>
            <span className="font-medium">{order.customer_name}</span>
            {order.customer_phone && <span className="text-muted-foreground"> · {order.customer_phone}</span>}
          </p>
        )}
        {delivery && order.address && (
          <p className="text-muted-foreground">{[order.address, order.barangay].filter(Boolean).join(', ')}</p>
        )}
        <details className="border-t pt-2">
          <summary className="cursor-pointer select-none font-medium text-primary">Items &amp; proof of payment</summary>
          <ul className="mt-2 space-y-1">
            {order.lines.map((line, index) => (
              <li key={index} className="flex justify-between gap-3">
                <span>{line.quantity} × {line.name}</span>
                <span className="tabular-nums">{formatCurrency(line.quantity * line.unit_price)}</span>
              </li>
            ))}
            {order.order_addons.map((addon, index) => (
              <li key={`addon-${index}`} className="flex justify-between gap-3">
                <span>{addon.quantity} × {addon.name}</span>
                <span className="tabular-nums">{formatCurrency(addon.quantity * addon.unit_price)}</span>
              </li>
            ))}
            {order.delivery_fee > 0 && (
              <li className="flex justify-between gap-3"><span>Delivery fee</span><span className="tabular-nums">{formatCurrency(order.delivery_fee)}</span></li>
            )}
          </ul>
          {order.customer_note && <p className="mt-2 italic text-muted-foreground">Note: {order.customer_note}</p>}
          {order.void_reason && <p className="mt-2 text-destructive">Reason: {order.void_reason}</p>}
          {order.payment_proof_url ? (
            <a href={order.payment_proof_url} target="_blank" rel="noopener noreferrer" className="mt-2 block">
              <img src={order.payment_proof_url} alt={`Proof of payment for order ${order.order_number ?? ''}`} loading="lazy" className="max-h-72 w-full rounded-md border object-contain" />
            </a>
          ) : (
            <p className="mt-2 text-muted-foreground">
              {order.payment_method === 'cash' ? 'Cash order — no proof of payment needed.' : 'No proof of payment was uploaded.'}
            </p>
          )}
        </details>
        {onDelete && order.digital_order_id && (
          <Button className="w-full min-h-10 gap-2 text-red-700 hover:text-red-800" variant="ghost" onClick={onDelete}>
            <Trash2 className="h-4 w-4" aria-hidden /> Delete order (override)
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

/** Online Orders → History: past website delivery/pickup orders for a day. */
export function OnlineOrderHistory() {
  const { user } = useAuth();
  const isExecutive = user?.role === 'executive';
  const [eraseTarget, setEraseTarget] = useState<OrderHistoryEntry | null>(null);
  const [date, setDate] = useState(orderHistoryDateIsoPH);
  const [orders, setOrders] = useState<OrderHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const requestVersion = useRef(0);

  // Loaded on open, on a date change and on Refresh only -- no polling, to
  // keep this past-orders view off the API's CPU budget.
  const load = useCallback(() => {
    const version = ++requestVersion.current;
    setLoading(true);
    fetchOrderHistory(date, true)
      .then((result) => {
        if (version === requestVersion.current) setOrders(result.filter((order) => order.labels.includes('Online')));
      })
      .catch((error) => {
        if (version === requestVersion.current) toast.error(error instanceof Error ? error.message : 'Could not load online order history');
      })
      .finally(() => {
        if (version === requestVersion.current) setLoading(false);
      });
  }, [date]);
  useEffect(load, [load]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    const sorted = [...orders].sort((a, b) => b.placed_at.localeCompare(a.placed_at));
    if (!query) return sorted;
    return sorted.filter((order) => [
      String(order.order_number ?? ''), order.customer_name ?? '', order.customer_phone ?? '',
      order.payment_method ?? '', ...order.lines.map((line) => line.name),
    ].some((value) => value.toLowerCase().includes(query)));
  }, [orders, search]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className="space-y-1 text-xs font-medium">
          Date
          <Input type="date" max={orderHistoryDateIsoPH()} value={date} onChange={(e) => { if (e.target.value) { setOrders([]); setDate(e.target.value); } }} className="w-44" />
        </label>
        <div className="relative min-w-56 flex-1 max-w-md">
          <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" aria-hidden />
          <Input className="pl-9" placeholder="Search order, customer, phone, or item" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search online orders" />
        </div>
        <Button type="button" variant="outline" onClick={load}><RefreshCw className="mr-2 h-4 w-4" aria-hidden />Refresh</Button>
      </div>
      <p className="text-sm text-muted-foreground">
        {loading ? 'Loading…' : `${filtered.length} online order${filtered.length === 1 ? '' : 's'}`} · 10:00 PM the night before through 9:59 PM on this date.
      </p>
      {!loading && filtered.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">No online orders on this date.</p>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
          {filtered.map((order) => (
            <OnlineHistoryCard key={order.id} order={order} onDelete={isExecutive ? () => setEraseTarget(order) : undefined} />
          ))}
        </div>
      )}
      <EraseOrderDialog
        target={eraseTarget ? {
          title: `Permanently delete Online #${eraseTarget.order_number ?? ''}?`,
          description: `${formatCurrency(eraseTarget.total_due)} · ${eraseTarget.customer_name ?? ''}. The online order`
            + (eraseTarget.transaction_id ? ' and its kitchen ticket are' : ' is')
            + ' erased from the board, history and all reports. This can’t be undone.',
        } : null}
        onClose={() => setEraseTarget(null)}
        onConfirm={async (body) => {
          if (!eraseTarget?.digital_order_id) return;
          await eraseOnlineOrder(eraseTarget.digital_order_id, body);
          toast.success(`Online #${eraseTarget.order_number ?? ''} was permanently deleted`);
          setOrders((previous) => previous.filter((row) => row.id !== eraseTarget.id));
        }}
      />
    </div>
  );
}
