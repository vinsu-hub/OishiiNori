import { useEffect, useState } from 'react';
import { fetchOrderHistory, type OrderHistoryEntry } from '@/lib/api';
import { formatCurrency, formatTimestamp12h } from '@/lib/utils';

/** Calendar-date order detail alongside the immutable shift cash snapshot. */
export function DailyOrderAudit({ date }: { date: string }) {
  const [orders, setOrders] = useState<OrderHistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setOrders(null);
    setError(null);
    fetchOrderHistory(date)
      .then((rows) => { if (active) setOrders(rows); })
      .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : 'Could not load orders'); });
    return () => { active = false; };
  }, [date]);

  return <section className="border-t pt-4">
    <h3 className="mb-1 text-sm font-bold">Every order placed on {date}</h3>
    <p className="mb-3 text-xs text-muted-foreground">Includes pending and unpaid orders. The cash drawer above counts payments collected during the shift, so these calendar-date totals are for checking individual orders.</p>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {!error && !orders && <p className="text-sm text-muted-foreground">Loading orders…</p>}
    {orders && <>
      <p className="mb-3 text-xs text-muted-foreground">
        {orders.length} orders · {orders.filter((order) => order.payment_status === 'paid').length} paid ·{' '}
        {formatCurrency(orders.reduce((sum, order) => sum + (order.discount?.amount ?? 0), 0))} discounts
      </p>
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full min-w-[780px] text-left text-xs">
          <thead className="bg-muted/60">
            <tr className="border-b">
              <th className="px-2 py-2">Order / placed</th>
              <th className="px-2 py-2">Type</th>
              <th className="px-2 py-2">Payment</th>
              <th className="px-2 py-2">Status</th>
              <th className="px-2 py-2 text-right">Due</th>
              <th className="px-2 py-2 text-right">Discount</th>
              <th className="px-2 py-2 text-right">Recorded paid</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((order) => <tr key={order.id} className="border-b align-top last:border-0">
              <td className="px-2 py-2">
                <details>
                  <summary className="cursor-pointer font-semibold">#{order.order_number ?? '—'} · {formatTimestamp12h(order.placed_at)}</summary>
                  <div className="mt-2 min-w-60 space-y-1 font-normal text-muted-foreground">
                    {order.cashier_name && <p>Cashier: {order.cashier_name}</p>}
                    {order.customer_name && <p>Customer: {order.customer_name}</p>}
                    {order.lines.map((line, index) => <p key={index}>{line.quantity} × {line.name} · {formatCurrency(line.quantity * line.unit_price)}{line.discount_amount > 0 ? ` · discount ${formatCurrency(line.discount_amount)}` : ''}</p>)}
                    {order.order_addons.map((addon, index) => <p key={`addon-${index}`}>+ {addon.quantity} × {addon.name} · {formatCurrency(addon.quantity * addon.unit_price)}</p>)}
                    {order.delivery_fee > 0 && <p>Delivery fee: {formatCurrency(order.delivery_fee)}</p>}
                    {order.discount && <p>Discount: {order.discount.name} · {order.discount.scope === 'one_unit' ? `one unit of ${order.discount.item_name}` : 'whole order'}</p>}
                    {order.outstanding > 0 && <p>Outstanding: {formatCurrency(order.outstanding)}</p>}
                    {order.transaction_id && <p>Transaction ID: {order.transaction_id}</p>}
                  </div>
                </details>
              </td>
              <td className="px-2 py-2">{order.labels.join(' · ')}</td>
              <td className="px-2 py-2">{order.payment_method === 'grab' ? 'Grab settlement' : order.payment_method ?? 'Unrecorded'}</td>
              <td className="px-2 py-2">{order.status} · {order.payment_status}</td>
              <td className="px-2 py-2 text-right tabular-nums">{formatCurrency(order.total_due)}</td>
              <td className="px-2 py-2 text-right tabular-nums">{formatCurrency(order.discount?.amount ?? 0)}</td>
              <td className="px-2 py-2 text-right tabular-nums">{formatCurrency(order.recorded_paid)}</td>
            </tr>)}
          </tbody>
        </table>
      </div>
    </>}
  </section>;
}
