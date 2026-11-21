import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { ChevronDown, ChevronRight, Loader2, Minus, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuth } from '@/contexts/AuthContext';
import {
  type PendingBundleDeduction,
  type PlatterMix,
  closePendingBundleDeductions,
  fetchPlatterMixes,
  savePlatterMix,
} from '@/lib/api';

const STEP = 8; // one roll

function mixSummary(mix: PlatterMix): string {
  const names = new Map(mix.allowed_rolls.map((r) => [r.id, r.name]));
  return mix.lines.map((l) => `${names.get(l.roll_product_id) ?? 'Roll'} ${l.pieces}`).join(' · ');
}

/** One platter: −/+ per roll, a live total, Save. */
function MixEditor({ mix, onSaved }: { mix: PlatterMix; onSaved: (m: PlatterMix) => void }) {
  const [pieces, setPieces] = useState<Record<string, number>>(
    () => Object.fromEntries(mix.lines.map((l) => [l.roll_product_id, l.pieces])),
  );
  const [busy, setBusy] = useState(false);
  const total = Object.values(pieces).reduce((s, n) => s + n, 0);
  const ok = total === mix.total_pieces;

  const bump = (id: string, d: number) =>
    setPieces((p) => ({ ...p, [id]: Math.max(0, (p[id] ?? 0) + d) }));

  async function save(clear = false) {
    setBusy(true);
    try {
      const lines = clear ? [] : Object.entries(pieces).filter(([, n]) => n > 0).map(([roll_product_id, n]) => ({ roll_product_id, pieces: n }));
      const saved = await savePlatterMix(mix.product_size_id, lines);
      toast.success(clear ? `${mix.platter_name}: kitchen logs rolls again` : `${mix.platter_name} standard mix saved`);
      if (clear) setPieces({});
      onSaved(saved);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save the mix');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 px-3 pb-3">
      <ul className="divide-y rounded-md border">
        {mix.allowed_rolls.map((r) => (
          <li key={r.id} className="flex items-center justify-between gap-2 px-3 py-1.5">
            <span className="text-sm">{r.name}</span>
            <span className="flex items-center gap-1">
              <Button size="icon" variant="outline" className="h-7 w-7" aria-label={`Less ${r.name}`}
                disabled={!pieces[r.id]} onClick={() => bump(r.id, -STEP)}>
                <Minus className="h-3.5 w-3.5" aria-hidden />
              </Button>
              <input
                aria-label={`${r.name} pieces`}
                inputMode="numeric"
                className="h-7 w-12 rounded-md border bg-background text-center text-sm tabular-nums"
                value={pieces[r.id] ?? 0}
                onChange={(e) => setPieces((p) => ({ ...p, [r.id]: Math.max(0, Math.floor(Number(e.target.value) || 0)) }))}
              />
              <Button size="icon" variant="outline" className="h-7 w-7" aria-label={`More ${r.name}`} onClick={() => bump(r.id, STEP)}>
                <Plus className="h-3.5 w-3.5" aria-hidden />
              </Button>
            </span>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className={`text-sm font-medium tabular-nums ${ok ? 'text-emerald-700' : 'text-destructive'}`}>
          {total} / {mix.total_pieces} pcs{!ok && (total < mix.total_pieces ? ` · ${mix.total_pieces - total} to go` : ` · ${total - mix.total_pieces} too many`)}
        </span>
        <span className="flex gap-2">
          {mix.lines.length > 0 && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => save(true)}>No standard mix</Button>
          )}
          <Button size="sm" disabled={busy || !ok} onClick={() => save()}>
            {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden />}Save mix
          </Button>
        </span>
      </div>
    </div>
  );
}

/** Menu Editing: what each platter takes from stock when it's sold. */
export function PlatterMixCard() {
  const { user } = useAuth();
  const canEdit = user?.role === 'manager' || user?.role === 'executive';
  const [mixes, setMixes] = useState<PlatterMix[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    if (!canEdit) return;
    fetchPlatterMixes().then(setMixes).catch(() => setMixes(null)); // before 0090: hide
  }, [canEdit]);

  if (!canEdit || !mixes?.length) return null;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Platter standard mix</CardTitle>
        <p className="text-sm text-muted-foreground">
          Taken from stock as soon as a platter is sold: each roll's recipe comes off automatically. If the kitchen used other
          flavors, they tap <span className="font-medium">Change</span> on the Kitchen Display.
        </p>
      </CardHeader>
      <CardContent className="p-0">
        <ul className="divide-y border-t">
          {mixes.map((m) => {
            const isOpen = open === m.product_size_id;
            return (
              <li key={m.product_size_id}>
                <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted/50"
                  aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : m.product_size_id)}>
                  {isOpen ? <ChevronDown className="h-4 w-4 shrink-0" aria-hidden /> : <ChevronRight className="h-4 w-4 shrink-0" aria-hidden />}
                  <span className="font-medium">{m.platter_name}</span>
                  <span className="text-xs text-muted-foreground">{m.total_pieces} pcs</span>
                  <span className={`ml-auto truncate text-xs ${m.lines.length ? 'text-muted-foreground' : 'text-amber-700'}`}>
                    {m.lines.length ? mixSummary(m) : 'No standard mix: the kitchen logs rolls'}
                  </span>
                </button>
                {isOpen && (
                  <MixEditor key={m.lines.map((l) => l.roll_product_id + l.pieces).join()} mix={m}
                    onSaved={(saved) => setMixes((prev) => prev?.map((x) => (x.product_size_id === saved.product_size_id ? saved : x)) ?? null)} />
                )}
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}

/** Menu Editing: platter orders still waiting on a roll recipe, one row per roll. */
export function PendingPlatterCard({
  pending,
  onChanged,
  onOpenRoll,
}: {
  pending: PendingBundleDeduction[];
  onChanged: () => void;
  onOpenRoll?: (rollName: string) => void;
}) {
  const { user } = useAuth();
  const canClose = user?.role === 'executive';
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const groups = useMemo(() => {
    const by = new Map<string, PendingBundleDeduction[]>();
    for (const p of pending) {
      const rolls = p.blocking_rolls?.length ? p.blocking_rolls : ['Fixed, retry by saving the roll recipe'];
      for (const r of rolls) by.set(r, [...(by.get(r) ?? []), p]);
    }
    return Array.from(by.entries()).sort((a, b) => b[1].length - a[1].length);
  }, [pending]);

  const close = useCallback(async (key: string, rows: PendingBundleDeduction[]) => {
    if (!window.confirm(`Close ${rows.length} platter order(s) without taking stock? Use this for old orders before a fresh stock count.`)) return;
    setBusy(key);
    try {
      const { closed } = await closePendingBundleDeductions(Array.from(new Set(rows.map((r) => r.transaction_item_id))));
      toast.success(`${closed} closed, no stock taken`);
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not close them');
    } finally {
      setBusy(null);
    }
  }, [onChanged]);

  if (!pending.length) return null;
  return (
    <Card className="border-amber-300 bg-amber-50">
      <CardContent className="space-y-2 pt-4">
        <p className="font-semibold text-amber-950">Platters that haven't taken stock yet ({pending.length})</p>
        <p className="text-sm text-amber-900">
          A roll's recipe has an ingredient in the wrong unit (e.g. grams for something counted in pcs). Fix the roll's recipe and
          these orders take their stock once.
        </p>
        <ul className="divide-y divide-amber-200 rounded-md border border-amber-200 bg-white/60">
          {groups.map(([roll, rows]) => {
            const orders = Array.from(new Set(rows.map((r) => r.order_number ?? r.transaction_id.slice(0, 8))));
            const isOpen = open === roll;
            return (
              <li key={roll} className="space-y-1 px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <button type="button" className="flex items-center gap-1 text-left text-sm text-amber-950" aria-expanded={isOpen}
                    onClick={() => setOpen(isOpen ? null : roll)}>
                    {isOpen ? <ChevronDown className="h-4 w-4" aria-hidden /> : <ChevronRight className="h-4 w-4" aria-hidden />}
                    <span className="font-semibold">{roll}</span>
                    <span>recipe needs a fix: {rows.length} platter order{rows.length === 1 ? '' : 's'} waiting</span>
                  </button>
                  <span className="ml-auto flex gap-2">
                    {onOpenRoll && rows[0].blocking_rolls?.length ? (
                      <Button size="sm" variant="outline" onClick={() => onOpenRoll(roll)}>Open recipe</Button>
                    ) : null}
                    {canClose && (
                      <Button size="sm" variant="ghost" disabled={busy === roll} onClick={() => close(roll, rows)}>
                        {busy === roll && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden />}Close without deducting
                      </Button>
                    )}
                  </span>
                </div>
                {isOpen && <p className="pl-5 text-xs text-amber-900">Orders {orders.join(', ')}</p>}
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
