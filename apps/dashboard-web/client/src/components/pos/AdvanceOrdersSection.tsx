import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Banknote, Bike, CalendarClock, ChefHat, CheckCircle2, Clock, Pencil, Printer, Search, ShieldAlert, ShoppingBag, Trash2 } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { AdvanceOverrideAuth, ApiProduct, ApiTransaction, TransactionCardType, TransactionPaymentMethod, fetchAdvanceOrders, fetchBusinessSettings, fetchProducts, fetchTransaction, rescheduleAdvanceOrder, settleTransactionPayment, updateAdvanceOrderItems } from '@/lib/api';
import { printReceipt, receiptBusinessFromSettings, type ReceiptBusiness, type ReceiptData } from '@/components/pos/Receipt';
import { printReceiptAllowed } from '@/lib/printerPrefs';
import { advanceWindow, formatAdvanceTime, phInputTime, phLocalToIso } from '@/lib/advanceOrders';
import { useVisiblePolling } from '@/hooks/useVisiblePolling';
import { AdvanceOverrideDialog, forgetOverrideKey, rememberOverrideKey } from '@/components/pos/AdvanceOverrideDialog';
import { formatCurrency } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

// One line in the Edit order dialog. Kept lines carry their add-ons, held
// ingredients and discount; a replaced or newly added line starts plain.
interface EditLine {
  key: string;
  product_size_id: string;
  quantity: number;
  held_ingredients: string[];
  addons: { addon_id: string; quantity: number; unit_price: number }[];
  discount_type_id: string | null;
  discount_amount: number;
  // A bundle whose rolls the kitchen already logged stays as it is.
  locked: boolean;
}

type AdvanceTab = 'upcoming' | 'kitchen' | 'done';

const KITCHEN_LABEL: Record<string, { text: string; className: string }> = {
  queued: { text: 'Waiting in kitchen', className: 'border-slate-300 bg-slate-50 text-slate-700' },
  preparing: { text: 'Preparing', className: 'border-amber-300 bg-amber-50 text-amber-900' },
  ready: { text: 'Ready', className: 'border-green-300 bg-green-50 text-green-800' },
  completed: { text: 'Done', className: 'border-green-600 bg-green-600 text-white' },
};

const PH_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' });
const PH_TIME = new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', hour: 'numeric', minute: '2-digit' });
const PH_DATE_LABEL = new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', weekday: 'short', month: 'short', day: 'numeric' });

/** "Today", "Tomorrow", "Yesterday" or "Wed, Oct 21" in Philippine time. */
function dayLabel(iso: string, now: number): string {
  const day = PH_DAY.format(new Date(iso));
  if (day === PH_DAY.format(new Date(now))) return 'Today';
  if (day === PH_DAY.format(new Date(now + 86_400_000))) return 'Tomorrow';
  if (day === PH_DAY.format(new Date(now - 86_400_000))) return 'Yesterday';
  return PH_DATE_LABEL.format(new Date(iso));
}

