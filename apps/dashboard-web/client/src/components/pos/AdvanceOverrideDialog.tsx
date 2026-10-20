import { useEffect, useState } from 'react';
import { Link } from 'wouter';
import { toast } from 'sonner';
import { Ban, CheckCircle2, ChevronLeft, Clock, Pencil, Trash2, UserRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  type AdvanceOverrideAuth,
  type ApiTransaction,
  type TransactionCardType,
  type TransactionPaymentMethod,
  apiErrorDetail,
  fetchOverrideKeyStatus,
  overrideAdvanceCustomer,
  overrideCompleteAdvance,
  overrideEraseAdvance,
  overrideRescheduleAdvance,
  overrideVoidAdvance,
} from '@/lib/api';
import { phInputTime, phLocalToIso } from '@/lib/advanceOrders';
import { formatCurrency } from '@/lib/utils';

type Step = 'menu' | 'complete' | 'time' | 'items' | 'customer' | 'void' | 'erase';

// The key is remembered in memory only (never storage) for a few minutes, so
// several fixes in a row don't ask again.
const KEY_MEMORY_MS = 5 * 60_000;
let rememberedKey: { key: string; until: number } | null = null;

function recalledKey(): string {
  return rememberedKey && rememberedKey.until > Date.now() ? rememberedKey.key : '';
}

const ACTIONS: { step: Exclude<Step, 'menu'>; label: string; hint: string; icon: typeof Clock; danger?: boolean }[] = [
  { step: 'complete', label: 'Force complete', hint: 'Mark it done and handed over now, at any stage. Records the payment if unpaid.', icon: CheckCircle2 },
  { step: 'time', label: 'Change time', hint: 'Any time, even after the kitchen started.', icon: Clock },
  { step: 'items', label: 'Edit items', hint: 'Also on finished orders, which stay finished.', icon: Pencil },
  { step: 'customer', label: 'Edit customer', hint: 'Name, phone and delivery address.', icon: UserRound },
  { step: 'void', label: 'Cancel order (void)', hint: 'Stock goes back; it stays in reports as voided with your reason.', icon: Ban, danger: true },
  { step: 'erase', label: 'Delete permanently', hint: 'For test or duplicate orders. Gone from every report. Can’t be undone.', icon: Trash2, danger: true },
];

const METHODS: { value: TransactionPaymentMethod; label: string }[] = [
  { value: 'cash', label: 'Cash' }, { value: 'gcash', label: 'GCash' }, { value: 'card', label: 'Card' },
  { value: 'bdo', label: 'BDO' }, { value: 'maya', label: 'Maya' },
];

/** Advance Orders' CEO override (executives only): every action needs the
 * executive's own override key (Settings) and a reason. */
