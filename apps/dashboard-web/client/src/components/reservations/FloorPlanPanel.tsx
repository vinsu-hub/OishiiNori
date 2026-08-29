import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import { toast } from 'sonner';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
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
  ApiReservation,
  ApiTable,
  ApiTransaction,
  TableShape,
  fetchReservations,
  fetchTables,
  fetchTransactions,
  updateTable,
  voidTransaction,
} from '@/lib/api';
import { formatCurrency } from '@/lib/utils';
import { POLL_INTERVAL_MS, todayIsoPH } from '@/lib/constants';
import { useVisiblePolling } from '@/hooks/useVisiblePolling';

const RESERVATION_PREP_BUFFER_MIN = 15; // must match reservations.py

const CANVAS_W = 1000;
const CANVAS_H = 680;

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

export function FloorPlanPanel() {
  const { user } = useAuth();
  const canManage = user?.role === 'manager' || user?.role === 'executive';
  const [, navigate] = useLocation();

  const [tables, setTables] = useState<ApiTable[]>([]);
  const [transactions, setTransactions] = useState<ApiTransaction[]>([]);
  const [reservations, setReservations] = useState<ApiReservation[]>([]);
  const [loading, setLoading] = useState(true);

  const [now, setNow] = useState(() => new Date());
  const [zone, setZone] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [seatGuests, setSeatGuests] = useState(2);

  // Optimistic positions during a drag, keyed by table id.
  const [posOverride, setPosOverride] = useState<Record<string, { x: number; y: number }>>({});
  const dragRef = useRef<{ id: string; offX: number; offY: number } | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(() => {
    const iso = todayIsoPH();
    Promise.all([
      fetchTables(),
      fetchTransactions({ date: iso }),
      fetchReservations('confirmed', iso),
    ])
      .then(([t, tx, r]) => {
        setTables(t);
        setTransactions(tx);
        setReservations(r);
      })
      .catch((e) => toast.error(`Failed to load floor plan: ${e instanceof Error ? e.message : 'Unknown error'}`))
      .finally(() => setLoading(false));
  }, []);

  useVisiblePolling(load, POLL_INTERVAL_MS);

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const zones = useMemo(() => {
    const set = new Set<string>();
    for (const t of tables) if (editing || t.active) set.add(t.floor_group || 'Main Dining');
    return Array.from(set).sort();
  }, [tables, editing]);

  useEffect(() => {
    if (zones.length && (zone === null || !zones.includes(zone))) setZone(zones[0]);
  }, [zones, zone]);

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
      const openTxn = t.pos_table_number != null ? openTxnByPosNumber.get(t.pos_table_number) ?? null : null;

      let reservation: ApiReservation | null = null;
      for (const r of reservations) {
        if (r.table_id !== t.id || r.reservation_date !== iso) continue;
        const start = hhmmToMinutes(r.start_time);
        const end = hhmmToMinutes(r.end_time);
        if (minutes >= start - RESERVATION_PREP_BUFFER_MIN && minutes < end) {
          reservation = r;
          break;
        }
      }

      const breach =
        !!reservation &&
        !openTxn &&
        phNow().minutes >= hhmmToMinutes(reservation.start_time) + RESERVATION_PREP_BUFFER_MIN;

      const state: TableState = breach ? 'red' : openTxn || reservation ? 'orange' : 'white';
      return { state, openTxn, reservation, breach };
    },
    [openTxnByPosNumber, reservations]
  );

  const visibleTables = useMemo(
    () => tables.filter((t) => (editing || t.active) && (t.floor_group || 'Main Dining') === zone),
    [tables, editing, zone]
  );

  const unverifiedCount = useMemo(() => tables.filter((t) => t.needs_layout_review).length, [tables]);

  // ---- drag (editor) ----
  function onTablePointerDown(e: React.PointerEvent, t: ApiTable) {
    if (!editing) return;
    e.preventDefault();
    setSelectedId(t.id);
    const rect = canvasRef.current!.getBoundingClientRect();
    const curX = posOverride[t.id]?.x ?? t.pos_x ?? 0;
    const curY = posOverride[t.id]?.y ?? t.pos_y ?? 0;
    dragRef.current = {
      id: t.id,
      offX: e.clientX - rect.left - curX,
      offY: e.clientY - rect.top - curY,
    };
    (e.target as Element).setPointerCapture(e.pointerId);
  }
  function onTablePointerMove(e: React.PointerEvent) {
    const d = dragRef.current;
    if (!d || !canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(CANVAS_W - 20, e.clientX - rect.left - d.offX));
    const y = Math.max(0, Math.min(CANVAS_H - 20, e.clientY - rect.top - d.offY));
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

  function seatWalkIn(t: ApiTable, guests: number) {
    if (t.pos_table_number == null) {
      toast.error('Assign a POS number to this table in the Tables tab first');
      return;
    }
    navigate(`/pos?table=${t.pos_table_number}&guests=${guests}`);
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1">
          {zones.map((z) => (
            <Button key={z} size="sm" variant={z === zone ? 'default' : 'outline'} onClick={() => setZone(z)}>
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
        <div className="overflow-auto rounded-md border bg-muted/20">
          <div
            ref={canvasRef}
            className="relative"
            style={{ width: CANVAS_W, height: CANVAS_H }}
            onPointerMove={onTablePointerMove}
            onPointerUp={onTablePointerUp}
          >
            {visibleTables.map((t) => {
              const d = derive(t);
              const x = posOverride[t.id]?.x ?? t.pos_x ?? 40;
              const y = posOverride[t.id]?.y ?? t.pos_y ?? 40;
              const w = t.shape === 'rectangle' ? Math.max(t.width, 120) : t.width;
              const h = t.height;
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
                  <span className="font-semibold">{t.label}</span>
                  {d.openTxn && (
                    <>
                      <span>{formatCurrency(d.openTxn.total_amount)}</span>
                      <span>{elapsedLabel(elapsedSeconds(d.openTxn.opened_at, now))}</span>
                    </>
                  )}
                  {!d.openTxn && d.reservation && (
                    <>
                      <span className="w-full truncate">{d.reservation.customer_name}</span>
                      <span>
                        {d.reservation.party_size}p · {hhmm(d.reservation.start_time)}
                      </span>
                    </>
                  )}
                  {d.breach && <span className="font-semibold">overdue</span>}
                  {t.needs_layout_review && (
                    <span className="absolute -top-1.5 -right-1.5 h-3 w-3 rounded-full bg-amber-400" title="Not verified on-site" />
                  )}
                </button>
              );
            })}
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
      </div>

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
                  <p>
                    Open order · {formatCurrency(detailDerived.openTxn.total_amount)} ·{' '}
                    {elapsedLabel(elapsedSeconds(detailDerived.openTxn.opened_at, now))} elapsed
                  </p>
                  <p className="text-muted-foreground">
                    {detailDerived.openTxn.items.length} item
                    {detailDerived.openTxn.items.length === 1 ? '' : 's'} · opened{' '}
                    {new Date(detailDerived.openTxn.opened_at).toLocaleTimeString()}
                  </p>
                  <div className="flex gap-2 pt-1">
                    <Button size="sm" onClick={() => navigate('/order-queue')}>
                      Open in Order Queue
                    </Button>
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
                  </div>
                </div>
              ) : detailDerived.reservation ? (
                <div className="space-y-2 text-sm">
                  {detailDerived.breach && (
                    <Badge variant="destructive">Reservation overdue — party not yet seated</Badge>
                  )}
                  <p>
                    Reserved for {detailDerived.reservation.customer_name} · party of{' '}
                    {detailDerived.reservation.party_size} · {hhmm(detailDerived.reservation.start_time)}–
                    {hhmm(detailDerived.reservation.end_time)}
                  </p>
                  <p className="text-muted-foreground">{detailDerived.reservation.customer_phone}</p>
                  <Button
                    size="sm"
                    onClick={() => {
                      seatWalkIn(detail, detailDerived.reservation!.party_size);
                      setDetailId(null);
                    }}
                  >
                    Seat this reservation
                  </Button>
                  <p className="text-xs text-muted-foreground">
                    The table is reservation-blocked at the POS; a manager PIN override will be requested.
                  </p>
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
