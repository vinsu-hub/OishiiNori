import { useCallback, useMemo, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { DashboardLayout } from '@/components/DashboardLayout';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiCashExpense, createCashExpense, fetchCashExpenses } from '@/lib/api';
import { formatCurrency, formatTimestamp12h } from '@/lib/utils';
import { useVisiblePolling } from '@/hooks/useVisiblePolling';

const POLL_INTERVAL_MS = 30_000;

export default function Expenses() {
  const [rows, setRows] = useState<ApiCashExpense[]>([]);
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const load = useCallback(() => fetchCashExpenses()
    .then(setRows)
    .catch((e) => toast.error(`Could not load expenses: ${e.message}`))
    .finally(() => setLoading(false)), []);
  useVisiblePolling(load, POLL_INTERVAL_MS);

  const total = useMemo(() => rows.reduce((sum, row) => sum + row.amount, 0), [rows]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const parsed = Number(amount);
    if (!description.trim() || !Number.isFinite(parsed) || parsed <= 0) {
      toast.error('Enter an expense description and amount greater than zero');
      return;
    }
    setSaving(true);
    try {
      const created = await createCashExpense({ description: description.trim(), amount: parsed });
      setRows((previous) => [created, ...previous]);
      setDescription('');
      setAmount('');
      toast.success('Register expense recorded');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not record expense');
    } finally {
      setSaving(false);
    }
  }

  return (
    <DashboardLayout title="Expenses">
      <div className="mx-auto max-w-4xl space-y-5 p-6">
        <p className="text-sm text-muted-foreground">Log money taken from the register for a business expense. Each entry is recorded under your account and the open shift’s business date.</p>
        <Card>
          <CardHeader><CardTitle>Record an expense</CardTitle></CardHeader>
          <CardContent>
            <form onSubmit={submit} className="grid gap-4 sm:grid-cols-[1fr_180px_auto] sm:items-end">
              <div className="space-y-2"><Label htmlFor="expense-description">Item / description</Label><Input id="expense-description" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={240} placeholder="e.g. cleaning supplies" /></div>
              <div className="space-y-2"><Label htmlFor="expense-amount">Amount (₱)</Label><Input id="expense-amount" type="number" min="0.01" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" /></div>
              <Button type="submit" disabled={saving} className="min-h-10">{saving ? 'Saving…' : 'Record expense'}</Button>
            </form>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0"><CardTitle>Today’s register expenses</CardTitle><span className="text-sm font-semibold">{formatCurrency(total)}</span></CardHeader>
          <CardContent>
            {loading ? <p className="text-sm text-muted-foreground">Loading…</p> : rows.length === 0 ? <p className="text-sm text-muted-foreground">No expenses recorded today.</p> : (
              <div className="divide-y">
                {rows.map((row) => <div key={row.id} className="flex items-center justify-between gap-4 py-3"><div><p className="font-medium">{row.description}</p><p className="text-xs text-muted-foreground">{formatTimestamp12h(row.created_at)} · Recorded by {row.recorded_by_name ?? 'Unknown staff'}</p></div><p className="font-semibold">−{formatCurrency(row.amount)}</p></div>)}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