export function AdvanceOverrideDialog({
  order,
  onClose,
  onUpdated,
  onErased,
  onEditItems,
}: {
  order: ApiTransaction | null;
  onClose: () => void;
  onUpdated: (order: ApiTransaction, reprint: boolean) => void;
  onErased: (id: string) => void;
  /** Opens the item editor in override mode with this key and reason. */
  onEditItems: (order: ApiTransaction, auth: AdvanceOverrideAuth) => void;
}) {
  const [step, setStep] = useState<Step>('menu');
  const [key, setKey] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [method, setMethod] = useState<TransactionPaymentMethod>('cash');
  const [cardType, setCardType] = useState<TransactionCardType | null>(null);
  const [time, setTime] = useState('');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [barangay, setBarangay] = useState('');
  const [landmark, setLandmark] = useState('');

  const isDelivery = order?.order_type === 'delivery';
  const unpaid = order?.payment_status === 'unpaid';

  useEffect(() => {
    if (!order) return;
    setStep('menu');
    setKey(recalledKey());
    setReason('');
    setMethod('cash');
    setCardType(null);
    setTime(order.scheduled_for ? phInputTime(new Date(order.scheduled_for)) : '');
    setName((isDelivery ? order.delivery?.customer_name : order.pickup_customer_name) ?? '');
    setPhone((isDelivery ? order.delivery?.customer_phone : order.pickup_customer_phone) ?? '');
    setAddress(order.delivery?.address ?? '');
    setBarangay(order.delivery?.barangay ?? '');
    setLandmark(order.delivery?.landmark ?? '');
    fetchOverrideKeyStatus().then((r) => setHasKey(r.is_set)).catch(() => setHasKey(null));
  }, [order, isDelivery]);

  if (!order) return null;
  const number = `#${order.order_number ?? order.id.slice(0, 8)}`;
  const auth = (): AdvanceOverrideAuth => ({ override_key: key.trim(), reason: reason.trim() });
  const ready = !!key.trim() && !!reason.trim() && hasKey !== false && !busy;

  async function run(action: () => Promise<void>) {
    setBusy(true);
    try {
      await action();
      rememberedKey = { key: key.trim(), until: Date.now() + KEY_MEMORY_MS };
      onClose();
    } catch (e) {
      if (/override key/i.test(apiErrorDetail(e, ''))) rememberedKey = null;
      toast.error(apiErrorDetail(e, 'The override did not go through'));
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    if (!order) return;
    const id = order.id;
    if (step === 'items') {
      rememberedKey = { key: key.trim(), until: Date.now() + KEY_MEMORY_MS };
      onEditItems(order, auth());
      onClose();
      return;
    }
    await run(async () => {
      if (step === 'complete') {
        const done = await overrideCompleteAdvance(id, { ...auth(), ...(unpaid ? { payment_method: method, card_type: cardType } : {}) });
        toast.success(`Order ${number} marked complete`);
        onUpdated(done, unpaid);
      } else if (step === 'time') {
        const changed = await overrideRescheduleAdvance(id, { ...auth(), scheduled_for: phLocalToIso(time), expected_revision: order.advance_schedule_revision });
        toast.success(`Order ${number} moved; the kitchen gets an updated ticket`);
        onUpdated(changed, false);
      } else if (step === 'customer') {
        const changed = await overrideAdvanceCustomer(id, {
          ...auth(), name: name.trim(), phone: phone.trim(),
          ...(isDelivery ? { address: address.trim(), barangay: barangay.trim(), landmark: landmark.trim() } : {}),
        });
        toast.success(`Customer details updated for ${number}`);
        onUpdated(changed, true);
      } else if (step === 'void') {
        const voided = await overrideVoidAdvance(id, auth());
        toast.success(`Order ${number} cancelled`);
        onUpdated(voided, false);
      } else if (step === 'erase') {
        await overrideEraseAdvance(id, auth());
        toast.success(`Order ${number} was permanently deleted`);
        onErased(id);
      }
    });
  }

  const action = ACTIONS.find((a) => a.step === step);
  const formValid = step === 'complete' ? !(unpaid && method === 'card' && !cardType)
    : step === 'time' ? !!time
      : step === 'customer' ? !!name.trim() && phone.replace(/\D/g, '').length >= 7 && (!isDelivery || !!address.trim())
        : true;

  return (
    <Dialog open={!!order} onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{step === 'menu' ? `CEO override · order ${number}` : `${action?.label} · ${number}`}</DialogTitle>
          <DialogDescription>
            {step === 'menu' ? 'These skip the normal cashier limits. Each one asks for your override key and a reason.' : action?.hint}
          </DialogDescription>
        </DialogHeader>

        {step === 'menu' ? (
          <div className="grid gap-2">
            {ACTIONS.filter((a) => !(order.status === 'voided' && a.step !== 'erase')).map((a) => (
              <button
                key={a.step}
                type="button"
                onClick={() => setStep(a.step)}
                className={`flex items-start gap-3 rounded-lg border p-3 text-left hover:bg-muted ${a.danger ? 'border-red-200' : ''}`}
              >
                <a.icon className={`mt-0.5 h-5 w-5 shrink-0 ${a.danger ? 'text-red-600' : 'text-primary'}`} aria-hidden />
                <span>
                  <span className={`block font-semibold ${a.danger ? 'text-red-700' : ''}`}>{a.label}</span>
                  <span className="block text-xs text-muted-foreground">{a.hint}</span>
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className="space-y-4">
            <Button variant="ghost" size="sm" className="-ml-2" onClick={() => setStep('menu')} disabled={busy}>
              <ChevronLeft className="mr-1 h-4 w-4" aria-hidden /> All override actions
            </Button>

            {step === 'complete' && (
              unpaid ? (
                <div className="space-y-2">
                  <p className="text-sm">
                    This order is <span className="font-semibold text-destructive">unpaid</span>. How was{' '}
                    {formatCurrency(order.total_amount + (order.delivery?.delivery_fee ?? 0))} paid?
                  </p>
                  <div className="grid grid-cols-3 gap-2">
                    {METHODS.map((m) => (
                      <Button key={m.value} type="button" variant={method === m.value ? 'default' : 'outline'} onClick={() => { setMethod(m.value); setCardType(null); }}>
                        {m.label}
                      </Button>
                    ))}
                  </div>
                  {method === 'card' && (
                    <div className="flex gap-2">
                      {(['debit', 'credit'] as const).map((t) => (
                        <Button key={t} type="button" className="flex-1" variant={cardType === t ? 'default' : 'outline'} onClick={() => setCardType(t)}>
                          {t === 'debit' ? 'Debit' : 'Credit'}
                        </Button>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">Already paid. It will be marked done{isDelivery ? ' and delivered' : ' and picked up'}.</p>
              )
            )}

            {step === 'time' && (
              <div className="space-y-1">
                <Label htmlFor="override-time">New date and time (Philippine time)</Label>
                <Input id="override-time" type="datetime-local" value={time} onChange={(e) => setTime(e.target.value)} />
                <p className="text-xs text-muted-foreground">The kitchen status stays as it is and the kitchen gets an updated ticket.</p>
              </div>
            )}

            {step === 'items' && (
              <p className="text-sm text-muted-foreground">
                After you confirm, the item editor opens.{' '}
                {order.kitchen_status === 'completed' ? 'This order is done and stays done — it is not sent back to the kitchen.' : 'The kitchen gets an updated ticket.'}
              </p>
            )}

            {step === 'customer' && (
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="override-name">Customer name</Label>
                  <Input id="override-name" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="override-phone">Phone</Label>
                  <Input id="override-phone" inputMode="tel" maxLength={40} value={phone} onChange={(e) => setPhone(e.target.value)} />
                </div>
                {isDelivery && (
                  <>
                    <div className="space-y-1 sm:col-span-2">
                      <Label htmlFor="override-address">Address</Label>
                      <Input id="override-address" maxLength={300} value={address} onChange={(e) => setAddress(e.target.value)} />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="override-barangay">Barangay</Label>
                      <Input id="override-barangay" maxLength={120} value={barangay} onChange={(e) => setBarangay(e.target.value)} />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="override-landmark">Landmark</Label>
                      <Input id="override-landmark" maxLength={300} value={landmark} onChange={(e) => setLandmark(e.target.value)} />
                    </div>
                  </>
                )}
              </div>
            )}

            {step === 'void' && (
              <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-950">
                {order.payment_status === 'paid' ? 'This order was paid — give the money back to the customer. ' : ''}
                The kitchen ticket is cancelled{order.order_source === 'online' ? ' and the customer’s tracker shows it as declined' : ''}.
              </p>
            )}

            {step === 'erase' && (
              <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-900">
                {formatCurrency(order.total_amount + (order.delivery?.delivery_fee ?? 0))} · {order.items.length} item{order.items.length === 1 ? '' : 's'}.
                It is erased from the board, history and every report{order.order_source === 'online' ? ', together with the website order' : ''}. This can’t be undone.
              </p>
            )}

            {hasKey === false ? (
              <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-950">
                You haven’t set an override key yet. <Link href="/settings" className="font-semibold underline">Set it in Settings</Link>, then come back.
              </p>
            ) : (
              <div className="space-y-3 border-t pt-3">
                <div className="space-y-1">
                  <Label htmlFor="override-reason">Reason</Label>
                  <Input id="override-reason" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. customer called, test order" />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="override-key">Your override key</Label>
                  <Input id="override-key" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} />
                </div>
              </div>
            )}
          </div>
        )}

        {step !== 'menu' && (
          <DialogFooter>
            <Button variant="outline" onClick={onClose} disabled={busy}>Close</Button>
            <Button variant={action?.danger ? 'destructive' : 'default'} disabled={!ready || !formValid} onClick={() => void submit()}>
              {busy ? 'Working…' : step === 'items' ? 'Continue to items' : action?.label}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
