import { useCallback, useMemo, useRef, useState } from 'react';
import { RefreshCw, Search } from 'lucide-react';
import { toast } from 'sonner';
import { DashboardLayout } from '@/components/DashboardLayout';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/contexts/AuthContext';
import { fetchOrderHistory, type OrderHistoryEntry } from '@/lib/api';
import { POLL_INTERVAL_MS, todayIsoPH } from '@/lib/constants';
import { useVisiblePolling } from '@/hooks/useVisiblePolling';
import { formatCurrency } from '@/lib/utils';

const PERIODS = [
  { key: 'morning', title: 'Morning', hours: '6:00 AM – 11:59 AM' },
  { key: 'afternoon', title: 'Afternoon', hours: '12:00 PM – 5:59 PM' },
  { key: 'evening', title: 'Evening', hours: '6:00 PM – 5:59 AM' },
] as const;

const phTime = new Intl.DateTimeFormat('en-PH', {
  hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Manila',
});
const phDateTime = new Intl.DateTimeFormat('en-PH', {
  year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  hour12: true, timeZone: 'Asia/Manila',
});

function MoneyRow({ label, amount, strong = false }: { label: string; amount: number; strong?: boolean }) {
  return <div className={`flex justify-between gap-3 ${strong ? 'font-semibold' : ''}`}>
    <span>{label}</span><span className="tabular-nums text-right">{formatCurrency(amount)}</span>
  </div>;
}

function Detail({ label, value }: { label: string; value: string | number | null | undefined }) {
  if (value == null || value === '') return null;
  return <div className="flex justify-between gap-3"><dt className="text-muted-foreground">{label}</dt><dd className="text-right break-words">{value}</dd></div>;
}

