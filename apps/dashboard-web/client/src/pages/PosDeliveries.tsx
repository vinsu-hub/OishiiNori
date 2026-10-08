import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Banknote, Bike, CheckCircle2, ChefHat, PackageCheck, Phone, Wallet } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardLayout';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  type ApiProduct,
  type ApiTransaction,
  fetchProducts,
  fetchTransactions,
  settleTransactionPayment,
} from '@/lib/api';
import { POLL_INTERVAL_MS, toIsoDatePH, todayIsoPH } from '@/lib/constants';
import { formatCurrency, formatTimestamp12h } from '@/lib/utils';
import { useVisiblePolling } from '@/hooks/useVisiblePolling';

/** Where a pay-on-delivery order is right now, from the cashier's view. */
function stage(t: ApiTransaction): { label: string; tone: 'kitchen' | 'ready' | 'out' | 'delivered'; Icon: typeof ChefHat } {
  if (t.delivery?.delivered_at) return { label: 'Delivered — rider bringing the cash', tone: 'delivered', Icon: Banknote };
  if (t.kitchen_status === 'ready') return { label: 'Ready — waiting for rider pickup', tone: 'ready', Icon: PackageCheck };
  if (t.kitchen_status === 'completed') return { label: 'Out for delivery', tone: 'out', Icon: Bike };
  return { label: 'In the kitchen', tone: 'kitchen', Icon: ChefHat };
}

const TONE: Record<string, string> = {
  kitchen: 'bg-amber-100 text-amber-900 border-amber-300',
  ready: 'bg-sky-100 text-sky-900 border-sky-300',
  out: 'bg-violet-100 text-violet-900 border-violet-300',
  delivered: 'bg-green-100 text-green-900 border-green-300',
};

function orderTotal(t: ApiTransaction): number {
  return t.total_amount + (t.delivery?.delivery_fee ?? 0);
}

