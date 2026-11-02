import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  type ApiDigitalOrder,
  type ApiOnlineOrderChange,
  type ApiProduct,
  apiErrorDetail,
  changeOnlineOrderPayment,
  editOnlineOrderItems,
  scheduleOnlineOrder,
} from '@/lib/api';
import { phInputTime, phLocalToIso } from '@/lib/advanceOrders';
import { formatCurrency, formatTimestamp12h } from '@/lib/utils';
import { OrderItemLinesEditor, type EditLine } from './OrderItemLinesEditor';

function ReasonField({ id, value, onChange, placeholder }: { id: string; value: string; onChange: (value: string) => void; placeholder: string }) {
  return <div className="space-y-1">
    <Label htmlFor={id}>Reason (required)</Label>
    <Input id={id} value={value} maxLength={500} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
  </div>;
}

function methodLabel(method: string): string {
  return method === 'cash' ? 'Cash' : method;
}

/** Plain-language summary of one recorded change, for the order details and history. */
export function describeOrderChange(change: ApiOnlineOrderChange): string {
  if (change.kind === 'payment') {
    return `Payment: ${methodLabel(String(change.before.payment_method))} → ${methodLabel(String(change.after.payment_method))}`;
  }
  if (change.kind === 'schedule') return `Scheduled for ${formatTimestamp12h(String(change.after.scheduled_for))}`;
  return `Items: ${change.after.note ?? 'changed'} · total ${formatCurrency(Number(change.before.total))} → ${formatCurrency(Number(change.after.total))}`;
}

export function ChangePaymentDialog({ order, methods, onClose, onSaved }: {
  order: ApiDigitalOrder | null;
  methods: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [method, setMethod] = useState('cash');
  const [reason, setReason] = useState('');
  const [reference, setReference] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!order) return;
    setMethod(['cash', ...methods].find((name) => name.toLowerCase() !== order.payment_method.toLowerCase()) ?? 'cash');
    setReason('');
    setReference('');
  }, [order, methods]);
  if (!order) return null;
  const settlesNow = order.payment_status === 'unpaid' && method !== 'cash';

  async function save() {
    if (!order) return;
    if (!reason.trim()) { toast.error('A reason is required'); return; }
    setSaving(true);
    try {
      await changeOnlineOrderPayment(order.id, { payment_method: method, reason: reason.trim(), reference: reference.trim() || null });
      toast.success(`Payment changed to ${methodLabel(method)}`);
      onSaved();
    } catch (e) {
      toast.error(apiErrorDetail(e, 'Could not change the payment'));
    } finally {
      setSaving(false);
    }
  }

  return <Dialog open onOpenChange={(open) => !open && !saving && onClose()}>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Change payment</DialogTitle>
        <DialogDescription>Currently {methodLabel(order.payment_method)}{order.payment_status === 'unpaid' ? ', not paid yet' : ''}.</DialogDescription>
      </DialogHeader>
      <div className="space-y-1">
        <Label htmlFor="change-payment-method">The customer pays by</Label>
        <select id="change-payment-method" className="h-10 w-full rounded-md border bg-background px-3 text-sm" value={method} onChange={(e) => setMethod(e.target.value)}>
          {['cash', ...methods].filter((name) => name.toLowerCase() !== order.payment_method.toLowerCase()).map((name) => <option key={name} value={name}>{methodLabel(name)}</option>)}
        </select>
      </div>
      {settlesNow && <p className="rounded-md border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900">Saving records this order as <b>paid now</b> by {method}. Check that the money has arrived.</p>}
      {method !== 'cash' && <div className="space-y-1">
        <Label htmlFor="change-payment-reference">Reference number (optional)</Label>
        <Input id="change-payment-reference" value={reference} maxLength={120} onChange={(e) => setReference(e.target.value)} />
      </div>}
      <ReasonField id="change-payment-reason" value={reason} onChange={setReason} placeholder="e.g. Customer paid the rider by GCash" />
      <DialogFooter className="gap-2">
        <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
        <Button onClick={() => void save()} disabled={saving}>{saving ? 'Saving…' : 'Save payment'}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