function OrderCard({ order }: { order: OrderHistoryEntry }) {
  const cancelled = order.status === 'voided' || order.status === 'rejected';
  const paymentLabel = order.payment_status === 'paid' ? 'Paid' : order.payment_status === 'unpaid' ? 'Unpaid' : 'No payment recorded';
  return <Card className="gap-0 py-0 overflow-hidden">
    <CardContent className="space-y-3 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-corp-display text-lg font-semibold">{order.order_number != null ? `#${order.order_number}` : order.id.slice(0, 8).toUpperCase()}</p>
          <p className="text-xs text-muted-foreground">Placed {phTime.format(new Date(order.placed_at))}</p>
        </div>
        <Badge variant={cancelled ? 'destructive' : order.payment_status === 'paid' ? 'secondary' : 'gold'}>
          {cancelled ? order.status : paymentLabel}
        </Badge>
      </div>
      <div className="flex flex-wrap gap-1">{order.labels.map((label) => <Badge key={label} variant="outline">{label}</Badge>)}</div>
      <div className="grid grid-cols-2 gap-2 border-t pt-3 text-sm">
        <div><p className="text-xs text-muted-foreground">Recorded paid</p><p className="font-semibold tabular-nums">{formatCurrency(order.recorded_paid)}</p></div>
        <div><p className="text-xs text-muted-foreground">Order total</p><p className="font-semibold tabular-nums">{formatCurrency(order.total_due)}</p></div>
      </div>
      <p className="text-xs text-muted-foreground">{order.payment_method === 'grab' ? 'Grab settlement' : order.payment_method || 'Payment option not recorded'}{order.discount ? ` · ${order.discount.name} −${formatCurrency(order.discount.amount)}` : ''}</p>
      <details className="group border-t pt-3 text-sm">
        <summary className="cursor-pointer select-none font-medium text-primary">Full order details <span className="text-xs group-open:hidden">▾</span><span className="hidden text-xs group-open:inline">▴</span></summary>
        <div className="mt-4 space-y-4">
          <dl className="space-y-1.5 border-b pb-4">
            <Detail label="Placed" value={phDateTime.format(new Date(order.placed_at))} />
            <Detail label="Order status" value={order.status} />
            <Detail label="Online approval" value={order.approval_status} />
            <Detail label="Kitchen" value={order.kitchen_status} />
            <Detail label="Scheduled for" value={order.scheduled_for ? phDateTime.format(new Date(order.scheduled_for)) : null} />
            <Detail label="Completed" value={order.closed_at ? phDateTime.format(new Date(order.closed_at)) : null} />
            <Detail label="Delivered" value={order.delivered_at ? phDateTime.format(new Date(order.delivered_at)) : null} />
            <Detail label="Payment option" value={order.payment_method === 'grab' ? 'Grab settlement' : order.payment_method} />
            <Detail label="Payment status" value={paymentLabel} />
            <Detail label="Payment time" value={order.paid_at ? phDateTime.format(new Date(order.paid_at)) : order.payment_status === 'paid' ? 'At checkout; exact time not stored' : null} />
            <Detail label="Payment proof" value={order.payment_proof_submitted ? 'Submitted; approval is tracked separately' : null} />
            {order.payment_proof_url && <div className="text-right"><a href={order.payment_proof_url} target="_blank" rel="noopener noreferrer" className="text-primary underline">View payment proof</a></div>}
            <Detail label="Cashier" value={order.cashier_name} />
            <Detail label="Table" value={order.table_number} />
            <Detail label="Guests" value={order.guest_count} />
            <Detail label="Customer" value={order.customer_name} />
            <Detail label="Phone" value={order.customer_phone} />
            <Detail label="Address" value={[order.address, order.landmark, order.barangay].filter(Boolean).join(', ')} />
            <Detail label="Rider ID" value={order.rider_id} />
            <Detail label="Rider payout" value={order.rider_payout != null ? formatCurrency(order.rider_payout) : null} />
            <Detail label="Customer note" value={order.customer_note} />
            <Detail label="Owner request" value={order.owner_request_note} />
            <Detail label="Related order ID" value={order.related_transaction_id} />
            <Detail label="Transaction ID" value={order.transaction_id} />
            <Detail label="Online order ID" value={order.digital_order_id} />
          </dl>
          <div className="space-y-2">
            <h4 className="font-semibold">Items</h4>
            {order.lines.map((line, index) => <div key={index} className="border-b pb-2 last:border-0">
              <div className="flex justify-between gap-3"><span>{line.quantity} × {line.name}</span><span className="tabular-nums text-right">{formatCurrency(line.quantity * line.unit_price)}</span></div>
              <p className="text-xs text-muted-foreground">{formatCurrency(line.unit_price)} per unit</p>
              {line.held_ingredients.length > 0 && <p className="text-xs text-destructive">Hold: {line.held_ingredients.join(', ')}</p>}
              {line.addons.map((addon, addonIndex) => <div key={addonIndex} className="flex justify-between gap-2 pl-3 text-xs text-muted-foreground"><span>+ {addon.quantity} × {addon.name}</span><span>{formatCurrency(addon.quantity * addon.unit_price)}</span></div>)}
              {line.discount_amount > 0 && <p className="text-xs text-primary">{line.discount_name || 'Discount'} on 1 unit: −{formatCurrency(line.discount_amount)}</p>}
            </div>)}
            {order.order_addons.map((addon, index) => <div key={index} className="flex justify-between gap-2 text-xs"><span>+ {addon.quantity} × {addon.name}</span><span>{formatCurrency(addon.quantity * addon.unit_price)}</span></div>)}
            {order.lines.length === 0 && <p className="text-muted-foreground">No item details recorded.</p>}
          </div>
          <div className="space-y-1.5 border-t pt-3">
            <MoneyRow label="Subtotal" amount={order.subtotal} />
            {order.discount && <p className="text-xs text-muted-foreground">{order.discount.name}{order.discount.percentage != null ? ` (${order.discount.percentage}%)` : ''} · {order.discount.scope === 'one_unit' ? `1 unit of ${order.discount.item_name}` : 'whole order'}</p>}
            {order.discount && <MoneyRow label="Discount" amount={-order.discount.amount} />}
            {order.delivery_fee > 0 && <MoneyRow label="Delivery fee" amount={order.delivery_fee} />}
            <MoneyRow label="Total due" amount={order.total_due} strong />
            <MoneyRow label="Recorded paid" amount={order.recorded_paid} />
            {order.outstanding > 0 && <MoneyRow label="Outstanding" amount={order.outstanding} />}
            {order.cash_refund_paid > 0 && <MoneyRow label="Cash refund paid out" amount={-order.cash_refund_paid} />}
            <p className="text-xs text-muted-foreground">Tax included for reference: {formatCurrency(order.tax_amount)}</p>
          </div>
          {(order.void_reason || order.refund_status) && <div className="space-y-1 border-t pt-3">
            <h4 className="font-semibold">Void and refund</h4>
            <Detail label="Void reason" value={order.void_reason} />
            <Detail label="Voided at" value={order.voided_at ? phDateTime.format(new Date(order.voided_at)) : null} />
            <Detail label="Refund request" value={order.refund_status} />
            <Detail label="Refund reason" value={order.refund_reason} />
          </div>}
        </div>
      </details>
    </CardContent>
  </Card>;
}

