// No login, no Supabase session on this device -- same situation as
// apps/staff-clock/client/src/lib/kiosk.ts, same fix: plain unauthenticated
// fetch() straight to the backend, no Authorization header at all. Safety
// is enforced server-side (see services/api-fastapi/app/routers/digital_menu.py).

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL as string;

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
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
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

export function submitOrder(payload: SubmitOrderPayload): Promise<DigitalOrderStatus> {
  return request('/public/orders', { method: 'POST', body: JSON.stringify(payload) });
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

export interface SubmitReservationPayload {
  party_size: number;
  reservation_date: string;
  start_time: string;
  customer_name: string;
  customer_phone: string;
  customer_note?: string;
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

export function submitReservation(payload: SubmitReservationPayload): Promise<ReservationStatus> {
  return request('/public/reservations', { method: 'POST', body: JSON.stringify(payload) });
}

export function fetchReservationStatus(id: string): Promise<ReservationStatus> {
  return request(`/public/reservations/${id}`);
}