export function ScheduleOrderDialog({ order, onClose, onSaved }: {
  order: ApiDigitalOrder | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [time, setTime] = useState('');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!order) return;
    setTime(order.scheduled_for ? phInputTime(new Date(order.scheduled_for)) : '');
    setReason('');
  }, [order]);
  if (!order) return null;
  const inKitchen = !!order.transaction_id;

  async function save() {
    if (!order) return;
    if (!reason.trim()) { toast.error('A reason is required'); return; }
    let scheduledFor: string;
    try {
      scheduledFor = phLocalToIso(time);
      const ahead = Date.parse(scheduledFor) - Date.now();
      if (ahead < 30 * 60_000 || ahead > 7 * 86_400_000) throw new Error('Choose a time 30 minutes to 7 days ahead');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Invalid time');
      return;
    }
    setSaving(true);
    try {
      await scheduleOnlineOrder(order.id, { scheduled_for: scheduledFor, reason: reason.trim() });
      toast.success(`Scheduled for ${formatTimestamp12h(scheduledFor)}`);
      onSaved();
    } catch (e) {
      toast.error(apiErrorDetail(e, 'Could not schedule the order'));
    } finally {
      setSaving(false);
    }
  }

  return <Dialog open onOpenChange={(open) => !open && !saving && onClose()}>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Schedule for later</DialogTitle>
        <DialogDescription>The kitchen can't start this order until 20 minutes before the time you choose.</DialogDescription>
      </DialogHeader>
      {inKitchen && <p className="rounded-md border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900">This order is already in the kitchen. A new ticket with the date prints right away, so the kitchen knows to stop. Tell them too if they've started.</p>}
      <div className="space-y-1">
        <Label htmlFor="schedule-order-time">Date and time (Philippine time)</Label>
        <Input id="schedule-order-time" type="datetime-local" value={time} onChange={(e) => setTime(e.target.value)} />
      </div>
      <ReasonField id="schedule-order-reason" value={reason} onChange={setReason} placeholder="e.g. Customer messaged that it's for Saturday" />
      <DialogFooter className="gap-2">
        <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
        <Button onClick={() => void save()} disabled={saving || !time}>{saving ? 'Saving…' : 'Schedule order'}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

export function EditOrderItemsDialog({ order, products, onClose, onSaved }: {
  order: ApiDigitalOrder | null;
  products: ApiProduct[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [lines, setLines] = useState<EditLine[]>([]);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  const sizes = useMemo(() => {
    const map = new Map<string, { name: string; price: number; deposit: number; bowl: boolean }>();
    for (const product of products) for (const size of product.sizes) {
      map.set(size.id, { name: `${product.name} (${size.size_label})`, price: size.price, deposit: size.deposit_amount ?? 0, bowl: !!product.takeout_bowl_eligible });
    }
    return map;
  }, [products]);
  const names = useMemo(() => new Map(Array.from(sizes, ([id, size]) => [id, size.name])), [sizes]);
  // Same catalog customers order from; boats carry deposits, so they stay out.
  const sizeOptions = useMemo(() => products
    .filter((product) => product.active && !['packaging', 'dine'].includes(product.category.trim().toLowerCase()))
    .flatMap((product) => product.sizes
      .filter((size) => size.availability !== 'unavailable' && !size.deposit_amount)
      .map((size) => ({ id: size.id, text: `${product.name} (${size.size_label}) — ${formatCurrency(size.price)}` }))), [products]);

  const isEditable = (item: ApiDigitalOrder['items'][number]) => !item.is_promo && !sizes.get(item.product_size_id)?.deposit;
  useEffect(() => {
    if (!order) return;
    setLines(order.items.filter(isEditable).map((item) => ({
      key: item.id, product_size_id: item.product_size_id, quantity: item.quantity, held_ingredients: item.held_ingredients,
      addons: [], discount_type_id: null, discount_amount: 0, locked: false,
    })));
    setReason('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order, sizes]);
  if (!order) return null;

  const kept = order.items.filter((item) => !isEditable(item));
  const lineCost = (sizeId: string, quantity: number, price?: number) =>
    (price ?? sizes.get(sizeId)?.price ?? 0) * quantity + (sizes.get(sizeId)?.bowl ? 10 * quantity : 0);
  const before = order.items.filter(isEditable).reduce((sum, item) => sum + lineCost(item.product_size_id, item.quantity, item.unit_price), 0);
  const after = lines.reduce((sum, line) => sum + lineCost(line.product_size_id, line.quantity), 0);
  const difference = Math.round((after - before) * 100) / 100;
  const currentTotal = order.subtotal + (order.packaging_fee ?? 0) + (order.delivery?.delivery_fee ?? 0);
  const paid = order.transaction_id ? order.payment_status !== 'unpaid' : order.payment_method !== 'cash';
  const changed = JSON.stringify(order.items.filter(isEditable).map((i) => [i.product_size_id, i.quantity]))
    !== JSON.stringify(lines.map((l) => [l.product_size_id, l.quantity]));
  const started = order.kitchen_status && order.kitchen_status !== 'queued';

  async function save() {
    if (!order) return;
    if (!reason.trim()) { toast.error('A reason is required'); return; }
    setSaving(true);
    try {
      const result = await editOnlineOrderItems(order.id, {
        items: lines.map((line) => ({ product_size_id: line.product_size_id, quantity: line.quantity, held_ingredients: line.held_ingredients })),
        reason: reason.trim(),
        expected_revision: order.edit_revision ?? 0,
      });
      const diff = Math.round(result.difference * 100) / 100;
      toast.success(!paid ? `Order updated. New amount due: ${formatCurrency(result.total)}`
        : diff > 0 ? `Order updated. Collect ${formatCurrency(diff)} more.`
        : diff < 0 ? `Order updated. Give back ${formatCurrency(-diff)}.`
        : 'Order updated.');
      onSaved();
    } catch (e) {
      toast.error(apiErrorDetail(e, 'Could not update the order'));
    } finally {
      setSaving(false);
    }
  }

  return <Dialog open onOpenChange={(open) => !open && !saving && onClose()}>
    <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
      <DialogHeader>
        <DialogTitle>Edit items</DialogTitle>
        <DialogDescription>Add, remove or replace items on this order instead of entering a second one.</DialogDescription>
      </DialogHeader>
      {started && <p className="rounded-md border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900">The kitchen has already started this order. Saving sends it back to the queue, and a new ticket prints saying what was added or removed.</p>}
      <OrderItemLinesEditor lines={lines} onChange={setLines} sizeOptions={sizeOptions} names={names} allowEmpty={kept.length > 0} />
      {(kept.length > 0 || order.addons.length > 0) && <p className="text-xs text-muted-foreground">
        Kept as they are: {[...kept.map((item) => `${item.quantity}× ${names.get(item.product_size_id) ?? 'Item'}${item.is_promo ? ' (free)' : ''}`),
          ...order.addons.map((addon) => `${addon.quantity}× ${addon.addon_name || 'Add-on'}`)].join(', ')}
      </p>}
      <div className="space-y-1 rounded-md bg-muted px-4 py-3 text-sm">
        <p className="flex justify-between"><span>Current total</span><span>{formatCurrency(currentTotal)}</span></p>
        <p className="flex justify-between font-semibold"><span>New total</span><span>{formatCurrency(currentTotal + difference)}</span></p>
        {changed && paid && difference > 0 && <p className="font-semibold">Collect {formatCurrency(difference)} more</p>}
        {changed && paid && difference < 0 && <p className="font-semibold">Give back {formatCurrency(-difference)} to the customer</p>}
      </div>
      <ReasonField id="edit-items-reason" value={reason} onChange={setReason} placeholder="e.g. Customer added an order by Facebook" />
      <DialogFooter className="gap-2">
        <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
        <Button onClick={() => void save()} disabled={saving || !changed || (lines.length === 0 && kept.length === 0)}>{saving ? 'Saving…' : 'Save changes'}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
