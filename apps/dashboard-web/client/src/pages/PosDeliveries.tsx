import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Banknote, Bike, CalendarClock, CheckCircle2, ChefHat, PackageCheck, Phone, Trash2, Wallet } from 'lucide-react';
import { Link } from 'wouter';
import { useAuth } from '@/contexts/AuthContext';
import { Label } from '@/components/ui/label';
import { DashboardLayout } from '@/components/DashboardLayout';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
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
  type ApiProduct,
  type ApiTransaction,
  type TransactionPaymentMethod,
  type TransactionCardType,
  apiErrorDetail,
  eraseTransaction,
  fetchOverrideKeyStatus,
  fetchProducts,
  fetchTransactions,
  settleTransactionPayment,
  updateRiderPayout,
} from '@/lib/api';
import { POLL_INTERVAL_MS, toIsoDatePH, todayIsoPH } from '@/lib/constants';
import { formatCurrency, formatTimestamp12h } from '@/lib/utils';
import { useVisiblePolling } from '@/hooks/useVisiblePolling';
import { AdvanceOrdersSection } from '@/components/pos/AdvanceOrdersSection';

/** Where a pay-on-delivery order is right now, from the cashier's view. */
function stage(t: ApiTransaction): { label: string; tone: 'kitchen' | 'ready' | 'out' | 'delivered'; Icon: typeof ChefHat } {
  if (t.delivery?.delivered_at) return { label: 'Delivered — rider bringing the cash', tone: 'delivered', Icon: Banknote };
  if (t.kitchen_status === 'queued' && t.scheduled_for && Date.parse(t.scheduled_for) > Date.now() + 20 * 60_000) {
    return { label: 'Advance order — upcoming', tone: 'kitchen', Icon: CalendarClock };
  }
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

/** Where the delivery was punched: at the POS counter, or by the customer online. */
function OriginBadge({ t }: { t: ApiTransaction }) {
  const online = t.order_source === 'online';
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold ${
        online ? 'border-blue-300 bg-blue-50 text-blue-900' : 'border-slate-300 bg-slate-50 text-slate-800'
      }`}
    >
      Origin: {online ? 'Online delivery' : 'POS delivery'}
    </span>
  );
}

function orderTotal(t: ApiTransaction): number {
  // POS deliveries keep the fee outside total_amount; an online order's
  // total already includes it.
  if (t.order_source === 'online') return t.total_amount;
  return t.total_amount + (t.delivery?.delivery_fee ?? 0);
}

export default function PosDeliveries() {
  const [transactions, setTransactions] = useState<ApiTransaction[]>([]);
  const [products, setProducts] = useState<ApiProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [settleTarget, setSettleTarget] = useState<ApiTransaction | null>(null);
  const [settleMethod, setSettleMethod] = useState<TransactionPaymentMethod>('cash');
  const [settleCardType, setSettleCardType] = useState<TransactionCardType | null>(null);
  const [settling, setSettling] = useState(false);
  const [payoutInputs, setPayoutInputs] = useState<Record<string, string>>({});
  const [savingPayout, setSavingPayout] = useState<string | null>(null);
  // Executives only: permanently erase an order with their own override key.
  const { user } = useAuth();
  const isExecutive = user?.role === 'executive';
  const [eraseTarget, setEraseTarget] = useState<ApiTransaction | null>(null);
  const [eraseReason, setEraseReason] = useState('');
  const [eraseKey, setEraseKey] = useState('');
  const [erasing, setErasing] = useState(false);
  const [hasOverrideKey, setHasOverrideKey] = useState<boolean | null>(null);

  function openErase(t: ApiTransaction) {
    setEraseReason('');
    setEraseKey('');
    setEraseTarget(t);
    fetchOverrideKeyStatus().then((r) => setHasOverrideKey(r.is_set)).catch(() => setHasOverrideKey(null));
  }

  async function confirmErase() {
    if (!eraseTarget) return;
    setErasing(true);
    try {
      await eraseTransaction(eraseTarget.id, { override_key: eraseKey, reason: eraseReason.trim() });
      toast.success(`Order #${eraseTarget.order_number ?? ''} was permanently deleted. Its stock was returned.`);
      setTransactions((previous) => previous.filter((row) => row.id !== eraseTarget.id));
      setEraseTarget(null);
      load();
    } catch (e) {
      toast.error(apiErrorDetail(e, 'Could not delete the order'));
    } finally {
      setErasing(false);
    }
  }

  useEffect(() => {
    fetchProducts(false).then(setProducts).catch(() => {});
  }, []);

  const load = useCallback(() => {
    fetchTransactions({ activeSince: todayIsoPH() })
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
      await settleTransactionPayment(settleTarget.id, settleMethod, settleCardType);
      toast.success(
        `Order #${settleTarget.order_number ?? ''} payment recorded — ${formatCurrency(orderTotal(settleTarget))}.`
      );
      setSettleTarget(null);
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not record the payment');
    } finally {
      setSettling(false);
    }
  }

  async function savePayout(t: ApiTransaction) {
    const amount = Number(payoutInputs[t.id] ?? t.delivery?.rider_payout ?? '');
    if (!Number.isFinite(amount) || amount < 0) {
      toast.error('Enter a rider payout of zero or more');
      return;
    }
    setSavingPayout(t.id);
    try {
      const delivery = await updateRiderPayout(t.id, amount);
      setTransactions((previous) => previous.map((row) => row.id === t.id
        ? { ...row, delivery: row.delivery ? { ...row.delivery, rider_payout: delivery.rider_payout } : null }
        : row));
      setPayoutInputs((previous) => ({ ...previous, [t.id]: String(delivery.rider_payout ?? amount) }));
      toast.success('Rider payout saved');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save rider payout');
    } finally {
      setSavingPayout(null);
    }
  }

  return (
    <DashboardLayout title="Deliveries">
      <div className="p-6 space-y-6">
        <section className="space-y-3"><div><h2 className="text-lg font-semibold">Advance deliveries</h2><p className="text-sm text-muted-foreground">Requested times mean food ready for the rider. Payment collection and rider payout stay in the sections below.</p></div><AdvanceOrdersSection orderType="delivery" /></section>
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
                      <div className="flex flex-wrap gap-1.5">
                        <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold ${TONE[st.tone]}`}>
                          <st.Icon className="h-3.5 w-3.5" aria-hidden="true" /> {st.label}
                        </span>
                        <OriginBadge t={t} />
                      </div>
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
                      <div className="grid grid-cols-3 gap-2 rounded-md bg-muted/50 p-2 text-xs">
                        <div><p className="text-muted-foreground">Customer fee</p><p className="font-semibold">{formatCurrency(t.delivery?.delivery_fee ?? 0)}</p></div>
                        <div><label htmlFor={`rider-payout-${t.id}`} className="text-muted-foreground">Rider payout</label><Input id={`rider-payout-${t.id}`} type="number" min="0" step="0.01" className="mt-1 h-8" value={payoutInputs[t.id] ?? (t.delivery?.rider_payout == null ? '' : String(t.delivery.rider_payout))} onChange={(e) => setPayoutInputs((previous) => ({ ...previous, [t.id]: e.target.value }))} placeholder="₱" /></div>
                        <div><p className="text-muted-foreground">Net after payout</p><p className="font-semibold">{formatCurrency(orderTotal(t) - (Number(payoutInputs[t.id] ?? t.delivery?.rider_payout ?? 0) || 0))}</p></div>
                        <Button size="sm" variant="outline" className="col-span-3 h-8" disabled={savingPayout === t.id} onClick={() => savePayout(t)}>{savingPayout === t.id ? 'Saving…' : 'Save rider payout'}</Button>
                      </div>
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
                      {isExecutive && (
                        <Button
                          className="w-full min-h-11 gap-2 text-red-700 hover:text-red-800"
                          variant="ghost"
                          onClick={() => openErase(t)}
                        >
                          <Trash2 className="h-4 w-4" aria-hidden="true" /> Delete order
                        </Button>
                      )}
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
                  <OriginBadge t={t} />
                  <span className="text-muted-foreground">{t.delivery?.customer_name}</span>
                  <span className="text-muted-foreground">Fee {formatCurrency(t.delivery?.delivery_fee ?? 0)}</span>
                  <span className="text-muted-foreground">Rider {t.delivery?.rider_payout == null ? '—' : formatCurrency(t.delivery.rider_payout)}</span>
                  <span className="font-medium">Net {formatCurrency(orderTotal(t) - (t.delivery?.rider_payout ?? 0))}</span>
                  <div className="flex items-center gap-1">
                    <Input aria-label={`Rider payout for order ${t.order_number ?? t.id}`} type="number" min="0" step="0.01" className="h-8 w-24" value={payoutInputs[t.id] ?? (t.delivery?.rider_payout == null ? '' : String(t.delivery.rider_payout))} onChange={(e) => setPayoutInputs((previous) => ({ ...previous, [t.id]: e.target.value }))} placeholder="₱ payout" />
                    <Button size="sm" variant="outline" disabled={savingPayout === t.id} onClick={() => savePayout(t)}>{savingPayout === t.id ? '…' : 'Save'}</Button>
                  </div>
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
            <DialogTitle>Payment received for order #{settleTarget?.order_number}</DialogTitle>
            <DialogDescription>
              Confirm the customer’s payment method and amount with the rider before recording it.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <p className="rounded-md bg-muted px-4 py-3 text-center">
              <span className="block text-xs text-muted-foreground">Amount to collect</span>
              <span className="text-3xl font-bold">{settleTarget ? formatCurrency(orderTotal(settleTarget)) : ''}</span>
            </p>
            <div className="grid grid-cols-2 gap-2">
              {(['cash', 'gcash', 'card', 'bdo', 'maya'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => { setSettleMethod(m); setSettleCardType(null); }}
                  className={`rounded border py-3 text-sm ${
                    settleMethod === m ? 'border-transparent bg-primary text-primary-foreground' : 'bg-card'
                  }`}
                >
                  {m === 'cash' ? 'Cash from rider' : m === 'card' ? 'Card' : `Customer paid by ${m === 'gcash' ? 'GCash' : m === 'bdo' ? 'BDO' : 'Maya'}`}
                </button>
              ))}
            </div>
            {settleMethod === 'card' && <div className="flex gap-2">{(['debit', 'credit'] as const).map((type) => <button key={type} type="button" onClick={() => setSettleCardType(type)} className={`flex-1 rounded border py-2 capitalize ${settleCardType === type ? 'bg-primary text-primary-foreground' : ''}`}>{type}</button>)}</div>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSettleTarget(null)}>
              Cancel
            </Button>
            <Button onClick={confirmSettle} disabled={settling || (settleMethod === 'card' && !settleCardType)}>
              {settling ? 'Saving…' : 'Confirm payment received'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={!!eraseTarget} onOpenChange={(open) => !open && setEraseTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Permanently delete order #{eraseTarget?.order_number}?</DialogTitle>
            <DialogDescription>
              {eraseTarget ? formatCurrency(orderTotal(eraseTarget)) : ''} · {eraseTarget?.delivery?.customer_name}. The order is erased
              from the POS, Deliveries and all reports, and its stock is returned. This can’t be undone.
              {eraseTarget?.payment_status === 'paid' ? ' Shift reports that were already closed keep their printed totals.' : ''}
            </DialogDescription>
          </DialogHeader>
          {hasOverrideKey === false ? (
            <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-950">
              You haven’t set an override key yet. <Link href="/settings" className="font-semibold underline">Set it in Settings</Link>, then come back.
            </p>
          ) : (
            <div className="space-y-3">
              <div className="space-y-1">
                <Label htmlFor="erase-reason">Reason</Label>
                <Input id="erase-reason" maxLength={500} value={eraseReason} onChange={(e) => setEraseReason(e.target.value)} placeholder="e.g. test order, wrong entry" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="erase-key">Your override key</Label>
                <Input id="erase-key" type="password" autoComplete="off" value={eraseKey} onChange={(e) => setEraseKey(e.target.value)} />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEraseTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={confirmErase}
              disabled={erasing || hasOverrideKey === false || !eraseReason.trim() || !eraseKey}
            >
              {erasing ? 'Deleting…' : 'Delete permanently'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
}
