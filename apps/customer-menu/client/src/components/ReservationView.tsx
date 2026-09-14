import React, { useEffect, useState } from 'react';
import { ArrowRight, ChevronLeft, Loader2, Minus, Plus } from 'lucide-react';
import {
  ApiProduct,
  QueuedOfflineError,
  ReservationSlot,
  ReservationStatus,
  fetchMenu,
  fetchReservationAvailability,
  fetchReservationStatus,
  submitReservation,
} from '@/lib/api';
import { isValidPhilippinePhone, PH_PHONE_HINT } from '@/lib/validators';
import { formatTime12h } from '@/lib/utils';
import { useQueuedCompletion } from '@/hooks/useQueuedCompletion';
import QueuedSubmissionView from '@/components/QueuedSubmissionView';

declare global {
  interface Window {
    toast?: (message: string, type?: 'success' | 'error' | 'info') => void;
  }
}

function toast(message: string, type: 'success' | 'error' | 'info' = 'info') {
  window.toast?.(message, type);
}

const STATUS_POLL_MS = 5_000;

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

export default function ReservationView({ onBack }: { onBack: () => void }) {
  const [partySize, setPartySize] = useState(2);
  const [date, setDate] = useState(todayIso());
  const [slots, setSlots] = useState<ReservationSlot[]>([]);
  const [closed, setClosed] = useState(false);
  const [loadingSlots, setLoadingSlots] = useState(false);
  const [selectedTime, setSelectedTime] = useState<string | null>(null);

  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [customerNote, setCustomerNote] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const [reservation, setReservation] = useState<ReservationStatus | null>(null);
  // ReservationStatusResponse (the minimal customer-facing poll shape) never
  // carries advance-order items back -- remembered locally just to keep the
  // confirmation screen's messaging accurate after a successful submit.
  const [submittedHasAdvanceOrder, setSubmittedHasAdvanceOrder] = useState(false);

  // Set instead of a hard-fail toast when the submit request's connection
  // drops mid-flight -- the reservation is queued locally (see
  // lib/offlineQueue) and this id lets us watch for it actually going
  // through.
  const [queuedReservationId, setQueuedReservationId] = useState<string | null>(null);
  const queuedReservation = useQueuedCompletion<ReservationStatus>(queuedReservationId);
  useEffect(() => {
    if (!queuedReservationId) return;
    if (queuedReservation.status === 'done') {
      setReservation(queuedReservation.result);
      setQueuedReservationId(null);
    } else if (queuedReservation.status === 'error') {
      toast(queuedReservation.message, 'error');
      setQueuedReservationId(null);
    }
  }, [queuedReservationId, queuedReservation]);

  // Advance order (optional): asked once the guest has picked a slot and
  // filled their details. 'ask' shows the yes/no prompt; 'yes' reveals a
  // simple product picker whose quantities become advance_order_items on
  // submit; 'no' skips straight to Request this table, same as before this
  // feature existed.
  const [advanceOrderChoice, setAdvanceOrderChoice] = useState<'ask' | 'yes' | 'no'>('ask');
  const [products, setProducts] = useState<ApiProduct[]>([]);
  const [advanceQuantities, setAdvanceQuantities] = useState<Record<string, number>>({});

  useEffect(() => {
    fetchMenu()
      .then(setProducts)
      .catch(() => {
        // Advance ordering just won't be offered if the menu fails to load --
        // never block the core reservation request over it.
      });
  }, []);

  useEffect(() => {
    setSelectedTime(null);
    setLoadingSlots(true);
    fetchReservationAvailability(date, partySize)
      .then((res) => {
        setSlots(res.slots);
        setClosed(res.closed);
      })
      .catch((e) => toast(e instanceof Error ? e.message : 'Failed to load availability', 'error'))
      .finally(() => setLoadingSlots(false));
  }, [date, partySize]);

  useEffect(() => {
    if (!reservation || reservation.status !== 'pending') return;
    const interval = setInterval(() => {
      fetchReservationStatus(reservation.id)
        .then(setReservation)
        .catch(() => {});
    }, STATUS_POLL_MS);
    return () => clearInterval(interval);
  }, [reservation]);

  async function handleSubmit() {
    if (!selectedTime || !customerName.trim() || !customerPhone.trim()) return;
    if (!isValidPhilippinePhone(customerPhone)) {
      toast(`Enter a valid Philippine phone number (${PH_PHONE_HINT})`, 'error');
      return;
    }
    setSubmitting(true);
    const advanceOrderItems =
      advanceOrderChoice === 'yes'
        ? Object.entries(advanceQuantities)
            .filter(([, qty]) => qty > 0)
            .map(([product_size_id, quantity]) => ({ product_size_id, quantity }))
        : [];
    try {
      const result = await submitReservation({
        party_size: partySize,
        reservation_date: date,
        start_time: `${selectedTime}:00`,
        customer_name: customerName.trim(),
        customer_phone: customerPhone.trim(),
        customer_note: customerNote.trim() || undefined,
        advance_order_items: advanceOrderItems.length > 0 ? advanceOrderItems : undefined,
      });
      setSubmittedHasAdvanceOrder(advanceOrderItems.length > 0);
      setReservation(result);
    } catch (e) {
      if (e instanceof QueuedOfflineError) {
        setSubmittedHasAdvanceOrder(advanceOrderItems.length > 0);
        setQueuedReservationId(e.queueId);
        toast(e.message, 'info');
        return;
      }
      toast(e instanceof Error ? e.message : 'Failed to submit reservation', 'error');
      // The slot may have just been taken by someone else -- refresh so the
      // grid reflects reality instead of showing a slot that's actually gone.
      fetchReservationAvailability(date, partySize)
        .then((res) => {
          setSlots(res.slots);
          setClosed(res.closed);
        })
        .catch(() => {});
      setSelectedTime(null);
    } finally {
      setSubmitting(false);
    }
  }

  function resetForm() {
    setReservation(null);
    setSelectedTime(null);
    setCustomerName('');
    setCustomerPhone('');
    setCustomerNote('');
    setAdvanceOrderChoice('ask');
    setAdvanceQuantities({});
  }

  function setAdvanceQty(sizeId: string, qty: number) {
    setAdvanceQuantities((prev) => ({ ...prev, [sizeId]: Math.max(0, qty) }));
  }

  const advanceOrderCount = Object.values(advanceQuantities).reduce((sum, q) => sum + q, 0);

  if (queuedReservationId) {
    return <QueuedSubmissionView label="reservation" />;
  }

  if (reservation) {
    const statusLabel =
      reservation.status === 'pending'
        ? 'PENDING'
        : reservation.status === 'confirmed'
          ? 'CONFIRMED'
          : reservation.status === 'declined'
            ? 'DECLINED'
            : 'CANCELLED';
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="item-modal" style={{ position: 'static', maxWidth: 420 }}>
          <div className="modal-body">
            <p className="eyebrow ink-eyebrow">RESERVATION · 予約</p>
            <h2>
              Request <em>#{reservation.reservation_number}</em>
            </h2>
            <div className="order-receipt">
              <div className="receipt-top">
                <div>
                  <p className="eyebrow">
                    PARTY OF {reservation.party_size} · {reservation.reservation_date} · {formatTime12h(reservation.start_time)}
                  </p>
                  <h3>
                    {reservation.status === 'pending' && 'Waiting for staff to confirm'}
                    {reservation.status === 'confirmed' && "You're all set"}
                    {reservation.status === 'declined' && 'This request was declined'}
                    {reservation.status === 'cancelled' && 'This reservation was cancelled'}
                  </h3>
                </div>
                <span className="receipt-status">{statusLabel}</span>
              </div>

              {reservation.status === 'pending' && (
                <p className="review-confirmation">Sit tight -- staff are reviewing your request. This updates automatically.</p>
              )}
              {reservation.status === 'confirmed' && (
                <p className="review-confirmation">
                  We'll see you then! Please arrive on time to hold your table.
                  {submittedHasAdvanceOrder &&
                    ' Your advance order will be prepared ahead of your arrival.'}
                </p>
              )}
              {(reservation.status === 'declined' || reservation.status === 'cancelled') && (
                <>
                  <p className="review-confirmation" style={{ color: '#a51f26' }}>
                    {reservation.declined_reason || 'Please contact the restaurant for help.'}
                  </p>
                  <button className="primary-button" type="button" style={{ marginTop: 12 }} onClick={resetForm}>
                    Book another table <ArrowRight size={16} />
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="item-modal" style={{ position: 'static', maxWidth: 460 }}>
        <div className="modal-body">
          <button
            type="button"
            onClick={onBack}
            style={{ display: 'flex', alignItems: 'center', gap: 4, background: 'none', border: 0, color: '#918378', fontSize: 12, marginBottom: 10, padding: 0 }}
          >
            <ChevronLeft size={14} /> Back
          </button>
          <p className="eyebrow ink-eyebrow">RESERVE A TABLE · 予約</p>
          <h2>Book your table</h2>

          <p style={{ margin: '4px 0 14px', fontSize: 12, color: '#918378', fontWeight: 700, letterSpacing: '.04em' }}>PARTY SIZE</p>
          <div className="quantity" style={{ marginBottom: 16 }}>
            <button type="button" onClick={() => setPartySize((n) => Math.max(1, n - 1))} aria-label="Decrease party size">
              <Minus size={14} />
            </button>
            <span>{partySize}</span>
            <button type="button" onClick={() => setPartySize((n) => n + 1)} aria-label="Increase party size">
              <Plus size={14} />
            </button>
          </div>

          <p style={{ margin: '0 0 8px', fontSize: 12, color: '#918378', fontWeight: 700, letterSpacing: '.04em' }}>DATE</p>
          <input
            type="date"
            className="input"
            style={{ marginBottom: 16 }}
            min={todayIso()}
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />

          <p style={{ margin: '0 0 8px', fontSize: 12, color: '#918378', fontWeight: 700, letterSpacing: '.04em' }}>TIME</p>
          {loadingSlots ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#918378', fontSize: 13, padding: '8px 0' }}>
              <Loader2 size={16} className="animate-spin" /> Checking availability...
            </div>
          ) : closed ? (
            <p style={{ fontSize: 13, color: '#a51f26', margin: '4px 0 16px' }}>We're closed on this day -- please pick another date.</p>
          ) : slots.length === 0 ? (
            <p style={{ fontSize: 13, color: '#918378', margin: '4px 0 16px' }}>No slots for this date.</p>
          ) : (
            <div
              style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(76px, 1fr))', gap: 8, marginBottom: 16 }}
            >
              {slots.map((slot) => (
                <button
                  key={slot.time}
                  type="button"
                  disabled={!slot.available}
                  className={`payment-option ${selectedTime === slot.time ? 'is-selected' : ''}`}
                  style={{ alignItems: 'center', padding: '9px 6px', opacity: slot.available ? 1 : 0.4 }}
                  onClick={() => setSelectedTime(slot.time)}
                >
                  <span style={{ fontSize: 13 }}>{formatTime12h(slot.time)}</span>
                  {!slot.available && <small>Full</small>}
                </button>
              ))}
            </div>
          )}

          {selectedTime && (
            <>
              <p style={{ margin: '0 0 8px', fontSize: 12, color: '#918378', fontWeight: 700, letterSpacing: '.04em' }}>YOUR DETAILS</p>
              <input
                className="input"
                style={{ marginBottom: 10 }}
                placeholder="Name"
                value={customerName}
                onChange={(e) => setCustomerName(e.target.value)}
              />
              <input
                className="input"
                style={{ marginBottom: 10 }}
                placeholder={`Phone number (${PH_PHONE_HINT})`}
                value={customerPhone}
                onChange={(e) => setCustomerPhone(e.target.value)}
              />
              <input
                className="input"
                style={{ marginBottom: 16 }}
                placeholder="Anything else? (optional)"
                value={customerNote}
                onChange={(e) => setCustomerNote(e.target.value)}
              />

              <p style={{ margin: '0 0 8px', fontSize: 12, color: '#918378', fontWeight: 700, letterSpacing: '.04em' }}>
                ADVANCE ORDER
              </p>
              {advanceOrderChoice === 'ask' ? (
                <div style={{ marginBottom: 16 }}>
                  <p style={{ fontSize: 13, color: '#5a5049', margin: '0 0 10px' }}>
                    Would you like to place an advance order for your reservation? We'll have it ready soon after
                    you arrive.
                  </p>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      type="button"
                      className="payment-option"
                      style={{ flex: 1 }}
                      onClick={() => setAdvanceOrderChoice('yes')}
                    >
                      Yes, add items
                    </button>
                    <button
                      type="button"
                      className="payment-option"
                      style={{ flex: 1 }}
                      onClick={() => setAdvanceOrderChoice('no')}
                    >
                      No, skip
                    </button>
                  </div>
                </div>
              ) : advanceOrderChoice === 'yes' ? (
                <div style={{ marginBottom: 16 }}>
                  {products.length === 0 ? (
                    <p style={{ fontSize: 13, color: '#918378' }}>Loading the menu…</p>
                  ) : (
                    <div style={{ maxHeight: 260, overflowY: 'auto', display: 'grid', gap: 8 }}>
                      {products
                        .filter((p) => p.active && !p.is_bundle)
                        .map((p) =>
                          p.sizes.map((s) => (
                            <div
                              key={s.id}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                gap: 8,
                                border: '1px solid #e7e0d8',
                                borderRadius: 8,
                                padding: '8px 10px',
                              }}
                            >
                              <div style={{ minWidth: 0 }}>
                                <p style={{ fontSize: 13, margin: 0 }}>
                                  {p.name}
                                  {p.sizes.length > 1 ? ` (${s.size_label})` : ''}
                                </p>
                                <p style={{ fontSize: 12, color: '#918378', margin: 0 }}>
                                  ₱{s.price.toFixed(2)}
                                </p>
                              </div>
                              <div className="quantity">
                                <button
                                  type="button"
                                  onClick={() => setAdvanceQty(s.id, (advanceQuantities[s.id] || 0) - 1)}
                                  aria-label={`Decrease ${p.name}`}
                                >
                                  <Minus size={14} />
                                </button>
                                <span>{advanceQuantities[s.id] || 0}</span>
                                <button
                                  type="button"
                                  onClick={() => setAdvanceQty(s.id, (advanceQuantities[s.id] || 0) + 1)}
                                  aria-label={`Increase ${p.name}`}
                                >
                                  <Plus size={14} />
                                </button>
                              </div>
                            </div>
                          ))
                        )}
                    </div>
                  )}
                  <button
                    type="button"
                    className="payment-option"
                    style={{ width: '100%', marginTop: 10 }}
                    onClick={() => setAdvanceOrderChoice('no')}
                  >
                    Skip advance order instead
                  </button>
                </div>
              ) : (
                <p style={{ fontSize: 13, color: '#918378', margin: '0 0 16px' }}>
                  No advance order.{' '}
                  <button
                    type="button"
                    style={{ background: 'none', border: 0, padding: 0, color: '#a51f26', fontSize: 13 }}
                    onClick={() => setAdvanceOrderChoice('ask')}
                  >
                    Add items instead
                  </button>
                </p>
              )}

              <button
                className="primary-button"
                type="button"
                style={{ width: '100%' }}
                disabled={!customerName.trim() || !isValidPhilippinePhone(customerPhone) || submitting}
                onClick={handleSubmit}
              >
                {submitting
                  ? 'Requesting...'
                  : advanceOrderChoice === 'yes' && advanceOrderCount > 0
                    ? `Request this table + ${advanceOrderCount} item${advanceOrderCount === 1 ? '' : 's'}`
                    : 'Request this table'}{' '}
                <ArrowRight size={16} />
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
