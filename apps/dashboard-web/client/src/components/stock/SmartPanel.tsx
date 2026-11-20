import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ChefHat, Lightbulb, Loader2, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuth } from '@/contexts/AuthContext';
import {
  type Suggestion,
  type SuggestionsResponse,
  acceptSuggestion,
  dismissSuggestion,
  fetchSuggestions,
} from '@/lib/api';
import { fmtQty } from '@/lib/units';

/** Suggestions + prep list, loaded once (the server caches it for an hour). */
export function useSuggestions(enabled = true) {
  const [data, setData] = useState<SuggestionsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback(() => {
    if (!enabled) return;
    setLoading(true);
    fetchSuggestions()
      .then(setData)
      .catch(() => setData(null)) // before 0089, or no access: just don't show
      .finally(() => setLoading(false));
  }, [enabled]);
  useEffect(load, [load]);
  return { data, setData, loading, reload: load };
}

const KIND_LABELS: Record<Suggestion['kind'], string> = {
  yield: 'Batch size',
  usage: 'Running out faster',
  mode: 'Batch logging',
};

/** One suggestion with its Accept / Dismiss / Look buttons. */
export function SuggestionRow({
  s,
  onOpenItem,
  onDone,
}: {
  s: Suggestion;
  onOpenItem?: (ingredientId: string) => void;
  onDone: (next?: SuggestionsResponse) => void;
}) {
  const { user } = useAuth();
  const canAccept = user?.role === 'executive';
  const [busy, setBusy] = useState(false);

  async function accept() {
    setBusy(true);
    try {
      const next = await acceptSuggestion(s.key);
      toast.success('Done');
      onDone(next);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not apply it');
    } finally {
      setBusy(false);
    }
  }

  async function dismiss() {
    setBusy(true);
    try {
      await dismissSuggestion(s.key);
      onDone();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not dismiss it');
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="space-y-1.5 p-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <Badge variant="outline" className="mb-1 text-[10px] uppercase">{KIND_LABELS[s.kind]}</Badge>
          <p className="font-medium">{s.title}</p>
          <p className="text-sm text-muted-foreground">{s.detail}</p>
        </div>
        <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" aria-label="Dismiss" disabled={busy} onClick={dismiss}>
          <X className="h-4 w-4" aria-hidden />
        </Button>
      </div>
      <div className="flex flex-wrap gap-2">
        {s.action && canAccept && (
          <Button size="sm" disabled={busy} onClick={accept}>
            {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden />}
            {s.action.prep_yield != null ? `Set 1 batch = ${fmtQty(s.action.prep_yield)}` : 'Take from raw items on sale'}
          </Button>
        )}
        {onOpenItem && (
          <Button size="sm" variant="outline" onClick={() => onOpenItem(s.ingredient_id)}>
            {s.action ? 'Look first' : 'Open item'}
          </Button>
        )}
      </div>
    </li>
  );
}

/** Stock Overview: what the system noticed from counts, batches and sales. */
export function SuggestionsCard({ onOpenItem }: { onOpenItem?: (ingredientId: string) => void }) {
  const { data, setData, loading, reload } = useSuggestions();
  const list = data?.suggestions ?? [];
  if (loading || !data || !list.length) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Lightbulb className="h-4 w-4 text-amber-500" aria-hidden /> The system noticed ({list.length})
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <ul className="divide-y">
          {list.map((s) => (
            <SuggestionRow key={s.key} s={s} onOpenItem={onOpenItem} onDone={(next) => (next ? setData(next) : reload())} />
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

/** EOD Count: batches to make next, from the same weekday over 4 weeks. */
export function PrepListCard({ onOpenItem }: { onOpenItem?: (ingredientId: string) => void }) {
  const { data, loading } = useSuggestions();
  const [open, setOpen] = useState(false);
  const prep = data?.prep_list;
  if (loading || !prep || !prep.items.length) return null;
  const day = new Date(`${prep.for_date}T00:00:00`).toLocaleDateString('en-PH', { weekday: 'long', month: 'short', day: 'numeric' });
  return (
    <Card className="print:hidden">
      <CardHeader className="pb-2">
        <button type="button" className="flex w-full items-center justify-between text-left" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          <CardTitle className="flex items-center gap-2 text-base">
            <ChefHat className="h-4 w-4 text-primary" aria-hidden /> Prep for {day}:{' '}
            {prep.items.map((i) => `${i.batches}× ${i.name}`).join(', ')}
          </CardTitle>
          <span className="text-xs text-muted-foreground">{open ? 'Hide' : 'Details'}</span>
        </button>
      </CardHeader>
      {open && (
        <CardContent className="space-y-3 text-sm">
          <p className="text-xs text-muted-foreground">
            From what was used on the last 4 {new Date(`${prep.for_date}T00:00:00`).toLocaleDateString('en-PH', { weekday: 'long' })}s, minus what's in stock now.
          </p>
          <ul className="divide-y rounded-md border">
            {prep.items.map((i) => (
              <li key={i.ingredient_id} className="flex justify-between gap-2 px-3 py-1.5">
                <button type="button" className="text-left font-medium hover:underline" onClick={() => onOpenItem?.(i.ingredient_id)}>
                  {i.batches}× {i.name}
                </button>
                <span className="text-xs text-muted-foreground">
                  expect ~{fmtQty(i.expected_use)} {i.unit} · have {fmtQty(i.in_stock)} · makes {fmtQty(i.makes)}
                </span>
              </li>
            ))}
          </ul>
          {prep.pull.length > 0 && (
            <>
              <p className="font-medium">Raw items to pull</p>
              <ul className="divide-y rounded-md border">
                {prep.pull.map((p) => (
                  <li key={p.ingredient_id} className="flex justify-between gap-2 px-3 py-1.5">
                    <span>{p.name}</span>
                    <span className={`tabular-nums ${p.qty > p.in_stock ? 'font-semibold text-destructive' : ''}`}>
                      {fmtQty(p.qty)} {p.unit}
                      <span className="ml-1 text-xs font-normal text-muted-foreground">(have {fmtQty(p.in_stock)})</span>
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </CardContent>
      )}
    </Card>
  );
}
