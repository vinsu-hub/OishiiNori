import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ArrowLeft, ChefHat, Loader2, Pencil } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAuth } from '@/contexts/AuthContext';
import {
  type ApiItemUnit,
  type ChainNode,
  type ItemOverview,
  type RecipeCoverageIngredient,
  fetchItemOverview,
  fetchItemUnits,
  fetchRecipeCoverage,
} from '@/lib/api';
import { describeSize, fmtQty } from '@/lib/units';
import { STOCK_STATION_LABELS } from '@/lib/constants';
import { DeductModeSwitch } from './DeductModeSwitch';
import { EditItemDialog, type EditableItem } from './EditItemDialog';
import { PrepBasesPanel } from './PrepBasesPanel';
import { fmtUnitCost } from './UnitCostEntry';
import { SuggestionRow, useSuggestions } from './SmartPanel';

const MOVE_LABELS: Record<string, string> = {
  sale_consumption: 'Sold',
  sale_consumption_reversal: 'Sale voided',
  trans_in: 'Added',
  trans_out: 'Taken out',
  delivery: 'Delivery',
  transfer_in: 'Transfer in',
  transfer_out: 'Transfer out',
  count_adjustment: 'Count',
};
const FIELD_LABELS: Record<string, string> = {
  name: 'Name',
  unit: 'Unit',
  category: 'Category',
  station: 'Station',
  sheet_section: 'Section',
  reorder_threshold: 'Low at',
  'batch recipe': 'Batch recipe',
  'deduct mode': 'How it comes off stock',
  'batch yield': 'One batch makes',
};