export default function PosDeliveries() {
  const [transactions, setTransactions] = useState<ApiTransaction[]>([]);
  const [products, setProducts] = useState<ApiProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [settleTarget, setSettleTarget] = useState<ApiTransaction | null>(null);
  const [settleMethod, setSettleMethod] = useState<'cash' | 'gcash'>('cash');
  const [settling, setSettling] = useState(false);

  useEffect(() => {
    fetchProducts(false).then(setProducts).catch(() => {});
  }, []);

  const load = useCallback(() => {
    fetchTransactions()
      .then((all) => setTransactions(all.filter((t) => t.order_type === 'delivery' && t.status !== 'voided')))
      .catch((e) => toast.error(e instanceof Error ? e.message : 'Failed to load deliveries'))
      .finally(() => setLoading(false));
  }, []);
  useVisiblePolling(load, POLL_INTERVAL_MS);

  const sizeName = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of products) for (const s of p.sizes) map.set(s.id, `${p.name} (${s.size_label})`);
    return map;
  }, [products]);

  // Unpaid from any day (cash still out), plus today's paid ones for reference.
  const unpaid = useMemo(
    () => transactions.filter((t) => t.payment_status === 'unpaid').sort((a, b) => a.opened_at.localeCompare(b.opened_at)),
    [transactions]
  );
  const paidToday = useMemo(
    () =>
      transactions
        .filter((t) => t.payment_status !== 'unpaid' && toIsoDatePH(t.opened_at) === todayIsoPH())
        .sort((a, b) => b.opened_at.localeCompare(a.opened_at)),
    [transactions]
  );
  const outstanding = unpaid.reduce((sum, t) => sum + orderTotal(t), 0);

  async function confirmSettle() {
    if (!settleTarget) return;
    setSettling(true);
    try {
      await settleTransactionPayment(settleTarget.id, settleMethod);
      toast.success(
        `Order #${settleTarget.order_number ?? ''} paid — ${formatCurrency(orderTotal(settleTarget))} received from the rider.`
      );
      setSettleTarget(null);
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not record the payment');
    } finally {
      setSettling(false);
    }
  }

  return (
    <DashboardLayout title="Deliveries">
      <div className="p-6 space-y-6">
        <div className="grid gap-3 sm:grid-cols-3">
          <Card>
            <CardContent className="py-4">
              <p className="text-xs text-muted-foreground">Cash still with riders</p>
              <p className="text-2xl font-semibold">{formatCurrency(outstanding)}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="py-4">
              <p className="text-xs text-muted-foreground">Pay-on-delivery orders open</p>
              <p className="text-2xl font-semibold">{unpaid.length}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="py-4">
              <p className="text-xs text-muted-foreground">Delivered &amp; paid today</p>
              <p className="text-2xl font-semibold">{paidToday.length}</p>
            </CardContent>
          </Card>
        </div>

        <section className="space-y-3">
          <div>
            <h2 className="text-lg font-semibold">Waiting for payment</h2>
            <p className="text-sm text-muted-foreground">
              Pay-on-delivery orders (e.g. Facebook orders). When the rider comes back with the money, count it and tap{' '}
              <b>Cash received</b>.
            </p>
          </div>
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : unpaid.length === 0 ? (
            <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
              No deliveries waiting for payment.
            </p>
          ) : (
            <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
              {unpaid.map((t) => {
                const st = stage(t);
                return (
                  <Card key={t.id} className={st.tone === 'delivered' ? 'border-2 border-green-500' : ''}>
                    <CardContent className="space-y-3 py-4">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <p className="text-lg font-bold">Order #{t.order_number ?? t.id.slice(0, 8)}</p>
                          <p className="text-xs text-muted-foreground">
                            {toIsoDatePH(t.opened_at) === todayIsoPH() ? '' : `${toIsoDatePH(t.opened_at)} · `}
                            {formatTimestamp12h(t.opened_at)}
                          </p>
                        </div>
                        <p className="text-xl font-bold">{formatCurrency(orderTotal(t))}</p>
                      </div>
                      <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold ${TONE[st.tone]}`}>
                        <st.Icon className="h-3.5 w-3.5" aria-hidden="true" /> {st.label}
                      </span>
                      {t.delivery && (
                        <div className="text-sm">
                          <p className="font-medium">{t.delivery.customer_name}</p>
                          <p className="flex items-center gap-1 text-muted-foreground">
                            <Phone className="h-3.5 w-3.5" aria-hidden="true" /> {t.delivery.customer_phone}
                          </p>
                          <p className="text-muted-foreground">
                            {[t.delivery.address, t.delivery.barangay].filter(Boolean).join(', ')}
                            {t.delivery.landmark ? ` (${t.delivery.landmark})` : ''}
                          </p>
                          {t.delivery.rider_name && <p className="text-xs">Rider: {t.delivery.rider_name}</p>}
                        </div>
                      )}
                      <ul className="text-sm">
                        {t.items.map((i) => (
                          <li key={i.id}>
                            {i.quantity}x {sizeName.get(i.product_size_id) ?? 'Item'}
                          </li>
                        ))}
                      </ul>
                      <Button
                        className="w-full min-h-11 gap-2"
                        variant={st.tone === 'delivered' ? 'default' : 'outline'}
                        onClick={() => {
                          setSettleMethod('cash');
                          setSettleTarget(t);
                        }}
                      >
                        <Wallet className="h-4 w-4" aria-hidden="true" /> Cash received
                      </Button>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </section>

        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Today’s paid deliveries</h2>
          {paidToday.length === 0 ? (
            <p className="text-sm text-muted-foreground">None yet today.</p>
          ) : (
            <div className="divide-y rounded-lg border bg-card">
              {paidToday.map((t) => (
                <div key={t.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
                  <span className="font-semibold">Order #{t.order_number ?? t.id.slice(0, 8)}</span>
                  <span className="text-muted-foreground">{t.delivery?.customer_name}</span>
                  <Badge variant="outline" className="gap-1">
                    <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
                    Paid{t.payment_method ? ` · ${t.payment_method.toUpperCase()}` : ''}
                  </Badge>
                  <span className="font-semibold">{formatCurrency(orderTotal(t))}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      <Dialog open={!!settleTarget} onOpenChange={(open) => !open && setSettleTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cash received for order #{settleTarget?.order_number}</DialogTitle>
            <DialogDescription>
              Count the money from the rider before confirming. It will be added to today’s sales in the drawer.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <p className="rounded-md bg-muted px-4 py-3 text-center">
              <span className="block text-xs text-muted-foreground">Amount to collect</span>
              <span className="text-3xl font-bold">{settleTarget ? formatCurrency(orderTotal(settleTarget)) : ''}</span>
            </p>
            <div className="grid grid-cols-2 gap-2">
              {(['cash', 'gcash'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setSettleMethod(m)}
                  className={`rounded border py-3 text-sm ${
                    settleMethod === m ? 'border-transparent bg-primary text-primary-foreground' : 'bg-card'
                  }`}
                >
                  {m === 'cash' ? 'Cash from rider' : 'Customer paid by GCash'}
                </button>
              ))}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSettleTarget(null)}>
              Cancel
            </Button>
            <Button onClick={confirmSettle} disabled={settling}>
              {settling ? 'Saving…' : 'Confirm payment received'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
}
