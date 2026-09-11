import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import { toast } from 'sonner';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  ApiProduct,
  ApiProductSize,
  ApiReservation,
  ApiTable,
  ApiTransaction,
  TableShape,
  closeTransaction,
  describeError,
  fetchProducts,
  fetchReservations,
  fetchTables,
  fetchTransactions,
  seatReservation,
  switchTable,
  updateTable,
  voidTransaction,
} from '@/lib/api';
import { formatCurrency } from '@/lib/utils';
import { POLL_INTERVAL_MS, todayIsoPH } from '@/lib/constants';
import { useVisiblePolling } from '@/hooks/useVisiblePolling';

const RESERVATION_PREP_BUFFER_MIN = 15; // must match reservations.py

const CANVAS_W = 1000;

// Zoom control (bottom-left of the canvas). Persisted per browser session so
// switching Reservations tabs doesn't reset it.
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 1.5;
const ZOOM_STEP = 0.1;
const ZOOM_KEY = 'floorplan-zoom';

function readZoom(): number {
  try {
    const v = Number(sessionStorage.getItem(ZOOM_KEY));
    if (v >= ZOOM_MIN && v <= ZOOM_MAX) return v;
  } catch {
    /* private mode / storage disabled */
  }
  return 1;
}

// Display-only minimum footprint so the label + seat count + order info fit.
// Never written back to the DB -- the stored width/height is respected above
// these floors.
function renderSize(t: ApiTable): { w: number; h: number } {
  if (t.shape === 'round') {
    const d = Math.max(104, t.width, t.height);
    return { w: d, h: d };
  }
  const w = Math.max(t.shape === 'rectangle' ? 148 : 104, t.width);
  const h = Math.max(92, t.height);
  return { w, h };
}

function seatLabel(t: ApiTable): string {
  const lo = t.capacity_min ?? t.capacity;
  const hi = t.capacity_max ?? t.capacity;
  return lo !== hi ? `${lo}–${hi} seats` : `${hi} seat${hi === 1 ? '' : 's'}`;
}

function elapsedSeconds(since: string, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - new Date(since).getTime()) / 1000));
}
function elapsedLabel(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

// Philippines wall-clock "now", matching lib/constants todayIsoPH(): the
// reservations table stores plain local date/time.
function phNow(): { iso: string; minutes: number } {
  const d = new Date(Date.now() + 8 * 60 * 60 * 1000);
  return { iso: d.toISOString().slice(0, 10), minutes: d.getUTCHours() * 60 + d.getUTCMinutes() };
}
function hhmmToMinutes(t: string): number {
  const [h, m] = t.split(':');
  return Number(h) * 60 + Number(m);
}
function hhmm(t: string): string {
  return t.slice(0, 5);
}

// Where a reservation sits in its lifecycle, for the seating panel + detail
// list. Derived (nothing but `seated`/`completed` is persisted) -- see plan.
type ReservationPhase = 'completed' | 'seated' | 'overdue' | 'due' | 'no_show' | 'upcoming';

function reservationPhase(
  r: ApiReservation,
  isToday: boolean,
  nowMinutes: number,
  txnById: Map<string, ApiTransaction>
): ReservationPhase {
  const linked = r.transaction_id ? txnById.get(r.transaction_id) ?? null : null;
  if (linked && linked.status === 'closed') return 'completed';
  if (r.seated_at || (linked && linked.status === 'open')) return 'seated';
  if (!isToday) return 'upcoming';
  const start = hhmmToMinutes(r.start_time);
  const end = hhmmToMinutes(r.end_time);
  if (nowMinutes >= end) return 'no_show';
  if (nowMinutes >= start + RESERVATION_PREP_BUFFER_MIN) return 'overdue';
  if (nowMinutes >= start - RESERVATION_PREP_BUFFER_MIN) return 'due';
  return 'upcoming';
}

const PHASE_META: Record<ReservationPhase, { label: string; className: string }> = {
  completed: { label: 'Done', className: 'bg-muted text-muted-foreground' },
  seated: { label: 'Seated', className: 'bg-green-100 text-green-800 border border-green-300' },
  overdue: { label: 'Overdue', className: 'bg-red-100 text-red-800 border border-red-400' },
  due: { label: 'Due now', className: 'bg-orange-100 text-orange-900 border border-orange-300' },
  no_show: { label: 'No-show', className: 'bg-red-50 text-red-700 border border-red-200' },
  upcoming: { label: 'Upcoming', className: 'bg-card text-muted-foreground border border-border' },
};

// Phases that still need a table found for them.
const NEEDS_SEATING: ReservationPhase[] = ['overdue', 'due', 'upcoming'];

type TableState = 'white' | 'orange' | 'red';

interface Derived {
  state: TableState;
  openTxn: ApiTransaction | null;
  reservation: ApiReservation | null;
  breach: boolean;
}

const STATE_CLASS: Record<TableState, string> = {
  white: 'bg-card border-border text-foreground',
  orange: 'bg-orange-100 border-orange-400 text-orange-900',
  red: 'bg-red-100 border-red-500 text-red-900',
};

// Chair-nub decorations along the top/bottom edge (or around a round table).
// Purely visual -- the count is a cue, not a literal seat diagram.
function ChairNubs({ shape }: { shape: TableShape }) {
  const nub = 'pointer-events-none absolute rounded bg-current opacity-25';
  if (shape === 'round') {
    return (
      <>
        <span className={`${nub} left-1/2 -top-1.5 h-2 w-6 -translate-x-1/2`} />
        <span className={`${nub} left-1/2 -bottom-1.5 h-2 w-6 -translate-x-1/2`} />
        <span className={`${nub} -left-1.5 top-1/2 h-6 w-2 -translate-y-1/2`} />
        <span className={`${nub} -right-1.5 top-1/2 h-6 w-2 -translate-y-1/2`} />
      </>
    );
  }
  const count = shape === 'rectangle' ? 3 : 2;
  const pcts = count === 3 ? ['25%', '50%', '75%'] : ['33%', '67%'];
  return (
    <>
      {pcts.map((p) => (
        <span key={`t${p}`} className={`${nub} -top-1.5 h-2 w-7 -translate-x-1/2`} style={{ left: p }} />
      ))}
      {pcts.map((p) => (
        <span key={`b${p}`} className={`${nub} -bottom-1.5 h-2 w-7 -translate-x-1/2`} style={{ left: p }} />
      ))}
    </>
  );
}

function LegendBar() {
  const swatch = 'inline-block h-3 w-4 shrink-0 rounded-sm border';
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border bg-card px-3 py-2 text-xs">
      <span className="flex items-center gap-1.5">
        <span className={`${swatch} bg-card border-border`} /> Available
      </span>
      <span className="flex items-center gap-1.5">
        <span className={`${swatch} bg-orange-200 border-orange-400`} /> Occupied
      </span>
      <span className="flex items-center gap-1.5">
        <span className={`${swatch} bg-orange-50 border-orange-300`} /> Reserved
      </span>
      <span className="flex items-center gap-1.5">
        <span className={`${swatch} bg-red-100 border-red-500`} /> Needs Attention
      </span>
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-3 w-3 shrink-0 rounded-full bg-amber-400" /> Unverified
      </span>
      <span className="text-muted-foreground">
        Occupied &amp; Reserved share the orange family &mdash; both mean &ldquo;something&rsquo;s happening here.&rdquo;
      </span>
    </div>
  );
}

