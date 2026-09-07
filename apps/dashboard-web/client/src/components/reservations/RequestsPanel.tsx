import React, { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
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
  ReservationStatus,
  cancelReservation,
  confirmReservation,
  declineReservation,
  fetchReservations,
} from '@/lib/api';
import { POLL_INTERVAL_MS } from '@/lib/constants';
import { useVisiblePolling } from '@/hooks/useVisiblePolling';

const STATUS_LABELS: Record<ReservationStatus, string> = {
  pending: 'Pending',
  confirmed: 'Confirmed',
  declined: 'Declined',
  cancelled: 'Cancelled',
};

export function RequestsPanel({ selectedDay }: { selectedDay: string }) {
  const [statusFilter, setStatusFilter] = useState<ReservationStatus>('pending');
  const [dateFilterOn, setDateFilterOn] = useState(true);
  const [reservations, setReservations] = useState<ApiReservation[]>([]);
  const [loading, setLoading] = useState(true);

  const [confirmTarget, setConfirmTarget] = useState<ApiReservation | null>(null);
  const [declineTarget, setDeclineTarget] = useState<ApiReservation | null>(null);
  const [declineReason, setDeclineReason] = useState('');
  const [cancelTarget, setCancelTarget] = useState<ApiReservation | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    fetchReservations(statusFilter, dateFilterOn ? selectedDay : undefined)
      .then(setReservations)
      .catch((e) => toast.error(`Failed to load reservations: ${e instanceof Error ? e.message : 'Unknown error'}`))
      .finally(() => setLoading(false));
  }, [statusFilter, dateFilterOn, selectedDay]);

  useVisiblePolling(load, POLL_INTERVAL_MS);

  async function handleConfirm() {
    if (!confirmTarget) return;
    setBusy(true);
    try {
      await confirmReservation(confirmTarget.id);
      toast.success(`Reservation #${confirmTarget.reservation_number} confirmed`);
      setConfirmTarget(null);
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to confirm reservation');
    } finally {
      setBusy(false);
    }
  }

  async function handleDecline() {
    if (!declineTarget) return;
    if (!declineReason.trim()) {
      toast.error('A decline reason is required');
      return;
    }
    setBusy(true);
    try {
      await declineReservation(declineTarget.id, declineReason.trim());
      toast.success(`Reservation #${declineTarget.reservation_number} declined`);
      setDeclineTarget(null);
      setDeclineReason('');
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to decline reservation');
    } finally {
      setBusy(false);
    }
  }

  async function handleCancel() {
    if (!cancelTarget) return;
    setBusy(true);
    try {
      await cancelReservation(cancelTarget.id);
      toast.success(`Reservation #${cancelTarget.reservation_number} cancelled`);
      setCancelTarget(null);
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to cancel reservation');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as ReservationStatus)}>
          <SelectTrigger className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="pending">Pending</SelectItem>
            <SelectItem value="confirmed">Confirmed</SelectItem>
            <SelectItem value="declined">Declined</SelectItem>
            <SelectItem value="cancelled">Cancelled</SelectItem>
          </SelectContent>
        </Select>
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <input
            type="checkbox"
            checked={!dateFilterOn}
            onChange={(e) => setDateFilterOn(!e.target.checked)}
          />
          All dates
        </label>
        {dateFilterOn && <span className="text-xs text-muted-foreground">Showing {selectedDay}</span>}
      </div>

      {loading && <p className="text-sm text-muted-foreground">Loading reservations...</p>}
      {!loading && reservations.length === 0 && (
        <p className="text-sm text-muted-foreground">No {STATUS_LABELS[statusFilter].toLowerCase()} reservations.</p>
      )}

      {reservations.map((r) => (
        <Card key={r.id}>
          <CardContent className="py-3 space-y-2">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div className="flex items-center gap-2">
                <span className="font-corp-display text-sm">Request #{r.reservation_number}</span>
                <Badge variant="outline">{r.table_label || 'Unassigned'}</Badge>
                <Badge variant="gold">Party of {r.party_size}</Badge>
              </div>
              <span className="font-semibold">
                {r.reservation_date} · {r.start_time.slice(0, 5)}
              </span>
            </div>

            <p className="text-sm">
              <span className="text-muted-foreground">Contact:</span> {r.customer_name} -- {r.customer_phone}
            </p>
            {r.customer_note && <p className="text-sm italic text-muted-foreground">Note: {r.customer_note}</p>}
            {r.declined_reason && <p className="text-sm text-destructive">Reason: {r.declined_reason}</p>}
            {r.overrides?.map((o, i) => (
              <p key={i} className="text-sm text-amber-600">
                Overridden at the POS: {o.reason} ({new Date(o.created_at).toLocaleString()})
              </p>
            ))}

            {r.status === 'pending' && (
              <div className="flex items-center gap-2 pt-1">
                <Button size="sm" onClick={() => setConfirmTarget(r)}>
                  Confirm
                </Button>
                <Button size="sm" variant="destructive" onClick={() => setDeclineTarget(r)}>
                  Decline
                </Button>
              </div>
            )}
            {r.status === 'confirmed' && (
              <div className="flex items-center gap-2 pt-1">
                <Button size="sm" variant="destructive" onClick={() => setCancelTarget(r)}>
                  Cancel reservation
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      ))}

      <Dialog open={!!confirmTarget} onOpenChange={(open) => !open && setConfirmTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm reservation #{confirmTarget?.reservation_number}</DialogTitle>
            <DialogDescription>
              Confirm {confirmTarget?.table_label} for a party of {confirmTarget?.party_size} on{' '}
              {confirmTarget?.reservation_date} at {confirmTarget?.start_time.slice(0, 5)}.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button disabled={busy} onClick={handleConfirm}>
              {busy ? 'Confirming...' : 'Confirm reservation'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!declineTarget} onOpenChange={(open) => !open && setDeclineTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Decline reservation #{declineTarget?.reservation_number}</DialogTitle>
          </DialogHeader>
          <Input
            placeholder="Reason for declining"
            value={declineReason}
            onChange={(e) => setDeclineReason(e.target.value)}
          />
          <DialogFooter>
            <Button variant="destructive" disabled={busy} onClick={handleDecline}>
              {busy ? 'Declining...' : 'Decline reservation'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!cancelTarget} onOpenChange={(open) => !open && setCancelTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancel reservation #{cancelTarget?.reservation_number}</DialogTitle>
            <DialogDescription>This frees {cancelTarget?.table_label} for other bookings at this time.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="destructive" disabled={busy} onClick={handleCancel}>
              {busy ? 'Cancelling...' : 'Cancel reservation'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
