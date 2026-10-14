import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { DashboardLayout } from '@/components/DashboardLayout';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useVisiblePolling } from '@/hooks/useVisiblePolling';
import { collectSushiBoatDeposit, fetchSushiBoatDeposits, handoffSushiBoatDeposit, returnSushiBoatDeposit, type SushiBoatDeposit } from '@/lib/api';
import { formatCurrency } from '@/lib/utils';

const dateTime = new Intl.DateTimeFormat('en-PH', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Manila' });

export default function SushiBoatDeposits() {
  const [rows, setRows] = useState<SushiBoatDeposit[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [selected, setSelected] = useState<SushiBoatDeposit | null>(null);
  const [deduction, setDeduction] = useState('0');
  const [method, setMethod] = useState('Cash');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');

  const load = useCallback(() => {
    fetchSushiBoatDeposits().then(setRows).catch((e) => toast.error(e instanceof Error ? e.message : 'Could not load boat deposits')).finally(() => setLoading(false));
  }, []);
  useVisiblePolling(load, 30_000);

  async function mutate(id: string, action: 'collect' | 'handoff') {
    setBusy(id);
    try {
      const changed = action === 'collect' ? await collectSushiBoatDeposit(id) : await handoffSushiBoatDeposit(id);
      setRows((current) => current.map((row) => row.id === id ? { ...row, ...changed } : row));
      toast.success(action === 'collect' ? 'Deposit collection recorded' : 'Boat handoff recorded. The 24-hour return window has started.');
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Could not update deposit'); load(); }
    finally { setBusy(null); }
  }

  async function saveReturn() {
    if (!selected) return;
    const amount = Number(deduction);
    if (!Number.isFinite(amount) || amount < 0 || amount > selected.amount) { toast.error('Enter a deduction between ₱0 and the deposit amount'); return; }
    setBusy(selected.id);
    try {
      const changed = await returnSushiBoatDeposit(selected.id, { deduction_amount: amount, refund_method: method, refund_reference: reference.trim() || undefined, notes: notes.trim() || undefined });
      setRows((current) => current.map((row) => row.id === selected.id ? { ...row, ...changed } : row));
      setSelected(null);
      toast.success('Return and external refund record saved');
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Could not record boat return'); }
    finally { setBusy(null); }
  }

  const open = rows.filter((row) => !row.returned_at && row.order?.status !== 'rejected');
  const returned = rows.filter((row) => row.returned_at);

  return <DashboardLayout title="Sushi Boat Deposits">
    <div className="space-y-5 p-6">
      <header className="space-y-1">
        <h1 className="font-corp-display text-2xl font-semibold">Sushi Boat Deposits</h1>
        <p className="text-sm text-muted-foreground">Track pickup and delivery boat deposits, handoffs, returns, deductions, and refunds.</p>
      </header>

      <section className="rounded-lg border border-primary/20 bg-primary/5 p-4" aria-labelledby="boat-policy-title">
        <h2 id="boat-policy-title" className="font-semibold">Customer return policy</h2>
        <ul className="mt-2 grid gap-x-8 gap-y-1 text-sm text-muted-foreground md:grid-cols-2">
          <li>Small and medium boat deposit: ₱1,000 each.</li>
          <li>Large boat deposit: ₱2,500 each.</li>
          <li>Return within 24 hours after handoff for a refund.</li>
          <li>Late returns: ₱150 for each succeeding day.</li>
          <li>Damage or missing parts may be deducted after inspection.</li>
          <li>Customer arranges transport unless Oishii Nori delivery help is available.</li>
          <li>Return the boat clean and in good condition.</li>
        </ul>
        <p className="mt-3 text-xs text-muted-foreground">This page records refunds processed separately. It does not send a payout or change sales totals.</p>
      </section>

      {loading && <p className="text-sm text-muted-foreground">Loading deposits…</p>}
      {!loading && rows.length === 0 && <p className="rounded-md border p-5 text-sm text-muted-foreground">No online sushi boat deposits yet.</p>}

      {open.length > 0 && <section className="space-y-3"><h2 className="font-corp-display text-lg font-semibold">Open deposits <Badge variant="secondary">{open.length}</Badge></h2>
        <div className="grid gap-3 xl:grid-cols-2">{open.map((row) => {
          const name = row.delivery?.customer_name || 'Pickup order';
          const due = row.return_due_at ? new Date(row.return_due_at) : null;
          const overdue = due && due.getTime() < Date.now();
          return <Card key={row.id}><CardContent className="space-y-3 py-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div><p className="font-semibold">Order #{row.order?.order_number} · {row.product_name} ({row.size_label})</p><p className="text-sm text-muted-foreground">{name} · {row.order?.order_channel === 'delivery' ? 'Delivery' : 'Pickup'} · {row.delivery?.customer_phone || ''}</p></div>
              <div className="text-right"><p className="font-semibold tabular-nums">{formatCurrency(row.amount)}</p><Badge variant={row.return_due_at ? overdue ? 'destructive' : 'secondary' : row.collected_at ? 'outline' : 'gold'}>{row.returned_at ? 'Returned' : row.return_due_at ? overdue ? 'Past due' : 'With customer' : row.collected_at ? 'Collected' : 'Awaiting collection'}</Badge></div>
            </div>
            <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
              <div><dt className="text-muted-foreground">Scheduled</dt><dd>{row.order?.scheduled_for ? dateTime.format(new Date(row.order.scheduled_for)) : 'As soon as possible'}</dd></div>
              <div><dt className="text-muted-foreground">Payment option</dt><dd>{row.order?.payment_method || 'Not recorded'}</dd></div>
              {row.collected_at && <div><dt className="text-muted-foreground">Deposit collected</dt><dd>{dateTime.format(new Date(row.collected_at))}{row.collected_by_name ? ` · ${row.collected_by_name}` : ''}</dd></div>}
              {row.handoff_at && <div><dt className="text-muted-foreground">Handoff / return due</dt><dd>{dateTime.format(new Date(row.handoff_at))}{row.handed_by_name ? ` · ${row.handed_by_name}` : ''}<br />{due ? dateTime.format(due) : '24 hours after handoff'}</dd></div>}
              {row.delivery?.address && <div className="sm:col-span-2"><dt className="text-muted-foreground">Delivery address</dt><dd>{row.delivery.address}{row.delivery.barangay ? `, ${row.delivery.barangay}` : ''}</dd></div>}
            </dl>
            <div className="flex flex-wrap gap-2">
              {!row.collected_at && <Button size="sm" disabled={busy === row.id} onClick={() => void mutate(row.id, 'collect')}>Record deposit collected</Button>}
              {row.collected_at && !row.handoff_at && <Button size="sm" disabled={busy === row.id} onClick={() => void mutate(row.id, 'handoff')}>Record handoff</Button>}
              {row.handoff_at && !row.returned_at && <Button size="sm" variant="outline" onClick={() => { setSelected(row); setDeduction('0'); setMethod('Cash'); setReference(''); setNotes(''); }}>Inspect return and record refund</Button>}
            </div>
          </CardContent></Card>;
        })}</div>
      </section>}

      {returned.length > 0 && <section className="space-y-3"><h2 className="font-corp-display text-lg font-semibold">Returned deposits <Badge variant="outline">{returned.length}</Badge></h2>
        <div className="overflow-x-auto rounded-md border"><table className="w-full min-w-[700px] text-left text-sm"><thead className="bg-muted/50"><tr><th className="p-3">Order / Boat</th><th className="p-3">Returned</th><th className="p-3">Deposit</th><th className="p-3">Deduction</th><th className="p-3">Refund recorded</th><th className="p-3">Method / reference</th><th className="p-3">Staff / notes</th></tr></thead><tbody>{returned.map((row) => <tr key={row.id} className="border-t"><td className="p-3">#{row.order?.order_number} · {row.product_name} ({row.size_label})</td><td className="p-3">{dateTime.format(new Date(row.returned_at!))}</td><td className="p-3">{formatCurrency(row.amount)}</td><td className="p-3">{formatCurrency(row.deduction_amount)}</td><td className="p-3">{formatCurrency(row.refund_amount)}</td><td className="p-3">{row.refund_method || '—'}{row.refund_reference && <><br />{row.refund_reference}</>}</td><td className="p-3">{row.returned_by_name || '—'}{row.notes && <><br />{row.notes}</>}</td></tr>)}</tbody></table></div>
      </section>}
    </div>

    {selected && <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && setSelected(null)}>
      <section className="w-full max-w-lg space-y-4 rounded-lg bg-background p-5 shadow-xl" role="dialog" aria-modal="true" aria-labelledby="return-dialog-title">
        <div><h2 id="return-dialog-title" className="text-lg font-semibold">Inspect boat return · Order #{selected.order?.order_number}</h2><p className="text-sm text-muted-foreground">Deposit {formatCurrency(selected.amount)}. Record the refund after it has been paid outside this system.</p></div>
        <div className="space-y-2"><Label htmlFor="boat-deduction">Late, damage, or missing-part deduction</Label><Input id="boat-deduction" type="number" min="0" max={selected.amount} step="0.01" value={deduction} onChange={(e) => setDeduction(e.target.value)} /><p className="text-xs text-muted-foreground">Late policy: ₱150 for each succeeding day after the first 24 hours. Confirm deductions after inspection.</p></div>
        <div className="space-y-2"><Label htmlFor="boat-refund-method">Refund method</Label><select id="boat-refund-method" className="h-10 w-full rounded-md border bg-background px-3" value={method} onChange={(e) => setMethod(e.target.value)}><option>Cash</option><option>GCash</option><option>Bank transfer</option><option>Other</option></select></div>
        <div className="space-y-2"><Label htmlFor="boat-refund-reference">Refund reference (optional)</Label><Input id="boat-refund-reference" value={reference} onChange={(e) => setReference(e.target.value)} /></div>
        <div className="space-y-2"><Label htmlFor="boat-return-notes">Inspection notes (optional)</Label><Input id="boat-return-notes" value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
        <div className="flex justify-between border-t pt-3 font-semibold"><span>Refund to record</span><span>{formatCurrency(Math.max(0, selected.amount - (Number(deduction) || 0)))}</span></div>
        <div className="flex justify-end gap-2"><Button variant="outline" onClick={() => setSelected(null)} disabled={busy === selected.id}>Cancel</Button><Button onClick={() => void saveReturn()} disabled={busy === selected.id}>{busy === selected.id ? 'Saving…' : 'Record return and refund'}</Button></div>
      </section>
    </div>}
  </DashboardLayout>;
}