function EntranceMarker({ x, y }: { x: number; y: number }) {
  return (
    <div
      className="pointer-events-none absolute flex items-end gap-2 text-muted-foreground"
      style={{ left: x, top: y }}
    >
      <span className="relative block h-9 w-12 rounded-tl-full border-b-2 border-l-2 border-muted-foreground/60" />
      <span className="pb-1 text-[11px] font-semibold uppercase tracking-wide">Entrance</span>
    </div>
  );
}

export function FloorPlanPanel({ selectedDay }: { selectedDay: string }) {
  const { user } = useAuth();
  const canManage = user?.role === 'manager' || user?.role === 'executive';
  const [, navigate] = useLocation();
  const isToday = selectedDay === todayIsoPH();

  const [tables, setTables] = useState<ApiTable[]>([]);
  const [transactions, setTransactions] = useState<ApiTransaction[]>([]);
  const [reservations, setReservations] = useState<ApiReservation[]>([]);
  const [products, setProducts] = useState<ApiProduct[]>([]);
  const [loading, setLoading] = useState(true);

  const [now, setNow] = useState(() => new Date());
  const [editing, setEditing] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [seatGuests, setSeatGuests] = useState(2);
  const [seatBusyId, setSeatBusyId] = useState<string | null>(null);

  // Phase 5: Switch table / transfer -- moves an occupied table's open order
  // (and its linked seated reservation, if any) to a different table.
  const [switchTableOpen, setSwitchTableOpen] = useState(false);
  const [switchTableChoice, setSwitchTableChoice] = useState('');
  const [switchingTable, setSwitchingTable] = useState(false);
  const [zoom, setZoom] = useState<number>(readZoom);
  const [activeZone, setActiveZone] = useState<string | null>(null);

  // Optimistic positions during a drag, keyed by table id.
  const [posOverride, setPosOverride] = useState<Record<string, { x: number; y: number }>>({});
  const dragRef = useRef<{ id: string; zone: string; offX: number; offY: number } | null>(null);
  const zoneCanvasRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const zoneSectionRefs = useRef<Record<string, HTMLElement | null>>({});
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(() => {
    Promise.all([
      fetchTables(),
      fetchTransactions({ date: selectedDay }),
      fetchReservations('confirmed', selectedDay),
      fetchProducts(true),
    ])
      .then(([t, tx, r, p]) => {
        setTables(t);
        setTransactions(tx);
        setReservations(r);
        setProducts(p);
      })
      .catch((e) => toast.error(`Failed to load floor plan: ${e instanceof Error ? e.message : 'Unknown error'}`))
      .finally(() => setLoading(false));
  }, [selectedDay]);

  useVisiblePolling(load, POLL_INTERVAL_MS);

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    try {
      sessionStorage.setItem(ZOOM_KEY, String(zoom));
    } catch {
      /* private mode / storage disabled */
    }
  }, [zoom]);

  const zones = useMemo(() => {
    const set = new Set<string>();
    for (const t of tables) if (editing || t.active) set.add(t.floor_group || 'Main Dining');
    return Array.from(set).sort();
  }, [tables, editing]);

  useEffect(() => {
    if (zones.length && (activeZone === null || !zones.includes(activeZone))) setActiveZone(zones[0]);
  }, [zones, activeZone]);

  // The zone that gets the entrance marker: the first one whose name looks
  // like the main room, else the last zone.
  const entranceZone = useMemo(() => {
    if (!zones.length) return null;
    return zones.find((z) => /main|dining/i.test(z)) ?? zones[zones.length - 1];
  }, [zones]);

  // size.id -> {product, size}, so an open order's line items can be shown by
  // name in the detail dialog (same lookup KitchenDisplay / OrderQueue use).
  const sizeIndex = useMemo(() => {
    const map = new Map<string, { product: ApiProduct; size: ApiProductSize }>();
    for (const product of products) {
      for (const size of product.sizes) map.set(size.id, { product, size });
    }
    return map;
  }, [products]);

  const txnById = useMemo(() => {
    const map = new Map<string, ApiTransaction>();
    for (const tx of transactions) map.set(tx.id, tx);
    return map;
  }, [transactions]);

  const openTxnByPosNumber = useMemo(() => {
    const map = new Map<number, ApiTransaction>();
    for (const tx of transactions) {
      if (tx.status !== 'open' || tx.order_type !== 'dine_in' || tx.table_number == null) continue;
      const prev = map.get(tx.table_number);
      if (!prev || tx.opened_at > prev.opened_at) map.set(tx.table_number, tx);
    }
    return map;
  }, [transactions]);

  const derive = useCallback(
    (t: ApiTable): Derived => {
      const { iso, minutes } = phNow();
      const tableReservations = reservations.filter(
        (r) => r.table_id === t.id && r.reservation_date === selectedDay
      );

      // For a day other than today there's no live "now" and transactions
      // aren't meaningful -- just show which tables carry a booking.
      if (!isToday) {
        const reservation = tableReservations[0] ?? null;
        return { state: reservation ? 'orange' : 'white', openTxn: null, reservation, breach: false };
      }

      const openTxn = t.pos_table_number != null ? openTxnByPosNumber.get(t.pos_table_number) ?? null : null;

      let reservation: ApiReservation | null = null;
      let breach = false;
      for (const r of tableReservations) {
        if (r.reservation_date !== iso) continue;
        const start = hhmmToMinutes(r.start_time) - RESERVATION_PREP_BUFFER_MIN;
        const end = hhmmToMinutes(r.end_time);
        // Window can wrap past midnight (late close + a near-close start).
        const inWindow = start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
        if (inWindow) {
          reservation = r;
          const seated =
            !!r.seated_at || (!!r.transaction_id && txnById.get(r.transaction_id)?.status === 'open');
          breach =
            !openTxn && !seated && minutes >= hhmmToMinutes(r.start_time) + RESERVATION_PREP_BUFFER_MIN;
          break;
        }
      }

      const state: TableState = breach ? 'red' : openTxn || reservation ? 'orange' : 'white';
      return { state, openTxn, reservation, breach };
    },
    [openTxnByPosNumber, reservations, selectedDay, isToday, txnById]
  );

  const shownTables = useMemo(
    () => tables.filter((t) => editing || t.active),
    [tables, editing]
  );
  const tablesByZone = useMemo(() => {
    const map: Record<string, ApiTable[]> = {};
    for (const t of shownTables) {
      const z = t.floor_group || 'Main Dining';
      (map[z] ||= []).push(t);
    }
    return map;
  }, [shownTables]);

  // Per-zone canvas size: wide enough for CANVAS_W, tall enough for the
  // lowest table in that zone plus room for the entrance marker.
  const zoneDims = useCallback(
    (zone: string): { w: number; h: number } => {
      let maxX = 520;
      let maxY = 240;
      for (const t of tablesByZone[zone] ?? []) {
        const { w, h } = renderSize(t);
        const x = posOverride[t.id]?.x ?? t.pos_x ?? 40;
        const y = posOverride[t.id]?.y ?? t.pos_y ?? 40;
        maxX = Math.max(maxX, x + w + 48);
        maxY = Math.max(maxY, y + h + 56);
      }
      return { w: Math.max(CANVAS_W, maxX), h: maxY + (zone === entranceZone ? 40 : 0) };
    },
    [tablesByZone, posOverride, entranceZone]
  );

  const unverifiedCount = useMemo(() => tables.filter((t) => t.needs_layout_review).length, [tables]);

  function jumpToZone(zone: string) {
    setActiveZone(zone);
    zoneSectionRefs.current[zone]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function zoomBy(delta: number) {
    setZoom((z) => {
      const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round((z + delta) * 100) / 100));
      return next;
    });
  }

  // ---- drag (editor) ----
  function onTablePointerDown(e: React.PointerEvent, t: ApiTable) {
    if (!editing) return;
    e.preventDefault();
    setSelectedId(t.id);
    const zone = t.floor_group || 'Main Dining';
    const canvas = zoneCanvasRefs.current[zone];
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const curX = posOverride[t.id]?.x ?? t.pos_x ?? 0;
    const curY = posOverride[t.id]?.y ?? t.pos_y ?? 0;
    // rect is post-transform (zoomed) -- convert the pointer offset back to
    // unscaled canvas units.
    dragRef.current = {
      id: t.id,
      zone,
      offX: (e.clientX - rect.left) / zoom - curX,
      offY: (e.clientY - rect.top) / zoom - curY,
    };
    (e.target as Element).setPointerCapture(e.pointerId);
  }
  function onTablePointerMove(e: React.PointerEvent) {
    const d = dragRef.current;
    if (!d) return;
    const canvas = zoneCanvasRefs.current[d.zone];
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const dims = zoneDims(d.zone);
    const x = Math.max(0, Math.min(dims.w - 20, (e.clientX - rect.left) / zoom - d.offX));
    const y = Math.max(0, Math.min(dims.h - 20, (e.clientY - rect.top) / zoom - d.offY));
    setPosOverride((p) => ({ ...p, [d.id]: { x, y } }));
  }
  async function onTablePointerUp() {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;
    const pos = posOverride[d.id];
    if (!pos) return;
    try {
      await updateTable(d.id, { pos_x: Math.round(pos.x), pos_y: Math.round(pos.y) });
      setTables((prev) =>
        prev.map((t) =>
          t.id === d.id ? { ...t, pos_x: Math.round(pos.x), pos_y: Math.round(pos.y), needs_layout_review: false } : t
        )
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save position');
      load();
    }
  }

  const selected = tables.find((t) => t.id === selectedId) ?? null;
  const detail = tables.find((t) => t.id === detailId) ?? null;
  const detailDerived = detail ? derive(detail) : null;

  function seatWalkIn(t: ApiTable, guests: number, reservationId?: string) {
    if (t.pos_table_number == null) {
      toast.error('Assign a POS number to this table in the Tables tab first');
      return;
    }
    const q = reservationId ? `&reservation=${reservationId}` : '';
    navigate(`/pos?table=${t.pos_table_number}&guests=${guests}${q}`);
  }

  async function markSeated(reservationId: string) {
    setSeatBusyId(reservationId);
    try {
      await seatReservation(reservationId);
      toast.success('Marked as seated');
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not mark seated');
    } finally {
      setSeatBusyId(null);
    }
  }

  // Seating queue for the selected day: every confirmed reservation with its
  // derived lifecycle phase. `reservations` is already date-scoped by load().
  const nowMinutes = phNow().minutes;
  const seatingQueue = [...reservations]
    .sort((a, b) => a.start_time.localeCompare(b.start_time))
    .map((r) => ({ r, phase: reservationPhase(r, isToday, nowMinutes, txnById) }));
  const toSeat = seatingQueue.filter((q) => (isToday ? NEEDS_SEATING.includes(q.phase) : true));
  const coversToSeat = toSeat.reduce((sum, q) => sum + q.r.party_size, 0);
  const activeTables = tables.filter((t) => t.active);
  const freeTableCount = activeTables.filter((t) => derive(t).state === 'white').length;
  const tableById = new Map(tables.map((t) => [t.id, t]));

  const detailReservations = detailId ? seatingQueue.filter((q) => q.r.table_id === detailId) : [];
  const detailActionable =
    detailReservations.find((q) => q.phase === 'overdue' || q.phase === 'due') ??
    detailReservations.find((q) => q.phase === 'upcoming') ??
    null;

  function renderTable(t: ApiTable) {
    const d = derive(t);
    const { w, h } = renderSize(t);
    const x = posOverride[t.id]?.x ?? t.pos_x ?? 40;
    const y = posOverride[t.id]?.y ?? t.pos_y ?? 40;
    return (
      <button
        key={t.id}
        type="button"
        onPointerDown={(e) => onTablePointerDown(e, t)}
        onClick={() => {
          if (editing) setSelectedId(t.id);
          else {
            setDetailId(t.id);
            setSeatGuests(Math.min(2, t.capacity_max ?? t.capacity));
          }
        }}
        className={[
          'absolute flex flex-col items-center justify-center border-2 p-1 text-center text-[11px] leading-tight transition',
          t.shape === 'round' ? 'rounded-full' : 'rounded-md',
          STATE_CLASS[d.state],
          editing ? 'cursor-move' : 'cursor-pointer hover:brightness-95',
          selectedId === t.id && editing ? 'ring-2 ring-primary' : '',
        ].join(' ')}
        style={{ left: x, top: y, width: w, height: h }}
      >
        <ChairNubs shape={t.shape} />
        <span className="font-semibold">{t.label}</span>
        <span className="text-[10px] font-medium opacity-70">{seatLabel(t)}</span>
        {d.openTxn && (
          <>
            <span className="mt-0.5 font-semibold">
              {d.openTxn.order_number != null ? `#${d.openTxn.order_number} · ` : ''}
              {formatCurrency(d.openTxn.total_amount)}
            </span>
            <span className="text-[10px] opacity-80">
              &#9201; {elapsedLabel(elapsedSeconds(d.openTxn.opened_at, now))}
            </span>
          </>
        )}
        {!d.openTxn && d.reservation && (
          <>
            <span className="mt-0.5 w-full truncate">{d.reservation.customer_name}</span>
            <span className="text-[10px] opacity-80">
              {d.reservation.party_size}p &middot; {hhmm(d.reservation.start_time)}
            </span>
          </>
        )}
        {d.breach && <span className="font-semibold">overdue</span>}
        {t.needs_layout_review && (
          <span
            className="absolute -top-1.5 -right-1.5 h-3 w-3 rounded-full bg-amber-400"
            title="Not verified on-site"
          />
        )}
      </button>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1">
          {zones.map((z) => (
            <Button
              key={z}
              size="sm"
              variant={z === activeZone ? 'default' : 'outline'}
              onClick={() => jumpToZone(z)}
            >
              {z}
            </Button>
          ))}
        </div>
        {canManage && (
          <Button
            size="sm"
            variant={editing ? 'default' : 'outline'}
            onClick={() => {
              setEditing((v) => !v);
              setSelectedId(null);
            }}
          >
            {editing ? 'Done editing' : 'Edit layout'}
          </Button>
        )}
      </div>

      {unverifiedCount > 0 && (
        <p className="text-xs text-amber-600">
          {unverifiedCount} table{unverifiedCount === 1 ? '' : 's'} not yet verified on-site — position and capacity
          are a starting estimate until a manager confirms them in the editor.
        </p>
      )}

      {loading && <p className="text-sm text-muted-foreground">Loading floor plan…</p>}
      {!loading && tables.length === 0 && (
        <p className="text-sm text-muted-foreground">No tables set up yet. Add tables in the Tables tab.</p>
      )}

      <div className="flex gap-4">
        <div className="relative min-w-0 flex-1">
          <div ref={scrollRef} className="max-h-[70vh] overflow-auto rounded-md border bg-muted/20">
            <div
              className="origin-top-left p-4"
              style={{ transform: `scale(${zoom})`, width: `${100 / zoom}%` }}
              onPointerMove={onTablePointerMove}
              onPointerUp={onTablePointerUp}
            >
              {zones.map((zone, i) => {
                const dims = zoneDims(zone);
                return (
                  <section
                    key={zone}
                    ref={(el) => {
                      zoneSectionRefs.current[zone] = el;
                    }}
                    className={i > 0 ? 'mt-6 border-t border-dashed pt-6' : ''}
                  >
                    <h3 className="mb-2 text-xs font-bold uppercase tracking-widest text-primary">{zone}</h3>
                    <div
                      ref={(el) => {
                        zoneCanvasRefs.current[zone] = el;
                      }}
                      className="relative"
                      style={{ width: dims.w, height: dims.h }}
                    >
                      {(tablesByZone[zone] ?? []).map(renderTable)}
                      {zone === entranceZone && (
                        <EntranceMarker x={dims.w - 150} y={dims.h - 52} />
                      )}
                    </div>
                  </section>
                );
              })}
            </div>
          </div>

          {/* Zoom control -- bottom-left, over the scroll area (target design). */}
          <div className="absolute bottom-3 left-3 flex flex-col overflow-hidden rounded-md border bg-card shadow-sm">
            <button
              type="button"
              aria-label="Zoom in"
              className="flex h-10 w-10 items-center justify-center text-lg hover:bg-muted disabled:opacity-40"
              disabled={zoom >= ZOOM_MAX}
              onClick={() => zoomBy(ZOOM_STEP)}
            >
              +
            </button>
            <button
              type="button"
              aria-label="Zoom out"
              className="flex h-10 w-10 items-center justify-center border-t text-lg hover:bg-muted disabled:opacity-40"
              disabled={zoom <= ZOOM_MIN}
              onClick={() => zoomBy(-ZOOM_STEP)}
            >
              &minus;
            </button>
          </div>
        </div>

        {editing && selected && (
          <EditorForm
            key={selected.id}
            table={selected}
            zones={zones}
            onSaved={(updated) => {
              setTables((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
            }}
          />
        )}

        {!editing && (
          <div className="w-72 shrink-0 space-y-3">
            <div className="rounded-md border bg-card p-3 text-sm">
              {isToday ? (
                <>
                  <p className="font-semibold">
                    To seat: {toSeat.length} {toSeat.length === 1 ? 'party' : 'parties'}
                    <span className="font-normal text-muted-foreground"> · {coversToSeat} covers</span>
                  </p>
                  <p className="text-muted-foreground">
                    Tables free: <span className="font-semibold text-foreground">{freeTableCount}</span> / {activeTables.length}
                  </p>
                </>
              ) : (
                <p className="font-semibold">
                  {seatingQueue.length} {seatingQueue.length === 1 ? 'party' : 'parties'} booked
                  <span className="font-normal text-muted-foreground">
                    {' '}· {seatingQueue.reduce((s, q) => s + q.r.party_size, 0)} covers
                  </span>
                </p>
              )}
            </div>

            <div className="rounded-md border bg-card">
              <p className="border-b px-3 py-2 text-xs font-bold uppercase tracking-widest text-primary">
                Reservations
              </p>
              {seatingQueue.length === 0 ? (
                <p className="px-3 py-4 text-sm text-muted-foreground">No confirmed reservations for this day.</p>
              ) : (
                <ul className="max-h-[55vh] divide-y overflow-auto">
                  {seatingQueue.map(({ r, phase }) => {
                    const table = tableById.get(r.table_id);
                    return (
                      <li key={r.id} className="px-3 py-2 text-sm">
                        <button
                          type="button"
                          className="flex w-full items-center justify-between gap-2 text-left hover:opacity-80"
                          onClick={() => {
                            setDetailId(r.table_id);
                            if (table) jumpToZone(table.floor_group || 'Main Dining');
                          }}
                        >
                          <span className="min-w-0">
                            <span className="font-corp-mono font-semibold">
                              {hhmm(r.start_time)}–{hhmm(r.end_time)}
                            </span>{' '}
                            <span className="truncate">{r.customer_name}</span>
                          </span>
                          <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${PHASE_META[phase].className}`}>
                            {PHASE_META[phase].label}
                          </span>
                        </button>
                        <div className="mt-0.5 flex items-center justify-between text-xs text-muted-foreground">
                          <span>
                            {r.party_size}p · {table?.label ?? r.table_label ?? 'Unassigned'}
                          </span>
                          {isToday && NEEDS_SEATING.includes(phase) && (
                            <button
                              type="button"
                              className="rounded border px-1.5 py-0.5 font-medium text-foreground hover:bg-muted disabled:opacity-50"
                              disabled={seatBusyId === r.id}
                              onClick={() => markSeated(r.id)}
                            >
                              {seatBusyId === r.id ? '…' : 'Mark seated'}
                            </button>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
        )}
      </div>

      {tables.length > 0 && <LegendBar />}

      {/* Table detail / seating (view mode) */}
      <Dialog open={!!detail} onOpenChange={(o) => !o && setDetailId(null)}>
        <DialogContent>
          {detail && detailDerived && (
            <>
              <DialogHeader>
                <DialogTitle>{detail.label}</DialogTitle>
                <DialogDescription>
                  Seats {detail.capacity_min ?? detail.capacity}
                  {(detail.capacity_max ?? detail.capacity) !== (detail.capacity_min ?? detail.capacity)
                    ? `–${detail.capacity_max}`
                    : ''}
                  {' · '}
                  {detail.floor_group}
                </DialogDescription>
              </DialogHeader>

              {detailDerived.openTxn ? (
                <div className="space-y-2 text-sm">
                  <p className="font-semibold">
                    {detailDerived.openTxn.order_number != null
                      ? `Order #${detailDerived.openTxn.order_number}`
                      : 'Open order'}{' '}
                    · {formatCurrency(detailDerived.openTxn.total_amount)} ·{' '}
                    {elapsedLabel(elapsedSeconds(detailDerived.openTxn.opened_at, now))} elapsed
                  </p>
                  <p className="text-xs text-muted-foreground">
                    opened {new Date(detailDerived.openTxn.opened_at).toLocaleTimeString()}
                    {detailDerived.openTxn.guest_count ? ` · ${detailDerived.openTxn.guest_count} guests` : ''}
                  </p>
                  <ul className="space-y-1 rounded-md border bg-muted/30 p-2">
                    {detailDerived.openTxn.items.map((item) => {
                      const resolved = sizeIndex.get(item.product_size_id);
                      const name = resolved
                        ? `${resolved.product.name} (${resolved.size.size_label})`
                        : 'Item';
                      return (
                        <li key={item.id}>
                          <span className="font-medium">
                            {item.quantity}× {name}
                          </span>
                          {item.held_ingredients.length > 0 && (
                            <span className="block text-xs text-destructive">
                              hold: {item.held_ingredients.join(', ')}
                            </span>
                          )}
                          {item.addons.length > 0 && (
                            <span className="block text-xs text-muted-foreground">
                              +{' '}
                              {item.addons
                                .map((a) => `${a.addon_name ?? 'Add-on'}${a.quantity > 1 ? ` x${a.quantity}` : ''}`)
                                .join(', ')}
                            </span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                  <div className="flex flex-wrap gap-2 pt-1">
                    <Button size="sm" onClick={() => navigate('/order-queue')}>
                      Open in Order Queue
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={async () => {
                        try {
                          await closeTransaction(detailDerived.openTxn!.id);
                          toast.success('Table cleared');
                          setDetailId(null);
                          load();
                        } catch (e) {
                          toast.error(describeError(e, 'Could not clear the table'));
                        }
                      }}
                    >
                      Diner done
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setSwitchTableChoice('');
                        setSwitchTableOpen(true);
                      }}
                    >
                      Switch table
                    </Button>
                    {/* WS-12: void narrowed to queued-only -- a preparing/ready
                        order must go through a Refund request from Order Queue
                        instead; the backend now rejects a direct void past
                        queued anyway, so this button must not offer it. */}
                    {detailDerived.openTxn.kitchen_status === 'queued' && (
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={async () => {
                          const reason = window.prompt('Reason for voiding this order?');
                          if (!reason?.trim()) return;
                          try {
                            await voidTransaction(detailDerived.openTxn!.id, reason.trim());
                            toast.success('Order voided');
                            setDetailId(null);
                            load();
                          } catch (e) {
                            toast.error(e instanceof Error ? e.message : 'Failed to void');
                          }
                        }}
                      >
                        Void order
                      </Button>
                    )}
                  </div>
                </div>
              ) : detailReservations.length > 0 ? (
                <div className="space-y-3 text-sm">
                  <p className="text-xs text-muted-foreground">
                    {detailReservations.length} reservation{detailReservations.length === 1 ? '' : 's'} on{' '}
                    {selectedDay}
                  </p>
                  <ul className="divide-y rounded-md border">
                    {detailReservations.map(({ r, phase }) => (
                      <li key={r.id} className="space-y-1 p-2">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-corp-mono font-semibold">
                            {hhmm(r.start_time)}–{hhmm(r.end_time)}
                          </span>
                          <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${PHASE_META[phase].className}`}>
                            {PHASE_META[phase].label}
                          </span>
                        </div>
                        <p>
                          {r.customer_name} · party of {r.party_size}
                        </p>
                        <p className="text-muted-foreground">{r.customer_phone}</p>
                        {isToday && phase !== 'seated' && phase !== 'completed' && (
                          <div className="flex flex-wrap gap-2 pt-1">
                            <Button
                              size="sm"
                              onClick={() => {
                                seatWalkIn(detail, r.party_size, r.id);
                                setDetailId(null);
                              }}
                            >
                              Seat via POS
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={seatBusyId === r.id}
                              onClick={() => markSeated(r.id)}
                            >
                              Mark seated
                            </Button>
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                  {detailActionable && (
                    <p className="text-xs text-muted-foreground">
                      "Seat via POS" opens the terminal pre-set to this table; the reservation is marked
                      seated when the order is charged.
                    </p>
                  )}
                </div>
              ) : (
                <div className="space-y-3 text-sm">
                  <p className="text-muted-foreground">Table is free.</p>
                  <div className="flex items-center gap-2">
                    <Label>Guests</Label>
                    <Button
                      size="icon"
                      variant="outline"
                      className="h-7 w-7"
                      onClick={() => setSeatGuests((g) => Math.max(1, g - 1))}
                    >
                      −
                    </Button>
                    <span className="w-6 text-center">{seatGuests}</span>
                    <Button
                      size="icon"
                      variant="outline"
                      className="h-7 w-7"
                      onClick={() =>
                        setSeatGuests((g) => Math.min(detail.capacity_max ?? detail.capacity, g + 1))
                      }
                    >
                      +
                    </Button>
                  </div>
                  <Button
                    size="sm"
                    onClick={() => {
                      seatWalkIn(detail, seatGuests);
                      setDetailId(null);
                    }}
                  >
                    Seat party at {detail.label}
                  </Button>
                </div>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={switchTableOpen} onOpenChange={setSwitchTableOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Switch table</DialogTitle>
            <DialogDescription>
              Move this order (and its seated reservation, if any) to a different table.
            </DialogDescription>
          </DialogHeader>
          <Select value={switchTableChoice} onValueChange={setSwitchTableChoice}>
            <SelectTrigger>
              <SelectValue placeholder="Pick a table" />
            </SelectTrigger>
            <SelectContent>
              {tables
                .filter(
                  (t) =>
                    t.active &&
                    t.pos_table_number != null &&
                    t.pos_table_number !== detail?.pos_table_number &&
                    !openTxnByPosNumber.has(t.pos_table_number)
                )
                .map((t) => (
                  <SelectItem key={t.id} value={String(t.pos_table_number)}>
                    {t.label} · seats {t.capacity_max ?? t.capacity}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
          <DialogFooter>
            <Button
              disabled={!switchTableChoice || switchingTable}
              onClick={async () => {
                if (!detailDerived?.openTxn) return;
                setSwitchingTable(true);
                try {
                  await switchTable(detailDerived.openTxn.id, Number(switchTableChoice));
                  toast.success('Table switched');
                  setSwitchTableOpen(false);
                  setDetailId(null);
                  load();
                } catch (e) {
                  toast.error(describeError(e, 'Could not switch tables'));
                } finally {
                  setSwitchingTable(false);
                }
              }}
            >
              {switchingTable ? 'Switching...' : 'Confirm switch'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------------------

function EditorForm({
  table,
  zones,
  onSaved,
}: {
  table: ApiTable;
  zones: string[];
  onSaved: (t: ApiTable) => void;
}) {
  const [shape, setShape] = useState<TableShape>(table.shape);
  const [width, setWidth] = useState(String(table.width));
  const [height, setHeight] = useState(String(table.height));
  const [floorGroup, setFloorGroup] = useState(table.floor_group);
  const [rangeMode, setRangeMode] = useState(
    (table.capacity_min ?? table.capacity) !== (table.capacity_max ?? table.capacity)
  );
  const [capMin, setCapMin] = useState(String(table.capacity_min ?? table.capacity));
  const [capMax, setCapMax] = useState(String(table.capacity_max ?? table.capacity));
  const [saving, setSaving] = useState(false);

  const knownZones = Array.from(new Set([...zones, 'Booth Row', 'Main Dining']));

  async function save() {
    const w = Number(width);
    const h = Number(height);
    const cMin = rangeMode ? Number(capMin) : Number(capMax);
    const cMax = Number(capMax);
    if (!Number.isFinite(w) || w <= 0 || !Number.isFinite(h) || h <= 0) {
      toast.error('Width and height must be positive');
      return;
    }
    if (!Number.isInteger(cMax) || cMax <= 0 || (rangeMode && (!Number.isInteger(cMin) || cMin <= 0 || cMin > cMax))) {
      toast.error('Check the capacity values (min ≤ max, both > 0)');
      return;
    }
    setSaving(true);
    try {
      const updated = await updateTable(table.id, {
        shape,
        width: w,
        height: h,
        floor_group: floorGroup.trim() || 'Main Dining',
        capacity_min: cMin,
        capacity_max: cMax,
      });
      toast.success('Table layout saved');
      onSaved(updated);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="w-64 shrink-0 space-y-3 rounded-md border p-3">
      <p className="font-corp-display text-sm font-semibold">{table.label}</p>

      <div className="space-y-1">
        <Label>Shape</Label>
        <Select value={shape} onValueChange={(v) => setShape(v as TableShape)}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="square">Square</SelectItem>
            <SelectItem value="rectangle">Rectangle</SelectItem>
            <SelectItem value="round">Round</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="flex gap-2">
        <div className="space-y-1">
          <Label>Width</Label>
          <Input type="number" min={1} value={width} onChange={(e) => setWidth(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label>Height</Label>
          <Input type="number" min={1} value={height} onChange={(e) => setHeight(e.target.value)} />
        </div>
      </div>

      <div className="space-y-1">
        <Label>Zone</Label>
        <Input
          list="floor-plan-zones"
          value={floorGroup}
          onChange={(e) => setFloorGroup(e.target.value)}
          placeholder="Main Dining"
        />
        <datalist id="floor-plan-zones">
          {knownZones.map((z) => (
            <option key={z} value={z} />
          ))}
        </datalist>
      </div>

      <div className="space-y-1">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={rangeMode} onChange={(e) => setRangeMode(e.target.checked)} />
          Flexible capacity (bench)
        </label>
        {rangeMode ? (
          <div className="flex items-center gap-2">
            <Input type="number" min={1} value={capMin} onChange={(e) => setCapMin(e.target.value)} className="w-16" />
            <span className="text-muted-foreground">to</span>
            <Input type="number" min={1} value={capMax} onChange={(e) => setCapMax(e.target.value)} className="w-16" />
          </div>
        ) : (
          <Input
            type="number"
            min={1}
            value={capMax}
            onChange={(e) => setCapMax(e.target.value)}
            className="w-20"
          />
        )}
        <p className="text-xs text-muted-foreground">Seating capacity used for reservations and walk-ins.</p>
      </div>

      <Button size="sm" className="w-full" disabled={saving} onClick={save}>
        {saving ? 'Saving…' : 'Save'}
      </Button>
      <p className="text-xs text-muted-foreground">Drag the table on the canvas to reposition it.</p>
    </div>
  );
}
