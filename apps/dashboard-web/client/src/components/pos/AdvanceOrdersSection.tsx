import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Printer } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { ApiProduct, ApiTransaction, TransactionCardType, TransactionPaymentMethod, fetchAdvanceOrders, fetchBusinessSettings, fetchProducts, fetchTransaction, rescheduleAdvanceOrder, settleTransactionPayment } from '@/lib/api';
import { printReceipt, receiptBusinessFromSettings, type ReceiptBusiness, type ReceiptData } from '@/components/pos/Receipt';
import { printReceiptAllowed } from '@/lib/printerPrefs';
import { advanceWindow, formatAdvanceTime, phInputTime, phLocalToIso } from '@/lib/advanceOrders';
import { useVisiblePolling } from '@/hooks/useVisiblePolling';
import { formatCurrency } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

export function AdvanceOrdersSection({ orderType }: { orderType: 'takeout' | 'delivery' }) {
  const { user } = useAuth();
  const [orders, setOrders] = useState<ApiTransaction[]>([]);
  const [products, setProducts] = useState<ApiProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [edit, setEdit] = useState<ApiTransaction | null>(null);
  const [newTime, setNewTime] = useState('');
  const [saving, setSaving] = useState(false);
  const [settleTarget, setSettleTarget] = useState<ApiTransaction | null>(null);
  const [settleMethod, setSettleMethod] = useState<TransactionPaymentMethod>('cash');
  const [settleCardType, setSettleCardType] = useState<TransactionCardType | null>(null);
  const [settling, setSettling] = useState(false);
  const [printingId, setPrintingId] = useState<string | null>(null);
  const [receiptBusiness, setReceiptBusiness] = useState<ReceiptBusiness | null>(null);

  useEffect(() => { fetchProducts(false).then(setProducts).catch(() => {}); }, []);
  useEffect(() => { fetchBusinessSettings().then((settings) => setReceiptBusiness(receiptBusinessFromSettings(settings))).catch(() => {}); }, []);
  const load = useCallback(() => {
    const { from, before } = advanceWindow();
    fetchAdvanceOrders(orderType, from, before)
      .then((rows) => { setOrders(rows); setError(null); })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load advance orders'))
      .finally(() => setLoading(false));
  }, [orderType]);
  useVisiblePolling(load, 30_000);

  const names = useMemo(() => {
    const map = new Map<string, string>();
    for (const product of products) for (const size of product.sizes) map.set(size.id, `${product.name} (${size.size_label})`);
    return map;
  }, [products]);

  const now = Date.now();
  const upcoming = orders.filter((row) => row.kitchen_status === 'queued' && Date.parse(row.scheduled_for!) > now + 20 * 60_000);
  const active = orders.filter((row) => row.kitchen_status !== 'completed' && !upcoming.includes(row));
  const completed = orders.filter((row) => row.kitchen_status === 'completed');
  const canReceivePayment = user && !['kitchen', 'rider', 'stocker'].includes(user.role);

  async function saveTime() {
    if (!edit) return;
    let scheduledFor: string;
    try {
      scheduledFor = phLocalToIso(newTime);
      const ahead = Date.parse(scheduledFor) - Date.now();
      if (ahead < 30 * 60_000 || ahead > 7 * 86_400_000) throw new Error('Choose a time 30 minutes to 7 days ahead');
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Invalid time'); return; }
    setSaving(true);
    try {
      const changed = await rescheduleAdvanceOrder(edit.id, scheduledFor, edit.advance_schedule_revision);
      setOrders((previous) => previous.map((row) => row.id === changed.id ? changed : row));
      setEdit(null);
      toast.success('Advance time updated; the kitchen will receive an updated ticket.');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not change the time');
      load();
    } finally { setSaving(false); }
  }

  async function reprintOrder(order: ApiTransaction) {
    setPrintingId(order.id);
    try {
      // Read the latest payment state, including a payment recorded on another tablet.
      const current = await fetchTransaction(order.id);
      if (current.status === 'voided') throw new Error('Voided orders cannot be reprinted');
      const business = receiptBusiness ?? receiptBusinessFromSettings(await fetchBusinessSettings());
      if (!receiptBusiness) setReceiptBusiness(business);
      const productCatalog = products.length ? products : await fetchProducts(false);
      if (!products.length) setProducts(productCatalog);
      const receiptNames = new Map<string, string>();
      for (const product of productCatalog) for (const size of product.sizes) receiptNames.set(size.id, `${product.name} (${size.size_label})`);
      const lines = current.items.map((item) => {
        const name = receiptNames.get(item.product_size_id);
        if (!name) throw new Error('This product is no longer in the catalog; the order slip cannot be rebuilt');
        return {
          name, quantity: item.quantity, unitPrice: item.unit_price,
          addons: item.addons.map((addon) => ({ name: addon.addon_name ?? 'Add-on', quantity: addon.quantity, unitPrice: addon.unit_price })),
        };
      });
      const deliveryFee = current.delivery?.delivery_fee ?? 0;
      const receipt: ReceiptData = {
        orderNumber: current.order_number, openedAt: current.opened_at,
        orderType: current.order_type, tableNumber: current.table_number,
        lines, discountAmount: current.discount_amount, taxAmount: current.tax_amount,
        deliveryFee, totalAmount: current.total_amount + deliveryFee,
        paymentMethod: current.payment_status === 'unpaid' ? null : current.payment_method,
        payOnDelivery: current.payment_status === 'unpaid' && current.order_type === 'delivery',
        payOnPickup: current.payment_status === 'unpaid' && current.order_type === 'takeout',
        scheduledFor: current.scheduled_for,
        pickupCustomerName: current.pickup_customer_name,
        pickupCustomerPhone: current.pickup_customer_phone,
        business, cashierName: null,
        reference: current.id.slice(0, 8).toUpperCase(),
        subtotal: current.total_amount + current.discount_amount,
        discountLabel: null, vatExempt: current.force_vat_exempt,
        cashTendered: null, changeDue: null,
        itemCount: current.items.reduce((sum, item) => sum + item.quantity, 0),
        delivery: current.delivery ? {
          customerName: current.delivery.customer_name, phone: current.delivery.customer_phone,
          address: current.delivery.address, barangay: current.delivery.barangay,
        } : null,
      };
      printReceipt(receipt, user?.role);
      setOrders((previous) => previous.map((row) => row.id === current.id ? current : row));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not reprint order slip');
    } finally { setPrintingId(null); }
  }

  async function confirmPayment() {
    if (!settleTarget) return;
    setSettling(true);
    try {
      const updated = await settleTransactionPayment(settleTarget.id, settleMethod, settleCardType);
      setOrders((previous) => previous.map((row) => row.id === updated.id ? updated : row));
      setSettleTarget(null);
      toast.success(`Payment recorded for order #${updated.order_number ?? updated.id.slice(0, 8)}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not record payment');
      load();
    } finally { setSettling(false); }
  }

  const group = (label: string, rows: ApiTransaction[]) => rows.length > 0 && <section className="space-y-2">
    <h3 className="font-corp-display font-semibold">{label} ({rows.length})</h3>
    <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">{rows.map((order) => {
      const canEdit = order.kitchen_status === 'queued' && Date.parse(order.scheduled_for!) > Date.now() + 20 * 60_000
        && (user?.role !== 'employee' || user.id === order.employee_id);
      return <Card key={order.id}><CardContent className="space-y-2 py-4">
        <div className="flex justify-between gap-2"><span className="font-bold">Order #{order.order_number ?? order.id.slice(0, 8)}</span><span className="font-semibold">{formatCurrency(order.total_amount + (order.delivery?.delivery_fee ?? 0))}</span></div>
        <p className="text-sm font-semibold">{orderType === 'delivery' ? 'Ready for rider' : 'Pickup ready'}: {formatAdvanceTime(order.scheduled_for!)}</p>
        <p className="text-sm">{orderType === 'takeout' ? order.pickup_customer_name : order.delivery?.customer_name} · {orderType === 'takeout' ? order.pickup_customer_phone : order.delivery?.customer_phone}</p>
        {orderType === 'delivery' && <p className="text-sm text-muted-foreground">{order.delivery?.address}, {order.delivery?.barangay}</p>}
        <p className="text-xs text-muted-foreground">{order.order_source.toUpperCase()} · Kitchen: {order.kitchen_status} · {order.payment_status === 'unpaid' ? orderType === 'takeout' ? 'Payment due at pickup' : 'Payment due on delivery' : `Paid by ${order.payment_method ?? 'unspecified'}`}</p>
        <ul className="text-sm text-muted-foreground">{order.items.map((item) => <li key={item.id}>{item.quantity}× {names.get(item.product_size_id) ?? 'Item'}</li>)}</ul>
        <div className="flex flex-wrap gap-2">
          {printReceiptAllowed(user?.role) && <Button size="sm" variant="outline" disabled={printingId === order.id} onClick={() => void reprintOrder(order)}><Printer className="mr-1 h-4 w-4" />{printingId === order.id ? 'Preparing slip…' : 'Reprint order slip'}</Button>}
          {canReceivePayment && order.payment_status === 'unpaid' && <Button size="sm" onClick={() => { setSettleTarget(order); setSettleMethod('cash'); setSettleCardType(null); }}>Payment received</Button>}
          {canEdit && <Button size="sm" variant="outline" onClick={() => { setEdit(order); setNewTime(phInputTime(new Date(order.scheduled_for!))); }}>Change ready time</Button>}
        </div>
      </CardContent></Card>;
    })}</div>
  </section>;

  return <div className="space-y-4">
    {loading && <p className="text-sm text-muted-foreground">Loading advance orders…</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {!loading && !error && orders.length === 0 && <p className="text-sm text-muted-foreground">No POS advance {orderType === 'takeout' ? 'pickup' : 'delivery'} orders in this period.</p>}
    {group('Upcoming', upcoming)}
    {group('Preparing or ready', active)}
    {group('Kitchen completed', completed)}
    <Dialog open={!!edit} onOpenChange={(open) => !open && !saving && setEdit(null)}>
      <DialogContent><DialogHeader><DialogTitle>Change advance ready time</DialogTitle><DialogDescription>The kitchen will receive an updated ticket. Changes are available only before preparation begins.</DialogDescription></DialogHeader>
        <div className="space-y-2"><Label htmlFor="advance-edit-time">New date and time (Philippine time)</Label><Input id="advance-edit-time" type="datetime-local" value={newTime} onChange={(e) => setNewTime(e.target.value)} /></div>
        <DialogFooter><Button variant="outline" onClick={() => setEdit(null)} disabled={saving}>Cancel</Button><Button onClick={saveTime} disabled={saving}>{saving ? 'Saving…' : 'Save time'}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog open={!!settleTarget} onOpenChange={(open) => !open && !settling && setSettleTarget(null)}>
      <DialogContent><DialogHeader><DialogTitle>Payment received for order #{settleTarget?.order_number}</DialogTitle><DialogDescription>Confirm the amount and payment method before recording payment.</DialogDescription></DialogHeader>
        <p className="rounded-md bg-muted px-4 py-3 text-center text-2xl font-bold">{settleTarget ? formatCurrency(settleTarget.total_amount + (settleTarget.delivery?.delivery_fee ?? 0)) : ''}</p>
        <div className="grid grid-cols-2 gap-2">{(['cash', 'gcash', 'card', 'bdo', 'maya'] as const).map((method) => <Button key={method} type="button" variant={settleMethod === method ? 'default' : 'outline'} onClick={() => { setSettleMethod(method); setSettleCardType(null); }}>{method === 'gcash' ? 'GCash' : method === 'bdo' ? 'BDO' : method === 'maya' ? 'Maya' : method === 'card' ? 'Card' : 'Cash'}</Button>)}</div>
        {settleMethod === 'card' && <div className="flex gap-2">{(['debit', 'credit'] as const).map((type) => <Button key={type} type="button" className="flex-1" variant={settleCardType === type ? 'default' : 'outline'} onClick={() => setSettleCardType(type)}>{type === 'debit' ? 'Debit' : 'Credit'}</Button>)}</div>}
        <DialogFooter><Button variant="outline" disabled={settling} onClick={() => setSettleTarget(null)}>Cancel</Button><Button disabled={settling || (settleMethod === 'card' && !settleCardType)} onClick={() => void confirmPayment()}>{settling ? 'Saving…' : 'Confirm payment received'}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}
