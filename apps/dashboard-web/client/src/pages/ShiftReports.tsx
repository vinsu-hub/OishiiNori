import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { DashboardLayout } from '@/components/DashboardLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { fetchShiftReport, fetchShiftReports, fetchTodayBusinessDay, recordShiftMovement, type ShiftReport, type ShiftReportSummary } from '@/lib/api';
import { formatCurrency, formatTimestamp12h } from '@/lib/utils';
import { DailyOrderAudit } from '@/components/shared/DailyOrderAudit';

const peso = (amount: number) => formatCurrency(amount);

function AmountRow({ label, amount, strong = false }: { label: string; amount: number; strong?: boolean }) {
  return <div className={`flex justify-between gap-4 py-1.5 ${strong ? 'font-bold' : ''}`}><span>{label}</span><span className="tabular-nums">{peso(amount)}</span></div>;
}

export default function ShiftReports() {
  const [reports, setReports] = useState<ShiftReportSummary[]>([]);
  const [selected, setSelected] = useState('');
  const [report, setReport] = useState<ShiftReport | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [kind, setKind] = useState<'paid_in' | 'owner_transfer' | 'cash_refund'>('paid_in');
  const [purpose, setPurpose] = useState('');
  const [amount, setAmount] = useState('');
  const [transactionId, setTransactionId] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const [status, list] = await Promise.all([fetchTodayBusinessDay(), fetchShiftReports()]);
      setOpen(status.is_open);
      setReports(list);
      setSelected(current => current || list[0]?.id || '');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not load shift reports');
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!selected) { setReport(null); return; }
    fetchShiftReport(selected).then(setReport).catch(error => toast.error(error.message));
  }, [selected]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const value = Number(amount);
    if (!purpose.trim() || !Number.isFinite(value) || value <= 0 || (kind === 'cash_refund' && !transactionId.trim())) {
      toast.error('Enter a purpose, amount, and order ID for a cash refund');
      return;
    }
    setSaving(true);
    try {
      await recordShiftMovement({ kind, purpose: purpose.trim(), amount: value,
        transaction_id: kind === 'cash_refund' ? transactionId.trim() : undefined });
      toast.success('Cash movement recorded');
      setPurpose(''); setAmount(''); setTransactionId('');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not record cash movement');
    } finally { setSaving(false); }
  }

  const drawer = report?.cash_drawer;
  return <DashboardLayout title="Shift Reports">
    <style>{`@media print { body * { visibility: hidden !important; } .shift-report-print, .shift-report-print * { visibility: visible !important; } .shift-report-print { position: absolute; left: 0; top: 0; width: 100%; box-shadow: none !important; } }`}</style>
    <div className="mx-auto max-w-4xl space-y-5 p-4 sm:p-6">
      {open && <Card><CardHeader><CardTitle>Open shift · cash drawer entry</CardTitle></CardHeader><CardContent>
        <p className="mb-4 text-sm text-muted-foreground">Paid in adds cash to the drawer. Owner or bank transfer removes cash without recording a restaurant expense. Log operating purchases in Expenses.</p>
        <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1"><Label htmlFor="movement-kind">Entry type</Label><select id="movement-kind" className="w-full rounded-md border bg-background p-2" value={kind} onChange={event => setKind(event.target.value as typeof kind)}><option value="paid_in">Paid in</option><option value="owner_transfer">Owner / bank transfer</option><option value="cash_refund">Cash refund paid out</option></select></div>
          <div className="space-y-1"><Label htmlFor="movement-amount">Amount (₱)</Label><Input id="movement-amount" type="number" min="0.01" step="0.01" value={amount} onChange={event => setAmount(event.target.value)} /></div>
          <div className="space-y-1"><Label htmlFor="movement-purpose">Purpose</Label><Input id="movement-purpose" maxLength={240} value={purpose} onChange={event => setPurpose(event.target.value)} placeholder="e.g. change fund, bank deposit" /></div>
          {kind === 'cash_refund' && <div className="space-y-1"><Label htmlFor="movement-order">Voided order ID</Label><Input id="movement-order" value={transactionId} onChange={event => setTransactionId(event.target.value)} placeholder="Paste transaction ID" /></div>}
          <div className="sm:col-span-2"><Button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Record cash movement'}</Button></div>
        </form>
      </CardContent></Card>}

      <div className="flex flex-wrap items-end justify-between gap-3"><div className="space-y-1"><Label htmlFor="shift-select">Closed shift</Label><select id="shift-select" className="min-w-56 rounded-md border bg-background p-2" value={selected} onChange={event => setSelected(event.target.value)}><option value="">Select shift</option>{reports.map(item => <option key={item.id} value={item.id}>Shift #{item.shift_number} · {item.business_date}</option>)}</select></div>{report && <Button variant="outline" onClick={() => window.print()}>Print report</Button>}</div>
      {loading ? <p>Loading reports…</p> : !reports.length ? <p className="text-sm text-muted-foreground">No report-enabled shift has been closed yet. Reports begin with the next newly opened shift.</p> : null}
      {report && drawer && <Card className="shift-report-print"><CardContent className="space-y-6 pt-6">
        <header className="border-b pb-4"><h2 className="text-center text-xl font-bold">SHIFT REPORT</h2><div className="mt-5 grid gap-1 text-sm sm:grid-cols-2"><p>Shift number: {report.shift_number}</p><p>Store: {report.store_name}</p><p>POS: {report.register_name}</p><p>Business date: {report.business_date}</p><p>Opened by: {report.opened_by_name ?? 'Unknown'} · {formatTimestamp12h(report.opened_at)}</p><p>Closed by: {report.closed_by_name ?? 'Unknown'} · {formatTimestamp12h(report.closed_at)}</p></div></header>
        <section><h3 className="mb-2 font-bold text-green-700">Cash drawer</h3><AmountRow label="Starting cash" amount={drawer.starting_cash} /><AmountRow label="Cash payments" amount={drawer.cash_payments} /><AmountRow label="Cash refunds" amount={-drawer.cash_refunds} /><AmountRow label="Paid in" amount={drawer.paid_in} /><AmountRow label="Paid out · operating expenses" amount={-drawer.operating_expenses} /><AmountRow label="Paid out · owner / bank transfers" amount={-drawer.owner_transfers} />{drawer.rider_fees_cash != null && <AmountRow label="Delivery fees · kept by rider (cash)" amount={-drawer.rider_fees_cash} />}{drawer.rider_fees_deductible != null && <AmountRow label="Delivery fees · paid to rider (deductible)" amount={-drawer.rider_fees_deductible} />}<AmountRow label="Expected cash amount" amount={drawer.expected_cash} /><div className="mt-2 rounded-md border-2 border-green-700 bg-green-50 px-3 py-2 text-green-950"><AmountRow label="Actual counted cash" amount={drawer.actual_cash} strong /></div><AmountRow label="Difference" amount={drawer.difference} /></section>
        <section className="border-t pt-4"><h3 className="mb-2 font-bold text-green-700">Sales summary</h3><AmountRow label="Gross sales" amount={report.sales.gross} /><AmountRow label="Cash refunds" amount={-report.sales.cash_refunds} /><AmountRow label="Discounts" amount={-report.sales.discounts} /><AmountRow label="Net sales" amount={report.sales.net} />{Object.entries(report.payments).map(([method, value]) => <AmountRow key={method} label={method === 'Grab' ? 'Grab settlement' : method} amount={value} />)}<AmountRow label="Taxes (included for reference)" amount={report.sales.taxes} /><p className="mt-2 text-xs text-muted-foreground">{report.sales.order_count} paid orders collected during this shift. Grab settlement and other digital payments are excluded from drawer cash. Payment totals are before cash refund payouts.</p></section>
        <section className="border-t pt-4"><h3 className="mb-2 font-bold text-green-700">Pay in / Pay out</h3>{report.entries.length ? <div className="divide-y text-sm">{report.entries.map(entry => <div key={entry.id} className="grid grid-cols-[4.5rem_1fr_auto] gap-2 py-2"><span>{new Date(entry.time).toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Manila' })}</span><span>{entry.staff ?? 'Staff'} · {entry.purpose}<span className="block text-xs text-muted-foreground">{entry.kind.replace('_', ' ')}</span></span><span className="tabular-nums">{entry.amount < 0 ? '−' : '+'}{peso(Math.abs(entry.amount))}</span></div>)}</div> : <p className="text-sm text-muted-foreground">No drawer movements.</p>}</section>
        <DailyOrderAudit date={report.business_date} />
      </CardContent></Card>}
    </div>
  </DashboardLayout>;
}