/** "in 2 h 15 min", "in 12 min", "15 min late". */
function relativeTime(iso: string, now: number): string {
  const minutes = Math.round((Date.parse(iso) - now) / 60_000);
  const span = (m: number) => (m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}` : `${m} min`);
  if (minutes > 0) return `in ${span(minutes)}`;
  if (minutes === 0) return 'now';
  return `${span(-minutes)} late`;
}

const PAYMENT_NAME: Record<string, string> = { cash: 'cash', gcash: 'GCash', card: 'card', bdo: 'BDO', maya: 'Maya', grab: 'Grab' };

function linesFromOrder(order: ApiTransaction): EditLine[] {
  return order.items.map((item) => ({
    key: item.id, product_size_id: item.product_size_id, quantity: item.quantity,
    held_ingredients: item.held_ingredients ?? [],
    addons: item.addons.map((addon) => ({ addon_id: addon.addon_id, quantity: addon.quantity, unit_price: addon.unit_price })),
    discount_type_id: item.discount_type_id ?? null, discount_amount: item.discount_amount ?? 0,
    locked: item.bundle_fulfilled,
  }));
}

// Plain-language difference after an edit: what the cashier must do now.
function differenceText(order: ApiTransaction, previousTotal: number, newTotal: number): string {
  const diff = Math.round((newTotal - previousTotal) * 100) / 100;
  if (order.payment_status === 'unpaid') return `New amount due: ${formatCurrency(newTotal)}`;
  if (diff > 0) return `Collect ${formatCurrency(diff)} more by ${PAYMENT_NAME[order.payment_method ?? ''] ?? order.payment_method ?? 'the same method'}`;
  if (diff < 0) return `Give back ${formatCurrency(-diff)} to the customer`;
  return 'No change in the amount paid';
}

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
  const [itemsEdit, setItemsEdit] = useState<ApiTransaction | null>(null);
  const [editLines, setEditLines] = useState<EditLine[]>([]);
  const [savingItems, setSavingItems] = useState(false);
  const [reprintPrompt, setReprintPrompt] = useState<{ order: ApiTransaction; previousTotal: number } | null>(null);
  const [tab, setTab] = useState<AdvanceTab | null>(null);
  const [search, setSearch] = useState('');
  // CEO override (executives): the order being overridden, and the key +
  // reason an override item edit is sent with.
  const [overrideTarget, setOverrideTarget] = useState<ApiTransaction | null>(null);
  const [itemsOverride, setItemsOverride] = useState<AdvanceOverrideAuth | null>(null);
  const isExecutive = user?.role === 'executive';

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

  const sizeById = useMemo(() => {
    const map = new Map<string, { productName: string; label: string; price: number }>();
    for (const product of products) for (const size of product.sizes) map.set(size.id, { productName: product.name, label: size.size_label, price: size.price });
    return map;
  }, [products]);
  const sizeOptions = useMemo(() => products.filter((product) => product.active).flatMap((product) => product.sizes
    .filter((size) => size.availability !== 'unavailable')
    .map((size) => ({ id: size.id, text: `${product.name} (${size.size_label}) — ${formatCurrency(size.price)}` }))), [products]);

  const now = Date.now();
  const byTime = (a: ApiTransaction, b: ApiTransaction) => Date.parse(a.scheduled_for!) - Date.parse(b.scheduled_for!);
  const query = search.trim().toLowerCase();
  const matches = (row: ApiTransaction) => !query || [
    String(row.order_number ?? ''), row.pickup_customer_name ?? '', row.pickup_customer_phone ?? '',
    row.delivery?.customer_name ?? '', row.delivery?.customer_phone ?? '', row.delivery?.address ?? '',
    ...row.items.map((item) => names.get(item.product_size_id) ?? ''),
  ].some((value) => value.toLowerCase().includes(query));
  const visibleOrders = orders.filter((row) => row.status !== 'voided' && matches(row));
  // Soonest first while there's work to do; most recent first once done.
  const upcoming = visibleOrders.filter((row) => row.kitchen_status === 'queued' && Date.parse(row.scheduled_for!) > now + 20 * 60_000).sort(byTime);
  const active = visibleOrders.filter((row) => row.kitchen_status !== 'completed' && !upcoming.includes(row)).sort(byTime);
  const completed = visibleOrders.filter((row) => row.kitchen_status === 'completed').sort((a, b) => byTime(b, a));
  const canReceivePayment = user && !['kitchen', 'rider', 'stocker'].includes(user.role);
  // Open on whatever needs attention first, until the cashier picks a tab.
  const currentTab: AdvanceTab = tab ?? (active.length ? 'kitchen' : upcoming.length ? 'upcoming' : 'done');

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

  function openItemsEdit(order: ApiTransaction, override: AdvanceOverrideAuth | null = null) {
    setItemsOverride(override);
    setItemsEdit(order);
    setEditLines(linesFromOrder(order));
  }

  // Estimate only: the server recomputes discounts and totals on save, and
  // the reprint prompt shows the exact difference.
  const editEstimate = useMemo(() => {
    if (!itemsEdit) return 0;
    const fee = itemsEdit.delivery?.delivery_fee ?? 0;
    const itemDiscounts = itemsEdit.items.some((item) => (item.discount_amount ?? 0) > 0);
    const gross = editLines.reduce((sum, line) => sum + (sizeById.get(line.product_size_id)?.price ?? 0) * line.quantity
      + line.addons.reduce((a, addon) => a + addon.unit_price * addon.quantity, 0), 0);
    const lineDiscounts = editLines.reduce((sum, line) => sum + (line.discount_type_id ? line.discount_amount : 0), 0);
    const orderRate = !itemDiscounts && itemsEdit.discount_amount > 0
      ? itemsEdit.discount_amount / (itemsEdit.total_amount + itemsEdit.discount_amount) : 0;
    return gross - lineDiscounts - gross * orderRate + fee;
  }, [itemsEdit, editLines, sizeById]);

  const editChanged = !!itemsEdit && JSON.stringify(linesFromOrder(itemsEdit).map(({ key: _k, ...rest }) => rest))
    !== JSON.stringify(editLines.map(({ key: _k, ...rest }) => rest));

  function updateLine(key: string, patch: Partial<EditLine>) {
    setEditLines((lines) => lines.map((line) => line.key === key ? { ...line, ...patch } : line));
  }

  async function saveItems() {
    if (!itemsEdit || !editLines.length) return;
    if (editLines.some((line) => !Number.isFinite(line.quantity) || line.quantity < 1)) { toast.error('Each item needs a quantity of at least 1'); return; }
    setSavingItems(true);
    const previousTotal = itemsEdit.total_amount + (itemsEdit.delivery?.delivery_fee ?? 0);
    try {
      const changed = await updateAdvanceOrderItems(itemsEdit.id, editLines.map((line) => ({
        product_size_id: line.product_size_id, quantity: line.quantity, held_ingredients: line.held_ingredients,
        addons: line.addons.map(({ addon_id, quantity }) => ({ addon_id, quantity })), discount_type_id: line.discount_type_id,
      })), itemsEdit.advance_schedule_revision, itemsOverride ?? undefined);
      setOrders((previous) => previous.map((row) => row.id === changed.id ? changed : row));
      setItemsEdit(null);
      if (itemsOverride) rememberOverrideKey(itemsOverride.override_key);
      toast.success(changed.kitchen_status === 'completed'
        ? `Order #${changed.order_number ?? changed.id.slice(0, 8)} updated; it stays done, so no new kitchen ticket.`
        : `Order #${changed.order_number ?? changed.id.slice(0, 8)} updated; the kitchen will get an updated ticket.`);
      setReprintPrompt({ order: changed, previousTotal });
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Could not update the order';
      if (itemsOverride && /override key/i.test(message)) forgetOverrideKey();
      toast.error(/changed|preparation window/i.test(message) ? 'This order changed or the kitchen has started it — refresh and try again' : message);
      load();
    } finally { setSavingItems(false); }
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
          discountName: item.discount_name,
          discountAmount: item.discount_amount,
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
        discountLabel: (() => {
          const discounted = current.items.find((item) => (item.discount_amount ?? 0) > 0);
          return discounted ? `${discounted.discount_name ?? 'Discount'} (${discounted.discount_percentage ?? 0}%) · 1 × ${receiptNames.get(discounted.product_size_id) ?? 'item'}` : null;
        })(), vatExempt: current.force_vat_exempt || current.items.some((item) => item.discount_vat_exempt),
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

  const card = (order: ApiTransaction) => {
    const canEditItems = order.status !== 'voided' && !!canReceivePayment;
    const canEdit = order.kitchen_status === 'queued' && Date.parse(order.scheduled_for!) > Date.now() + 20 * 60_000
      && !!canReceivePayment;
    const done = order.kitchen_status === 'completed';
    const minutesAway = (Date.parse(order.scheduled_for!) - now) / 60_000;
    // Amber: due within the hour; red: past its time and not done yet.
    const urgency = done ? '' : minutesAway < 0 ? 'border-l-red-600' : minutesAway <= 60 ? 'border-l-amber-500' : 'border-l-transparent';
    const kitchen = KITCHEN_LABEL[order.kitchen_status] ?? { text: order.kitchen_status, className: '' };
    const customerName = orderType === 'takeout' ? order.pickup_customer_name : order.delivery?.customer_name;
    const customerPhone = orderType === 'takeout' ? order.pickup_customer_phone : order.delivery?.customer_phone;
    const unpaid = order.payment_status === 'unpaid';
    return <Card key={order.id} className={`flex flex-col border-l-4 ${urgency} ${done ? 'opacity-80' : ''}`}>
      <CardContent className="flex flex-1 flex-col gap-3 py-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{orderType === 'delivery' ? 'Ready for rider' : 'Pickup ready'}</p>
            <p className="font-corp-display text-2xl font-bold leading-tight">{PH_TIME.format(new Date(order.scheduled_for!))}</p>
            <p className={`text-xs font-semibold ${!done && minutesAway < 0 ? 'text-red-700' : 'text-muted-foreground'}`}>
              {dayLabel(order.scheduled_for!, now)}{done ? '' : ` · ${relativeTime(order.scheduled_for!, now)}`}
            </p>
          </div>
          <div className="text-right">
            <p className="font-bold">#{order.order_number ?? order.id.slice(0, 8)}</p>
            <p className="text-lg font-semibold tabular-nums">{formatCurrency(order.total_amount + (order.delivery?.delivery_fee ?? 0))}</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Badge variant="outline" className={`gap-1 ${kitchen.className}`}>
            {done ? <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> : <ChefHat className="h-3.5 w-3.5" aria-hidden />}{kitchen.text}
          </Badge>
          <Badge variant={unpaid ? 'destructive' : 'outline'} className="gap-1">
            <Banknote className="h-3.5 w-3.5" aria-hidden />
            {unpaid ? (orderType === 'takeout' ? 'Pay at pickup' : 'Pay on delivery') : `Paid · ${PAYMENT_NAME[order.payment_method ?? ''] ?? order.payment_method ?? '—'}`}
          </Badge>
          <Badge variant="secondary" className="gap-1">
            {orderType === 'delivery' ? <Bike className="h-3.5 w-3.5" aria-hidden /> : <ShoppingBag className="h-3.5 w-3.5" aria-hidden />}
            {order.order_source === 'online' ? 'Online' : order.order_source.toUpperCase()}
          </Badge>
        </div>
        <div className="text-sm">
          <p className="font-medium">{customerName || 'No name'}</p>
          {customerPhone && <a className="text-muted-foreground underline-offset-2 hover:underline" href={`tel:${customerPhone}`}>{customerPhone}</a>}
          {orderType === 'delivery' && order.delivery?.address && <p className="text-muted-foreground">{[order.delivery.address, order.delivery.barangay].filter(Boolean).join(', ')}</p>}
        </div>
        <ul className="space-y-0.5 rounded-md bg-muted/60 px-3 py-2 text-sm">
          {order.items.map((item) => <li key={item.id} className="flex gap-2"><span className="font-semibold tabular-nums">{item.quantity}×</span><span>{names.get(item.product_size_id) ?? 'Item'}</span></li>)}
        </ul>
        <div className="mt-auto flex flex-wrap gap-2 pt-1">
          {canReceivePayment && unpaid && <Button size="sm" className="gap-1" onClick={() => { setSettleTarget(order); setSettleMethod('cash'); setSettleCardType(null); }}><Banknote className="h-4 w-4" />Payment received</Button>}
          {printReceiptAllowed(user?.role) && <Button size="sm" variant="outline" disabled={printingId === order.id} onClick={() => void reprintOrder(order)}><Printer className="mr-1 h-4 w-4" />{printingId === order.id ? 'Preparing…' : 'Reprint slip'}</Button>}
          {canEditItems && !done && <Button size="sm" variant="outline" onClick={() => openItemsEdit(order)}><Pencil className="mr-1 h-4 w-4" />Edit</Button>}
          {canEdit && <Button size="sm" variant="outline" onClick={() => { setEdit(order); setNewTime(phInputTime(new Date(order.scheduled_for!))); }}><Clock className="mr-1 h-4 w-4" />Change time</Button>}
          {canEditItems && done && <Button size="sm" variant="ghost" onClick={() => openItemsEdit(order)}><Pencil className="mr-1 h-4 w-4" />Edit</Button>}
          {isExecutive && <Button size="sm" variant="outline" className="gap-1 border-red-300 text-red-700 hover:bg-red-50 hover:text-red-800" onClick={() => setOverrideTarget(order)}><ShieldAlert className="h-4 w-4" aria-hidden />CEO override</Button>}
        </div>
      </CardContent>
    </Card>;
  };

  // Day headers ("Today", "Tomorrow", …) over a grid of cards.
  const byDay = (rows: ApiTransaction[]) => {
    const groups: { label: string; rows: ApiTransaction[] }[] = [];
    for (const row of rows) {
      const label = dayLabel(row.scheduled_for!, now);
      const last = groups[groups.length - 1];
      if (last && last.label === label) last.rows.push(row);
      else groups.push({ label, rows: [row] });
    }
    return groups.map((group) => <section key={group.label} className="space-y-2">
      <h3 className="flex items-center gap-2 font-corp-display text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        <CalendarClock className="h-4 w-4" aria-hidden />{group.label}<span className="font-normal normal-case">({group.rows.length})</span>
      </h3>
      <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">{group.rows.map(card)}</div>
    </section>);
  };

  const tabs: { key: AdvanceTab; label: string; rows: ApiTransaction[]; empty: string }[] = [
    { key: 'kitchen', label: 'In the kitchen', rows: active, empty: 'Nothing in the kitchen right now.' },
    { key: 'upcoming', label: 'Upcoming', rows: upcoming, empty: 'No upcoming advance orders.' },
    { key: 'done', label: 'Done', rows: completed, empty: 'No finished advance orders in the last 7 days.' },
  ];
  const shown = tabs.find((t) => t.key === currentTab)!;

  return <div className="space-y-4">
    {loading && <p className="text-sm text-muted-foreground">Loading advance orders…</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {!loading && !error && orders.length === 0 && <p className="text-sm text-muted-foreground">No POS advance {orderType === 'takeout' ? 'pickup' : 'delivery'} orders in this period.</p>}
    {!loading && orders.length > 0 && <div className="flex flex-wrap items-center gap-2">
      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Advance order status">
        {tabs.map((t) => <Button key={t.key} role="tab" aria-selected={currentTab === t.key} variant={currentTab === t.key ? 'default' : 'outline'} className="min-h-10 gap-2" onClick={() => setTab(t.key)}>
          {t.label}
          <span className={`rounded-full px-2 text-xs ${currentTab === t.key ? 'bg-primary-foreground/20' : 'bg-muted'}`}>{t.rows.length}</span>
        </Button>)}
      </div>
      <div className="relative ml-auto w-full max-w-xs">
        <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" aria-hidden />
        <Input className="pl-9" placeholder="Search name, phone, order #, item" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search advance orders" />
      </div>
    </div>}
    {!loading && orders.length > 0 && (shown.rows.length === 0
      ? <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">{query ? 'No orders match your search.' : shown.empty}</p>
      : byDay(shown.rows))}
    <Dialog open={!!edit} onOpenChange={(open) => !open && !saving && setEdit(null)}>
      <DialogContent><DialogHeader><DialogTitle>Change advance ready time</DialogTitle><DialogDescription>The kitchen will receive an updated ticket. Changes are available only before preparation begins.</DialogDescription></DialogHeader>
        <div className="space-y-2"><Label htmlFor="advance-edit-time">New date and time (Philippine time)</Label><Input id="advance-edit-time" type="datetime-local" value={newTime} onChange={(e) => setNewTime(e.target.value)} /></div>
        <DialogFooter><Button variant="outline" onClick={() => setEdit(null)} disabled={saving}>Cancel</Button><Button onClick={saveTime} disabled={saving}>{saving ? 'Saving…' : 'Save time'}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog open={!!itemsEdit} onOpenChange={(open) => !open && !savingItems && setItemsEdit(null)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader><DialogTitle>Edit order #{itemsEdit?.order_number}</DialogTitle><DialogDescription>Add, remove or replace items. The kitchen gets an updated ticket.</DialogDescription></DialogHeader>
        {itemsEdit && itemsOverride && <p className="rounded-md border border-red-300 bg-red-50 p-2 text-sm text-red-900">CEO override{itemsEdit.kitchen_status === 'completed' ? ': this order is done and stays done — it is not sent back to the kitchen.' : '.'}</p>}
        {itemsEdit && itemsEdit.kitchen_status !== 'queued' && !(itemsOverride && itemsEdit.kitchen_status === 'completed') && <p className="rounded-md border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900">The kitchen has already {itemsEdit.kitchen_status === 'completed' ? 'completed' : itemsEdit.kitchen_status === 'ready' ? 'readied' : 'started'} this order. Saving sends it back to the kitchen queue with the updated items.</p>}
        <div className="space-y-2">
          {editLines.map((line) => line.locked ? <div key={line.key} className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/50 p-2 text-sm">
            <span className="flex-1">{line.quantity}× {names.get(line.product_size_id) ?? 'Bundle'}</span>
            <span className="text-xs text-muted-foreground">Bundle already made — can't be changed</span>
          </div> : <div key={line.key} className="flex flex-wrap items-center gap-2 rounded-md border p-2">
            <select aria-label="Item" className="h-10 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm" value={line.product_size_id}
              onChange={(e) => updateLine(line.key, { product_size_id: e.target.value, addons: [], held_ingredients: [], discount_type_id: null, discount_amount: 0 })}>
              {!sizeOptions.some((option) => option.id === line.product_size_id) && <option value={line.product_size_id}>{names.get(line.product_size_id) ?? 'Item'}</option>}
              {sizeOptions.map((option) => <option key={option.id} value={option.id}>{option.text}</option>)}
            </select>
            <Input aria-label="Quantity" className="w-20" type="number" min="1" step="1" value={line.quantity}
              onChange={(e) => updateLine(line.key, { quantity: Math.max(1, Math.floor(Number(e.target.value) || 1)) })} />
            <Button type="button" variant="outline" size="icon" aria-label="Remove item" onClick={() => setEditLines((lines) => lines.filter((l) => l.key !== line.key))}><Trash2 className="h-4 w-4" /></Button>
            {(line.addons.length > 0 || line.held_ingredients.length > 0 || line.discount_type_id) && <p className="w-full text-xs text-muted-foreground">
              {[line.addons.length ? `${line.addons.length} add-on${line.addons.length > 1 ? 's' : ''} kept` : '', line.held_ingredients.length ? `No ${line.held_ingredients.join(', ')}` : '', line.discount_type_id ? 'Discount kept' : ''].filter(Boolean).join(' · ')}
            </p>}
          </div>)}
          {editLines.length === 0 && <p className="text-sm text-destructive">An order needs at least one item.</p>}
          <select aria-label="Add item" className="h-10 w-full rounded-md border bg-background px-3 text-sm" value=""
            onChange={(e) => { const id = e.target.value; if (id) setEditLines((lines) => [...lines, { key: `new-${Date.now()}`, product_size_id: id, quantity: 1, held_ingredients: [], addons: [], discount_type_id: null, discount_amount: 0, locked: false }]); }}>
            <option value="" disabled>+ Add item</option>
            {sizeOptions.map((option) => <option key={option.id} value={option.id}>{option.text}</option>)}
          </select>
        </div>
        {itemsEdit && <div className="space-y-1 rounded-md bg-muted px-4 py-3 text-sm">
          <p className="flex justify-between"><span>Current total</span><span>{formatCurrency(itemsEdit.total_amount + (itemsEdit.delivery?.delivery_fee ?? 0))}</span></p>
          <p className="flex justify-between font-semibold"><span>New total (estimate)</span><span>{formatCurrency(editEstimate)}</span></p>
          {editChanged && <p className="font-semibold">{differenceText(itemsEdit, itemsEdit.total_amount + (itemsEdit.delivery?.delivery_fee ?? 0), editEstimate)}</p>}
        </div>}
        <DialogFooter><Button variant="outline" onClick={() => setItemsEdit(null)} disabled={savingItems}>Cancel</Button><Button onClick={() => void saveItems()} disabled={savingItems || !editChanged || !editLines.length}>{savingItems ? 'Saving…' : 'Save changes'}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
    <AdvanceOverrideDialog
      order={overrideTarget}
      onClose={() => setOverrideTarget(null)}
      onUpdated={(changed, reprint) => {
        setOrders((previous) => previous.map((row) => row.id === changed.id ? changed : row));
        if (reprint) setReprintPrompt({ order: changed, previousTotal: changed.total_amount + (changed.delivery?.delivery_fee ?? 0) });
      }}
      onErased={(id) => setOrders((previous) => previous.filter((row) => row.id !== id))}
      onEditItems={(order, auth) => openItemsEdit(order, auth)}
    />
    <Dialog open={!!reprintPrompt} onOpenChange={(open) => !open && setReprintPrompt(null)}>
      <DialogContent><DialogHeader><DialogTitle>Reprint receipt?</DialogTitle><DialogDescription>Order #{reprintPrompt?.order.order_number} was changed. Print the new receipt for the customer.</DialogDescription></DialogHeader>
        {reprintPrompt && <div className="space-y-1 rounded-md bg-muted px-4 py-3 text-center">
          <p className="text-2xl font-bold">{formatCurrency(reprintPrompt.order.total_amount + (reprintPrompt.order.delivery?.delivery_fee ?? 0))}</p>
          <p className="text-sm font-semibold">{differenceText(reprintPrompt.order, reprintPrompt.previousTotal, reprintPrompt.order.total_amount + (reprintPrompt.order.delivery?.delivery_fee ?? 0))}</p>
        </div>}
        <DialogFooter>
          <Button variant="outline" onClick={() => setReprintPrompt(null)}>Not now</Button>
          {printReceiptAllowed(user?.role) && <Button disabled={!!printingId} onClick={() => { const target = reprintPrompt!.order; setReprintPrompt(null); void reprintOrder(target); }}><Printer className="mr-1 h-4 w-4" />Print new receipt</Button>}
        </DialogFooter>
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