function when(iso: string) {
  return new Date(iso).toLocaleString('en-PH', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function showValue(v: unknown): string {
  if (v == null) return '—';
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('takes' in o) {
      const takes = Object.entries((o.takes as Record<string, number>) ?? {}).map(([n, q]) => `${fmtQty(q)} ${n}`).join(' + ');
      return `${o.yield != null ? `${fmtQty(o.yield as number)} from ` : ''}${takes}`;
    }
    if ('unit' in o) return `${o.unit} (×${fmtQty(o.factor as number)})`;
    return JSON.stringify(v);
  }
  if (v === 'batch') return 'Made in batches';
  if (v === 'auto') return 'Take from raw items';
  return String(v);
}

/** The chain, as an indented list: tap a step to open it. */
function Chain({ nodes, unitOf, onOpen, direction }: {
  nodes: ChainNode[];
  unitOf: string;
  onOpen: (id: string) => void;
  direction: 'from' | 'into';
}) {
  return (
    <ul className="space-y-1">
      {nodes.map((n) => (
        <li key={`${n.ingredient_id}-${n.qty}`}>
          <button
            type="button"
            onClick={() => onOpen(n.ingredient_id)}
            className="flex w-full items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 text-left text-sm hover:bg-muted"
          >
            <span className="flex items-center gap-1.5">
              {n.prep_yield != null && <ChefHat className="h-3.5 w-3.5 text-primary" aria-hidden />}
              <span className="font-medium">{n.name}</span>
              <span className="text-xs text-muted-foreground">
                {direction === 'from' ? `${fmtQty(n.qty)} ${n.base_unit} a batch` : `takes ${fmtQty(n.qty)} ${unitOf} a batch`}
              </span>
              {n.deduct_mode === 'auto' && <Badge variant="outline" className="text-[10px]">auto</Badge>}
            </span>
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{fmtQty(n.current_stock)} {n.base_unit} in stock</span>
          </button>
          {n.children.length > 0 && (
            <div className="ml-4 mt-1 border-l pl-2">
              <Chain nodes={n.children} unitOf={n.base_unit} onOpen={onOpen} direction={direction} />
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

/** Item page: everything about one ingredient in one place. Opened by
 * tapping an item's name (EOD Count, Unit costs, Prep bases). */
export function ItemSheet({
  ingredientId,
  onOpenChange,
  onChanged,
  initialTab = 'overview',
}: {
  ingredientId: string | null;
  onOpenChange: (open: boolean) => void;
  /** Something was edited: the page behind reloads. */
  onChanged?: () => void;
  initialTab?: 'overview' | 'edit' | 'history';
}) {
  const { user } = useAuth();
  const role = user?.role ?? '';
  const canEdit = ['executive', 'manager'].includes(role);
  const isExecutive = role === 'executive';
  // Tapping a step of the chain opens it here; Back returns.
  const [trail, setTrail] = useState<string[]>([]);
  const currentId = trail[trail.length - 1] ?? null;
  const [item, setItem] = useState<ItemOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState(initialTab);
  const [editing, setEditing] = useState<EditableItem | null>(null);
  const [coverage, setCoverage] = useState<RecipeCoverageIngredient[] | null>(null);
  const [itemUnits, setItemUnits] = useState<ApiItemUnit[]>([]);
  const smart = useSuggestions(!!ingredientId && ['executive', 'manager'].includes(role));
  const mine = (smart.data?.suggestions ?? []).filter((s) => s.ingredient_id === currentId);

  useEffect(() => {
    setTrail(ingredientId ? [ingredientId] : []);
    setTab(initialTab);
  }, [ingredientId, initialTab]);

  const load = useCallback(() => {
    if (!currentId) return;
    setLoading(true);
    fetchItemOverview(currentId)
      .then(setItem)
      .catch((e) => toast.error(e instanceof Error ? e.message : 'Could not load the item'))
      .finally(() => setLoading(false));
  }, [currentId]);
  useEffect(load, [load]);

  // The batch recipe editor needs every ingredient: only fetched for Edit.
  useEffect(() => {
    if (tab !== 'edit' || !currentId || coverage) return;
    Promise.all([fetchRecipeCoverage(), fetchItemUnits()])
      .then(([c, u]) => {
        setCoverage(c.ingredients);
        setItemUnits(u);
      })
      .catch(() => setCoverage([]));
  }, [tab, currentId, coverage]);

  function changed() {
    load();
    onChanged?.();
  }

  const open = (id: string) => setTrail((t) => [...t, id]);
  const maxUse = item ? Math.max(...item.usage.map((u) => u.used), 0) : 0;
  const isBase = !!item?.prep_yield && item.made_from.length > 0;

  return (
    <Sheet open={!!ingredientId} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        {loading && !item ? (
          <div className="flex h-40 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin" aria-hidden /></div>
        ) : item ? (
          <>
            <SheetHeader>
              {trail.length > 1 && (
                <Button variant="ghost" size="sm" className="w-fit px-2" onClick={() => setTrail((t) => t.slice(0, -1))}>
                  <ArrowLeft className="mr-1 h-4 w-4" aria-hidden /> Back
                </Button>
              )}
              <SheetTitle className="flex items-center gap-2">
                {isBase && <ChefHat className="h-5 w-5 text-primary" aria-hidden />} {item.name}
              </SheetTitle>
              <SheetDescription>
                {[item.station ? STOCK_STATION_LABELS[item.station as keyof typeof STOCK_STATION_LABELS] ?? item.station : 'No station',
                  item.sheet_section, `counted in ${item.base_unit}`].filter(Boolean).join(' · ')}
              </SheetDescription>
            </SheetHeader>

            <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)} className="mt-4 px-4 pb-6">
              <TabsList className="w-full">
                <TabsTrigger value="overview">Overview</TabsTrigger>
                {canEdit && <TabsTrigger value="edit">Edit</TabsTrigger>}
                <TabsTrigger value="history">History</TabsTrigger>
              </TabsList>

              <TabsContent value="overview" className="space-y-5 pt-3">
                {mine.length > 0 && (
                  <ul className="divide-y rounded-md border border-amber-300 bg-amber-50/60">
                    {mine.map((s) => (
                      <SuggestionRow
                        key={s.key}
                        s={s}
                        onDone={(next) => {
                          if (next) smart.setData(next);
                          else smart.reload();
                          changed();
                        }}
                      />
                    ))}
                  </ul>
                )}
                <div className="grid grid-cols-3 gap-2 text-center">
                  <div className="rounded-md border p-2">
                    <p className="text-lg font-semibold tabular-nums">{fmtQty(item.current_stock)}</p>
                    <p className="text-xs text-muted-foreground">{item.base_unit} in stock</p>
                  </div>
                  <div className="rounded-md border p-2">
                    <p className="text-lg font-semibold tabular-nums">{item.days_left != null ? `~${fmtQty(item.days_left)}` : '—'}</p>
                    <p className="text-xs text-muted-foreground">days left at this pace</p>
                  </div>
                  <div className="rounded-md border p-2">
                    {isBase ? (
                      <>
                        <p className="text-lg font-semibold tabular-nums">{item.batches_possible != null ? fmtQty(Math.floor(item.batches_possible)) : '—'}</p>
                        <p className="text-xs text-muted-foreground">batches the stock can make</p>
                      </>
                    ) : (
                      <>
                        <p className="text-lg font-semibold tabular-nums">{item.avg_daily_use != null ? fmtQty(item.avg_daily_use) : '—'}</p>
                        <p className="text-xs text-muted-foreground">{item.base_unit} used a day</p>
                      </>
                    )}
                  </div>
                </div>

                <div>
                  <p className="mb-1 text-xs font-medium text-muted-foreground">Used, last 14 days</p>
                  <div className="flex h-16 items-end gap-0.5" role="img" aria-label="Daily use over the last 14 days">
                    {item.usage.map((u) => (
                      <div
                        key={u.date}
                        title={`${u.date}: ${fmtQty(u.used)} ${item.base_unit}`}
                        className="flex-1 rounded-t bg-primary/70"
                        style={{ height: maxUse > 0 ? `${Math.max(2, (u.used / maxUse) * 100)}%` : '2%' }}
                      />
                    ))}
                  </div>
                </div>

                {isBase && (
                  <section className="space-y-2">
                    <h3 className="text-sm font-semibold">
                      Made from <span className="font-normal text-muted-foreground">· 1 batch = {fmtQty(item.prep_yield!)} {item.base_unit}</span>
                    </h3>
                    <Chain nodes={item.made_from} unitOf={item.base_unit} onOpen={open} direction="from" />
                    <p className="text-xs text-muted-foreground">
                      {item.deduct_mode === 'auto'
                        ? 'Sales take these straight away (no batches to log).'
                        : 'Staff press Made a batch, or EOD Count spots it.'}
                    </p>
                  </section>
                )}
                {item.goes_into.length > 0 && (
                  <section className="space-y-2">
                    <h3 className="text-sm font-semibold">Goes into</h3>
                    <Chain nodes={item.goes_into} unitOf={item.base_unit} onOpen={open} direction="into" />
                  </section>
                )}

                <section className="space-y-1">
                  <h3 className="text-sm font-semibold">Menu recipes ({item.recipes.length})</h3>
                  {item.recipes.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No menu recipe takes this directly.</p>
                  ) : (
                    <ul className="max-h-48 divide-y overflow-y-auto rounded-md border text-sm">
                      {item.recipes.map((r) => (
                        <li key={`${r.product_name}-${r.size_label}`} className="flex justify-between px-2.5 py-1">
                          <span>{r.product_name} <span className="text-muted-foreground">{r.size_label}</span></span>
                          <span className="tabular-nums">{fmtQty(r.qty_per_serving)} {r.unit ?? item.base_unit}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>

                {item.sizes.length > 0 && (
                  <p className="text-xs text-muted-foreground">
                    Sizes: {item.sizes.map((s) => describeSize(s.name, s.base_qty, item.base_unit)).join(' · ')}
                  </p>
                )}
                {isExecutive && item.unit_cost != null && (
                  <p className="text-xs text-muted-foreground">Cost: {fmtUnitCost(item.unit_cost)} per {item.base_unit}</p>
                )}
              </TabsContent>

              {canEdit && (
                <TabsContent value="edit" className="space-y-5 pt-3">
                  <section className="space-y-2">
                    <h3 className="text-sm font-semibold">Name, unit and sizes</h3>
                    <Button
                      variant="outline"
                      onClick={() => setEditing({ kind: 'ingredient', id: item.id, name: item.name, unit: item.base_unit })}
                    >
                      <Pencil className="mr-1.5 h-4 w-4" aria-hidden /> Edit {item.name}
                    </Button>
                  </section>
                  {isBase && (
                    <section className="space-y-2">
                      <h3 className="text-sm font-semibold">How it comes off stock</h3>
                      <DeductModeSwitch
                        base={{ ingredient_id: item.id, name: item.name, deduct_mode: item.deduct_mode, components: item.made_from }}
                        canEdit={isExecutive}
                        onChanged={changed}
                      />
                    </section>
                  )}
                  <section className="space-y-2">
                    <h3 className="text-sm font-semibold">Batch recipe</h3>
                    {coverage == null ? (
                      <p className="text-xs text-muted-foreground">Loading…</p>
                    ) : (
                      <PrepBasesPanel
                        ingredients={coverage}
                        itemUnits={itemUnits}
                        canEdit={isExecutive}
                        canMake={['executive', 'manager', 'stocker'].includes(role)}
                        impactFor={() => ({ count: 0 })}
                        onUnitAdded={(u) => setItemUnits((prev) => [...prev, u])}
                        onChanged={changed}
                        onlyBaseId={item.id}
                      />
                    )}
                  </section>
                </TabsContent>
              )}

              <TabsContent value="history" className="space-y-5 pt-3">
                {item.edits.length > 0 && (
                  <section className="space-y-1">
                    <h3 className="text-sm font-semibold">Changes</h3>
                    <ul className="divide-y rounded-md border text-sm">
                      {item.edits.map((e, i) => (
                        <li key={i} className="px-2.5 py-1.5">
                          <p><b>{FIELD_LABELS[e.field] ?? e.field}</b>: {showValue(e.before)} → {showValue(e.after)}</p>
                          <p className="text-xs text-muted-foreground">{when(e.created_at)}{e.by ? ` · ${e.by}` : ''}</p>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
                {item.batches.length > 0 && (
                  <section className="space-y-1">
                    <h3 className="text-sm font-semibold">Batches made</h3>
                    <ul className="divide-y rounded-md border text-sm">
                      {item.batches.map((b, i) => (
                        <li key={i} className="flex justify-between gap-2 px-2.5 py-1.5">
                          <span>
                            {fmtQty(b.batches)} batch{b.batches === 1 ? '' : 'es'} → {fmtQty(b.yield_qty)} {item.base_unit}
                            {b.source === 'eod' && <Badge variant="outline" className="ml-1.5 text-[10px]">spotted at EOD</Badge>}
                          </span>
                          <span className="text-xs text-muted-foreground">{when(b.created_at)}{b.by ? ` · ${b.by}` : ''}</span>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
                <section className="space-y-1">
                  <h3 className="text-sm font-semibold">Stock movements (last 14 days)</h3>
                  {item.movements.length === 0 ? (
                    <p className="text-xs text-muted-foreground">Nothing in the last 14 days.</p>
                  ) : (
                    <ul className="divide-y rounded-md border text-sm">
                      {item.movements.map((m, i) => {
                        const out = ['sale_consumption', 'trans_out', 'transfer_out'].includes(m.type);
                        const signed = m.type === 'count_adjustment' ? m.signed_qty : out ? -m.quantity : m.quantity;
                        return (
                          <li key={i} className="flex justify-between gap-2 px-2.5 py-1.5">
                            <span className="min-w-0">
                              {MOVE_LABELS[m.type] ?? m.type}
                              {m.reason && <span className="block truncate text-xs text-muted-foreground" title={m.reason}>{m.reason}</span>}
                            </span>
                            <span className="shrink-0 text-right">
                              <span className={`tabular-nums ${signed != null && signed < 0 ? 'text-destructive' : ''}`}>
                                {signed != null ? `${signed > 0 ? '+' : ''}${fmtQty(signed)}` : fmtQty(m.quantity)} {item.base_unit}
                              </span>
                              <span className="block text-xs text-muted-foreground">{when(m.created_at)}</span>
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </section>
              </TabsContent>
            </Tabs>
          </>
        ) : null}
        <EditItemDialog
          item={editing}
          sizes={item ? item.sizes.map((s) => ({ ...s, ingredient_id: item.id, stock_item_id: null, created_at: '' })) : []}
          onOpenChange={(o) => !o && setEditing(null)}
          onSaved={changed}
        />
      </SheetContent>
    </Sheet>
  );
}
