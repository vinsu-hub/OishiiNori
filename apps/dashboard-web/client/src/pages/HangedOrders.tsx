import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Banknote, Bike, CheckCircle2, ChefHat, PackageCheck, Pencil, Phone, Printer, Send, Wallet } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardLayout';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { type ApiPosHangedOrder, type ApiProduct, type ApiTransaction, type TransactionCardType, type TransactionPaymentMethod, completePosHangedOrder, fetchPosHangedOrders, fetchProducts, updatePosHangedOrder, sendPosHangedOrderToKitchen } from '@/lib/api';
import { POLL_INTERVAL_MS } from '@/lib/constants';
import { formatCurrency, formatTimestamp12h } from '@/lib/utils';
import { useVisiblePolling } from '@/hooks/useVisiblePolling';
import { printReceipt, type ReceiptData } from '@/components/pos/Receipt';
import { useAuth } from '@/contexts/AuthContext';

/** Where a sent hanged order is right now, from the cashier's view. */
function stage(t: ApiTransaction): { label: string; tone: 'kitchen' | 'ready' | 'out' | 'delivered'; Icon: typeof ChefHat } {
  if (t.delivery?.delivered_at) return { label: 'Delivered — waiting for payment', tone: 'delivered', Icon: Banknote };
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

const PAYMENT_LABEL: Record<string, string> = { cash: 'Cash', gcash: 'GCash', card: 'Card', bdo: 'BDO', maya: 'Maya' };

function orderTotal(t: ApiTransaction): number {
  return t.total_amount + (t.delivery?.delivery_fee ?? 0);
}

function isFinished(t: ApiTransaction): boolean {
  return t.status !== 'open' && t.payment_status !== 'unpaid';
}

export default function HangedOrders() {
  const { user } = useAuth();
  const [orders, setOrders] = useState<ApiPosHangedOrder[]>([]);
  const [products, setProducts] = useState<ApiProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [editDraft, setEditDraft] = useState<ApiPosHangedOrder | null>(null);
  const [saving, setSaving] = useState(false);
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [completeTarget, setCompleteTarget] = useState<ApiPosHangedOrder | null>(null);
  const [completeMethod, setCompleteMethod] = useState<TransactionPaymentMethod>('cash');
  const [completeCardType, setCompleteCardType] = useState<TransactionCardType | null>(null);
  const [cashReceived, setCashReceived] = useState('');
  const [completing, setCompleting] = useState(false);

  useEffect(() => { fetchProducts(false).then(setProducts).catch(() => {}); }, []);
  const load = useCallback(() => {
    fetchPosHangedOrders()
      .then(setOrders)
      .catch((e) => toast.error(e instanceof Error ? e.message : 'Failed to load hanged orders'))
      .finally(() => setLoading(false));
  }, []);
  useVisiblePolling(load, POLL_INTERVAL_MS);

  const sizeById = useMemo(() => new Map(products.flatMap((product) => product.sizes.map((size) => [size.id, { product, size }] as const))), [products]);

  async function saveDraft() {
    if (!editDraft) return;
    setSaving(true);
    try {
      const updated = await updatePosHangedOrder(editDraft.id, editDraft.payload);
      setOrders((rows) => rows.map((row) => row.id === updated.id ? updated : row));
      setEditDraft(null);
      toast.success('Hanged order updated');
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Could not update draft'); }
    finally { setSaving(false); }
  }

  async function sendToKitchen(order: ApiPosHangedOrder) {
    setSendingId(order.id);
    try {
      const transaction = await sendPosHangedOrderToKitchen(order.id);
      load();
      toast.success(`Order #${transaction.order_number ?? transaction.id.slice(0, 8)} sent to the kitchen. Complete it here once paid.`);
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Could not send order to kitchen'); }
    finally { setSendingId(null); }
  }

  function openComplete(order: ApiPosHangedOrder) {
    setCompleteMethod('cash');
    setCompleteCardType(null);
    setCashReceived('');
    setCompleteTarget(order);
  }

  async function confirmComplete() {
    const transaction = completeTarget?.transaction;
    if (!completeTarget || !transaction) return;
    setCompleting(true);
    try {
      await completePosHangedOrder(completeTarget.id, completeMethod, completeCardType);
      toast.success(`Order #${transaction.order_number ?? ''} completed — ${formatCurrency(orderTotal(transaction))} received by ${PAYMENT_LABEL[completeMethod] ?? completeMethod}.`);
      setCompleteTarget(null);
      load();
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Could not complete the order'); }
    finally { setCompleting(false); }
  }

  function printDraft(order: ApiPosHangedOrder) {
    const payload = order.payload;
    const lines = payload.items.map((line) => {
      const found = sizeById.get(line.product_size_id);
      return { name: found ? `${found.product.name} (${found.size.size_label})` : 'Menu item', quantity: line.quantity, unitPrice: found?.size.price ?? 0, addons: [], discountAmount: 0 };
    });
    const subtotal = lines.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0);
    const deliveryFee = payload.delivery_fee ?? 0;
    const receipt: ReceiptData = {
      orderNumber: null, openedAt: order.created_at, orderType: 'delivery', tableNumber: null, lines,
      discountAmount: 0, taxAmount: 0, deliveryFee, totalAmount: subtotal + deliveryFee,
      paymentMethod: 'cash on delivery',
      delivery: payload.delivery ? { customerName: payload.delivery.customer_name, phone: payload.delivery.customer_phone, address: payload.delivery.address, barangay: payload.delivery.barangay } : null,
      business: { name: 'Oishii Nori', address: null, phone: null, tin: null, footer: 'DRAFT — NOT YET SENT TO KITCHEN' },
      cashierName: user?.name ?? null, reference: `Draft ${order.id.slice(0, 8)}`, subtotal,
      discountLabel: null, vatExempt: !!payload.force_vat_exempt, cashTendered: null, changeDue: null,
      itemCount: payload.items.reduce((count, item) => count + item.quantity, 0), payOnDelivery: true,
    };
    try { printReceipt(receipt, user?.role); }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Could not print draft slip'); }
  }

  const drafts = orders.filter((order) => order.status === 'draft');
  const processing = orders.filter((order) => order.status === 'processing');
  const sent = orders.filter((order) => order.status === 'submitted' && order.transaction && !isFinished(order.transaction));
  const completedToday = orders.filter((order) => order.status === 'submitted' && order.transaction && isFinished(order.transaction));
  const completeTx = completeTarget?.transaction ?? null;
  const completeTotal = completeTx ? orderTotal(completeTx) : 0;
  const received = Number(cashReceived);
  const cashShort = completeMethod === 'cash' && cashReceived !== '' && (!Number.isFinite(received) || received < completeTotal);

  return <DashboardLayout title="Hanged Orders">
    <div className="space-y-5 p-6">
      <div><h2 className="text-xl font-semibold">Saved delivery drafts</h2><p className="text-sm text-muted-foreground">Edit and review orders here. Drafts are not sales and are not sent to the kitchen until you choose Send &amp; print ticket. Sent orders stay below until you complete them and record the payment.</p></div>
      {processing.length > 0 && <p className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">{processing.length} order{processing.length === 1 ? '' : 's'} currently being sent to the kitchen.</p>}
      {loading ? <p className="text-sm text-muted-foreground">Loading hanged orders…</p> : drafts.length === 0 ? <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">No saved drafts. Use Hang Order on the POS screen to add one.</p> :
        <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">{drafts.map((order) => {
          const payload = order.payload;
          const total = payload.items.reduce((sum, line) => sum + line.quantity * (sizeById.get(line.product_size_id)?.size.price ?? 0), 0) + (payload.delivery_fee ?? 0);
          return <Card key={order.id}><CardContent className="space-y-3 py-4">
            <div className="flex items-start justify-between gap-3"><div><p className="font-semibold">{payload.delivery?.customer_name || 'Delivery customer'}</p><p className="text-xs text-muted-foreground">{formatTimestamp12h(order.created_at)} · Draft #{order.id.slice(0, 8)}</p></div><p className="text-lg font-bold">{formatCurrency(total)}</p></div>
            <p className="text-sm text-muted-foreground">{payload.delivery?.customer_phone} · {[payload.delivery?.address, payload.delivery?.barangay].filter(Boolean).join(', ')}{payload.delivery?.landmark ? ` (${payload.delivery.landmark})` : ''}</p>
            <ul className="text-sm">{payload.items.map((line, i) => <li key={`${line.product_size_id}-${i}`}>{line.quantity}× {sizeById.get(line.product_size_id) ? `${sizeById.get(line.product_size_id)!.product.name} (${sizeById.get(line.product_size_id)!.size.size_label})` : 'Menu item'}</li>)}</ul>
            <div className="grid gap-2 sm:grid-cols-3"><Button variant="outline" onClick={() => printDraft(order)}><Printer className="mr-1 h-4 w-4"/>Print order receipt</Button><Button variant="outline" onClick={() => setEditDraft(structuredClone(order))}><Pencil className="mr-1 h-4 w-4"/>Edit</Button><Button disabled={sendingId === order.id} onClick={() => void sendToKitchen(order)}><Send className="mr-1 h-4 w-4"/>{sendingId === order.id ? 'Sending…' : 'Send & print ticket'}</Button></div>
          </CardContent></Card>;
        })}</div>}

      <section className="space-y-3">
        <div><h2 className="text-xl font-semibold">Sent to kitchen — waiting for completion</h2><p className="text-sm text-muted-foreground">When the order is delivered and the money is in, tap Complete &amp; record payment.</p></div>
        {loading ? null : sent.length === 0 ? <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">No sent hanged orders waiting for completion.</p> :
          <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">{sent.map((order) => {
            const t = order.transaction!;
            const st = stage(t);
            const delivery = t.delivery;
            return <Card key={order.id} className={st.tone === 'delivered' ? 'border-2 border-green-500' : ''}><CardContent className="space-y-3 py-4">
              <div className="flex items-start justify-between gap-3"><div><p className="text-lg font-bold">Order #{t.order_number ?? t.id.slice(0, 8)}</p><p className="text-xs text-muted-foreground">Sent {formatTimestamp12h(t.opened_at)}</p></div><p className="text-xl font-bold">{formatCurrency(orderTotal(t))}</p></div>
              <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold ${TONE[st.tone]}`}><st.Icon className="h-3.5 w-3.5" aria-hidden="true"/> {st.label}</span>
              {delivery && <div className="text-sm"><p className="font-medium">{delivery.customer_name}</p><p className="flex items-center gap-1 text-muted-foreground"><Phone className="h-3.5 w-3.5" aria-hidden="true"/> {delivery.customer_phone}</p><p className="text-muted-foreground">{[delivery.address, delivery.barangay].filter(Boolean).join(', ')}{delivery.landmark ? ` (${delivery.landmark})` : ''}</p>{delivery.rider_name && <p className="text-xs">Rider: {delivery.rider_name}</p>}</div>}
              <ul className="text-sm">{order.payload.items.map((line, i) => <li key={`${line.product_size_id}-${i}`}>{line.quantity}× {sizeById.get(line.product_size_id) ? `${sizeById.get(line.product_size_id)!.product.name} (${sizeById.get(line.product_size_id)!.size.size_label})` : 'Menu item'}</li>)}</ul>
              <Button className="min-h-11 w-full gap-2" onClick={() => openComplete(order)}><Wallet className="h-4 w-4" aria-hidden="true"/> Complete &amp; record payment</Button>
            </CardContent></Card>;
          })}</div>}
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">Completed today</h2>
        {completedToday.length === 0 ? <p className="text-sm text-muted-foreground">None yet today.</p> :
          <div className="divide-y rounded-lg border bg-card">{completedToday.map((order) => {
            const t = order.transaction!;
            return <div key={order.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
              <span className="font-semibold">Order #{t.order_number ?? t.id.slice(0, 8)}</span>
              <span className="text-muted-foreground">{t.delivery?.customer_name ?? order.payload.delivery?.customer_name}</span>
              <Badge variant="outline" className="gap-1"><CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true"/>Paid{t.payment_method ? ` · ${PAYMENT_LABEL[t.payment_method] ?? t.payment_method}` : ''}</Badge>
              <span className="font-semibold">{formatCurrency(orderTotal(t))}</span>
            </div>;
          })}</div>}
      </section>
    </div>
    <Dialog open={!!completeTarget} onOpenChange={(open) => !open && setCompleteTarget(null)}>
      <DialogContent>
        <DialogHeader><DialogTitle>Complete order #{completeTx?.order_number}</DialogTitle><DialogDescription>Record how the customer paid. This marks the order delivered and finished.</DialogDescription></DialogHeader>
        <div className="space-y-3">
          <p className="rounded-md bg-muted px-4 py-3 text-center"><span className="block text-xs text-muted-foreground">Amount to collect</span><span className="text-3xl font-bold">{formatCurrency(completeTotal)}</span></p>
          {completeTx && completeTx.kitchen_status !== 'ready' && completeTx.kitchen_status !== 'completed' && <p className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">The kitchen hasn’t marked this order ready yet. Completing it removes it from the Kitchen Display.</p>}
          <div className="grid grid-cols-2 gap-2">{(['cash', 'gcash', 'card', 'bdo', 'maya'] as const).map((m) => <button key={m} type="button" onClick={() => { setCompleteMethod(m); setCompleteCardType(null); }} className={`rounded border py-3 text-sm ${completeMethod === m ? 'border-transparent bg-primary text-primary-foreground' : 'bg-card'}`}>{PAYMENT_LABEL[m]}</button>)}</div>
          {completeMethod === 'card' && <div className="flex gap-2">{(['debit', 'credit'] as const).map((type) => <button key={type} type="button" onClick={() => setCompleteCardType(type)} className={`flex-1 rounded border py-2 capitalize ${completeCardType === type ? 'bg-primary text-primary-foreground' : ''}`}>{type}</button>)}</div>}
          {completeMethod === 'cash' && <div className="space-y-2">
            <label className="block space-y-1 text-sm">Amount received<Input type="number" min="0" step="0.01" inputMode="decimal" value={cashReceived} onChange={(e) => setCashReceived(e.target.value)} placeholder="₱"/></label>
            <div className="flex flex-wrap gap-2">{[{ label: 'Exact', value: completeTotal }, { label: '₱200', value: 200 }, { label: '₱500', value: 500 }, { label: '₱1,000', value: 1000 }].map((option) => <Button key={option.label} type="button" size="sm" variant="outline" onClick={() => setCashReceived(String(option.value))}>{option.label}</Button>)}</div>
            {cashReceived !== '' && <p className={`text-sm font-medium ${cashShort ? 'text-destructive' : ''}`}>{cashShort ? `Short by ${formatCurrency(completeTotal - (Number.isFinite(received) ? received : 0))}` : `Change: ${formatCurrency(received - completeTotal)}`}</p>}
          </div>}
        </div>
        <DialogFooter><Button variant="outline" onClick={() => setCompleteTarget(null)}>Cancel</Button><Button onClick={() => void confirmComplete()} disabled={completing || (completeMethod === 'card' && !completeCardType) || (completeMethod === 'cash' && (cashReceived === '' || cashShort))}>{completing ? 'Saving…' : 'Complete & record payment'}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog open={!!editDraft} onOpenChange={(open) => !open && setEditDraft(null)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader><DialogTitle>Edit hanged delivery order</DialogTitle><DialogDescription>Save changes to the draft. Sending it to the kitchen creates the unpaid sale.</DialogDescription></DialogHeader>
        {editDraft && <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">{(['customer_name', 'customer_phone', 'address', 'landmark', 'barangay'] as const).map((field) => <label key={field} className="space-y-1 text-sm"><span className="capitalize">{field.replace('_', ' ')}</span><Input value={editDraft.payload.delivery?.[field] ?? ''} onChange={(e) => setEditDraft({ ...editDraft, payload: { ...editDraft.payload, delivery: { ...editDraft.payload.delivery!, [field]: e.target.value } } })}/></label>)}<label className="space-y-1 text-sm">Delivery fee<Input type="number" min="0" step="0.01" value={editDraft.payload.delivery_fee ?? ''} onChange={(e) => setEditDraft({ ...editDraft, payload: { ...editDraft.payload, delivery_fee: Number(e.target.value) } })}/></label></div>
          <div className="space-y-2"><p className="font-medium">Items</p>{editDraft.payload.items.map((line, index) => <div key={`${line.product_size_id}-${index}`} className="flex items-center gap-2"><span className="flex-1 text-sm">{sizeById.get(line.product_size_id) ? `${sizeById.get(line.product_size_id)!.product.name} (${sizeById.get(line.product_size_id)!.size.size_label})` : 'Menu item'}</span><Input className="w-20" type="number" min="1" value={line.quantity} onChange={(e) => setEditDraft({ ...editDraft, payload: { ...editDraft.payload, items: editDraft.payload.items.map((item, i) => i === index ? { ...item, quantity: Math.max(1, Number(e.target.value)) } : item) } })}/><Button variant="outline" onClick={() => setEditDraft({ ...editDraft, payload: { ...editDraft.payload, items: editDraft.payload.items.filter((_, i) => i !== index) } })}>Remove</Button></div>)}
            <label className="block space-y-1 text-sm">Add item<select className="h-10 w-full rounded-md border bg-background px-3" value="" onChange={(e) => { const size = products.flatMap((product) => product.sizes).find((candidate) => candidate.id === e.target.value); if (size && editDraft) setEditDraft({ ...editDraft, payload: { ...editDraft.payload, items: [...editDraft.payload.items, { product_size_id: size.id, quantity: 1, addons: [], held_ingredients: [] }] } }); }}><option value="" disabled>Select a menu item</option>{products.flatMap((product) => product.sizes.map((size) => <option key={size.id} value={size.id}>{product.name} ({size.size_label}) — {formatCurrency(size.price)}</option>))}</select></label>
          </div>
        </div>}
        <DialogFooter><Button variant="outline" onClick={() => setEditDraft(null)}>Cancel</Button><Button disabled={saving || !editDraft?.payload.items.length} onClick={() => void saveDraft()}>{saving ? 'Saving…' : 'Save draft'}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </DashboardLayout>;
}
