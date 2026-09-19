// No login, no Supabase session on this device -- same situation as
// apps/staff-clock/client/src/lib/kiosk.ts, same fix: plain unauthenticated
// fetch() straight to the backend, no Authorization header at all. Safety
// is enforced server-side (see services/api-fastapi/app/routers/digital_menu.py).

import { enqueue, isNetworkError, registerExecutor } from './offlineQueue';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL as string;

// A customer's own cellular connection is the least reliable device in this
// whole system -- a merely *slow* (not dead) request used to just hang
// forever with no feedback and no way to ever queue/retry it. This turns
// "slow" into "detected": a request that hasn't resolved within this window
// aborts, which the offline-queue wiring below treats as a network failure
// (queue it) the same as an outright connection drop.
const REQUEST_TIMEOUT_MS = 10_000;

// Thrown by submitOrder()/submitReservation() in place of the raw network
// error when the submission is queued locally instead of failing outright.
// Callers catch this specifically to show a "we'll send this once you're
// back online" screen instead of a hard-fail toast, and use `queueId` to
// poll offlineQueue.getCompletion() for the eventual real result.
export class QueuedOfflineError extends Error {
  queueId: string;
  constructor(queueId: string) {
    super("You're offline -- this will be sent automatically once your connection is back");
    this.name = 'QueuedOfflineError';
    this.queueId = queueId;
  }
}

export interface ApiProductSize {
  id: string;
  product_id: string;
  size_label: string;
  price: number;
  scale_factor: number;
  sort_order: number;
  availability: 'available' | 'low_stock' | 'unavailable';
  total_pieces: number | null;
}

export interface ApiProduct {
  id: string;
  name: string;
  category: string;
  station: string;
  department: 'kitchen' | 'cafe';
  is_bundle: boolean;
  active: boolean;
  needs_station_review: boolean;
  image_path: string | null;
  sizes: ApiProductSize[];
}

export interface ApiRecipeItem {
  id: string;
  product_size_id: string;
  ingredient_id: string;
  ingredient_name: string;
  qty_per_serving: number;
  unit: string;
  prep_notes: string | null;
  needs_review: boolean;
}

export interface ApiAddon {
  id: string;
  name: string;
  price: number;
  active: boolean;
}

// Was a fixed 'gcash' | 'cash' union -- online payment methods are now
// admin-manageable (see ApiOnlinePaymentMethod/fetchPaymentMethods below),
// so this is just "cash" (the one hardcoded built-in) or whatever method
// name the customer picked from that live list.
export type PaymentMethod = string;

export interface ApiOnlinePaymentMethod {
  id: string;
  name: string;
  account_name: string;
  account_number: string;
  qr_code_url: string | null;
  active: boolean;
  sort_order: number;
}

export function fetchPaymentMethods(): Promise<ApiOnlinePaymentMethod[]> {
  return request('/payment-methods');
}

// WS-7 (Phase 6): the general (non-table) link submits Delivery/Pickup
// orders through this same endpoint -- table_number is only for the
// per-table QR flow now, and delivery/pickup carry name+phone (+address/
// barangay for an actual delivery, fee looked up server-side from
// barangay, never trusted from this client).
export type OrderChannel = 'dine_in_qr' | 'delivery' | 'pickup';

export interface SubmitOrderItem {
  product_size_id: string;
  quantity: number;
  held_ingredients?: string[];
}

export interface SubmitOrderAddon {
  addon_id: string;
  quantity: number;
}

export interface SubmitOrderPayload {
  table_number?: number;
  order_channel: OrderChannel;
  items: SubmitOrderItem[];
  addons?: SubmitOrderAddon[];
  payment_method: PaymentMethod;
  customer_note?: string;
  customer_name?: string;
  customer_phone?: string;
  address?: string;
  landmark?: string;
  barangay?: string;
  idempotency_key?: string;
  /** Advance order: ISO time the customer wants it (delivery/pickup only). */
  scheduled_for?: string;
}

export interface DeliveryFee {
  barangay: string;
  zone: string;
  fee: number;
}

export function fetchDeliveryFees(): Promise<DeliveryFee[]> {
  return request('/public/delivery-fees');
}

export interface BusinessDayStatus {
  business_date: string;
  is_open: boolean;
}

export function fetchBusinessDayStatus(): Promise<BusinessDayStatus> {
  return request('/public/business-day-status');
}

export interface DigitalOrderStatusItem {
  id: string;
  digital_order_id: string;
  product_size_id: string;
  quantity: number;
  unit_price: number;
  held_ingredients: string[];
}

export interface DigitalOrderStatusAddon {
  id: string;
  digital_order_id: string;
  addon_id: string;
  addon_name: string | null;
  quantity: number;
  unit_price: number;
}

export interface DigitalOrderStatusDelivery {
  customer_name: string;
  customer_phone: string;
  address: string | null;
  landmark: string | null;
  barangay: string | null;
  delivery_fee: number | null;
}

