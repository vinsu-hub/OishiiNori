// No login, no Supabase session on this device -- same situation as
// apps/customer-menu/client/src/lib/api.ts and apps/staff-clock's kiosk.ts:
// plain unauthenticated fetch() straight to the backend, no Authorization
// header at all. Safety is enforced server-side.

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

// ---------------------------------------------------------------------------
// Business hours
// ---------------------------------------------------------------------------

export interface BusinessHours {
  open_time: string;
  close_time: string;
  closed_weekdays: number[];
}

export function fetchBusinessHours(): Promise<BusinessHours> {
  return request('/public/business-hours');
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