export default function OrderHistory() {
  const { user } = useAuth();
  const allowed = user?.role === 'employee' || user?.role === 'manager' || user?.role === 'executive';
  const [date, setDate] = useState(todayIsoPH);
  const [orders, setOrders] = useState<OrderHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const requestVersion = useRef(0);
  const load = useCallback(() => {
    if (!allowed || !date) return;
    const version = ++requestVersion.current;
    fetchOrderHistory(date).then((result) => {
      if (version === requestVersion.current) setOrders(result);
    }).catch((error) => {
      if (version === requestVersion.current) toast.error(error instanceof Error ? error.message : 'Could not load order history');
    }).finally(() => {
      if (version === requestVersion.current) setLoading(false);
    });
  }, [allowed, date]);
  useVisiblePolling(load, POLL_INTERVAL_MS);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return orders;
    return orders.filter((order) => [
      String(order.order_number ?? ''), order.id, order.transaction_id ?? '', order.customer_name ?? '',
      order.payment_method ?? '', ...order.labels, ...order.lines.map((line) => line.name),
    ].some((value) => value.toLowerCase().includes(query)));
  }, [orders, search]);

  return <DashboardLayout title="Order History">
    <div className="space-y-5 p-4 sm:p-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div><h1 className="font-corp-display text-2xl font-semibold">Order History</h1><p className="text-sm text-muted-foreground">Every order placed on the selected Manila date, including pending and voided orders.</p></div>
        <div className="flex flex-wrap items-end gap-2">
          <label className="space-y-1 text-xs font-medium">Date <Input type="date" max={todayIsoPH()} value={date} onChange={(event) => { if (!event.target.value) return; requestVersion.current++; setLoading(true); setOrders([]); setDate(event.target.value); }} className="w-44" /></label>
          <Button type="button" variant="outline" onClick={() => { setLoading(true); load(); }}><RefreshCw className="mr-2 h-4 w-4" />Refresh</Button>
        </div>
      </div>
      {!allowed ? <p className="text-sm text-destructive">This history is available to cashiers and management.</p> : <>
        <div className="relative max-w-md"><Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" /><Input className="pl-9" placeholder="Search order, customer, payment, or item" value={search} onChange={(event) => setSearch(event.target.value)} /></div>
        <p className="text-sm text-muted-foreground">{loading ? 'Loading…' : `${filtered.length} order${filtered.length === 1 ? '' : 's'}`} · Paid amounts reflect recorded payments; cash tendered and change were not stored.</p>
        <div className="grid gap-4 xl:grid-cols-3">
          {PERIODS.map((period) => {
            const items = filtered.filter((order) => order.period === period.key);
            return <section key={period.key} aria-label={period.title} className="min-w-0 space-y-3">
              <header className="flex items-baseline justify-between rounded-md bg-muted/50 px-3 py-2"><div><h2 className="font-corp-display text-lg font-semibold">{period.title}</h2><p className="text-xs text-muted-foreground">{period.hours}</p></div><Badge variant="secondary">{items.length}</Badge></header>
              {items.map((order) => <OrderCard key={order.id} order={order} />)}
              {!loading && items.length === 0 && <p className="rounded-md border p-4 text-sm text-muted-foreground">No orders in this time block.</p>}
            </section>;
          })}
        </div>
      </>}
    </div>
  </DashboardLayout>;
}