export interface DigitalOrderStatus {
  id: string;
  order_number: number;
  table_number: number | null;
  order_channel: OrderChannel;
  status: 'pending' | 'approved' | 'rejected';
  subtotal: number;
  rejected_reason: string | null;
  payment_proof_url?: string | null;
  items: DigitalOrderStatusItem[];
  addons: DigitalOrderStatusAddon[];
  delivery: DigitalOrderStatusDelivery | null;
  scheduled_for?: string | null;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      ...init,
    });
  } catch (err) {
    // An aborted (timed-out) request throws a DOMException named
    // "AbortError" -- normalize it to the same bare TypeError shape a real
    // connection failure throws, so isNetworkError() (and everything built
    // on it: retry, offline-queue) treats "hung too long" the same as
    // "never reached the server" -- both mean "this connection is bad."
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new TypeError('Request timed out');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    const errBody = await response.json().catch(() => null);
    throw new Error(errBody?.detail || `Request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

export function fetchMenu(): Promise<ApiProduct[]> {
  return request('/public/menu');
}

export function fetchAddons(): Promise<ApiAddon[]> {
  return request('/public/addons');
}

export function fetchRecipe(productSizeId: string): Promise<ApiRecipeItem[]> {
  return request(`/public/product-sizes/${productSizeId}/recipe`);
}

function _submitOrderRequest(payload: SubmitOrderPayload): Promise<DigitalOrderStatus> {
  return request('/public/orders', { method: 'POST', body: JSON.stringify(payload) });
}
registerExecutor('order', (payload) => _submitOrderRequest(payload as unknown as SubmitOrderPayload));

export async function submitOrder(payload: SubmitOrderPayload): Promise<DigitalOrderStatus> {
  // Generated once per submission attempt and reused for the offline-queue
  // replay of this same attempt, so a request that actually succeeded but
  // lost its response never creates a duplicate order (see
  // app/idempotency.py on the backend).
  const withKey: SubmitOrderPayload = { ...payload, idempotency_key: payload.idempotency_key ?? crypto.randomUUID() };
  try {
    return await _submitOrderRequest(withKey);
  } catch (err) {
    if (isNetworkError(err)) {
      const queueId = enqueue('order', withKey as unknown as Record<string, unknown>);
      throw new QueuedOfflineError(queueId);
    }
    throw err;
  }
}

export function fetchOrderStatus(orderId: string): Promise<DigitalOrderStatus> {
  return request(`/public/orders/${orderId}`);
}

// No session on this device (see file header) -- unlike dashboard-web's
// authenticated multipart uploads, this just POSTs the file with no
// Authorization header; the order's own unguessable id is the access
// control (see the matching backend endpoint's docstring).
export async function uploadProofOfPayment(orderId: string, file: File): Promise<DigitalOrderStatus> {
  const formData = new FormData();
  formData.append('file', file);
  const response = await fetch(`${API_BASE_URL}/public/orders/${orderId}/proof-of-payment`, {
    method: 'POST',
    body: formData,
  });
  if (!response.ok) {
    const errBody = await response.json().catch(() => null);
    throw new Error(errBody?.detail || `Request failed (${response.status})`);
  }
  return response.json() as Promise<DigitalOrderStatus>;
}

// ---------------------------------------------------------------------------
// Table reservations
// ---------------------------------------------------------------------------

export interface ReservationSlot {
  time: string;
  available: boolean;
}

export interface ReservationAvailability {
  date: string;
  party_size: number;
  closed: boolean;
  slots: ReservationSlot[];
}

export function fetchReservationAvailability(date: string, partySize: number): Promise<ReservationAvailability> {
  return request(`/public/tables/availability?date=${date}&party_size=${partySize}`);
}

export interface ReservationAdvanceOrderItem {
  product_size_id: string;
  quantity: number;
}

export interface SubmitReservationPayload {
  party_size: number;
  reservation_date: string;
  start_time: string;
  customer_name: string;
  customer_phone: string;
  customer_note?: string;
  advance_order_items?: ReservationAdvanceOrderItem[];
  idempotency_key?: string;
}

export interface ReservationStatus {
  id: string;
  reservation_number: number;
  party_size: number;
  reservation_date: string;
  start_time: string;
  end_time: string;
  status: 'pending' | 'confirmed' | 'declined' | 'cancelled';
  declined_reason: string | null;
}

function _submitReservationRequest(payload: SubmitReservationPayload): Promise<ReservationStatus> {
  return request('/public/reservations', { method: 'POST', body: JSON.stringify(payload) });
}
registerExecutor('reservation', (payload) => _submitReservationRequest(payload as unknown as SubmitReservationPayload));

export async function submitReservation(payload: SubmitReservationPayload): Promise<ReservationStatus> {
  const withKey: SubmitReservationPayload = {
    ...payload,
    idempotency_key: payload.idempotency_key ?? crypto.randomUUID(),
  };
  try {
    return await _submitReservationRequest(withKey);
  } catch (err) {
    if (isNetworkError(err)) {
      const queueId = enqueue('reservation', withKey as unknown as Record<string, unknown>);
      throw new QueuedOfflineError(queueId);
    }
    throw err;
  }
}

export function fetchReservationStatus(id: string): Promise<ReservationStatus> {
  return request(`/public/reservations/${id}`);
}
