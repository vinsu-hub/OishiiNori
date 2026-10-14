import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Pencil, Printer, Send } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardLayout';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { type ApiPosHangedOrder, type ApiProduct, fetchPosHangedOrders, fetchProducts, updatePosHangedOrder, sendPosHangedOrderToKitchen } from '@/lib/api';
import { POLL_INTERVAL_MS } from '@/lib/constants';
import { formatCurrency, formatTimestamp12h } from '@/lib/utils';
import { useVisiblePolling } from '@/hooks/useVisiblePolling';
import { printReceipt, type ReceiptData } from '@/components/pos/Receipt';
import { useAuth } from '@/contexts/AuthContext';

export default function HangedOrders() {
  const { user } = useAuth();
  const [orders, setOrders] = useState<ApiPosHangedOrder[]>([]);
  const [products, setProducts] = useState<ApiProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [editDraft, setEditDraft] = useState<ApiPosHangedOrder | null>(null);
  const [saving, setSaving] = useState(false);
  const [sendingId, setSendingId] = useState<string | null>(null);

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
      setOrders((rows) => rows.filter((row) => row.id !== order.id));
      toast.success(`Order #${transaction.order_number ?? transaction.id.slice(0, 8)} sent to the kitchen as unpaid delivery`);
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Could not send order to kitchen'); }
    finally { setSendingId(null); }
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

  return <DashboardLayout title="Hanged Orders">
    <div className="space-y-5 p-6">
      <div><h2 className="text-xl font-semibold">Saved delivery drafts</h2><p className="text-sm text-muted-foreground">Edit and review orders here. Drafts are not sales and are not sent to the kitchen until you choose Send &amp; print ticket.</p></div>
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
    </div>
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
