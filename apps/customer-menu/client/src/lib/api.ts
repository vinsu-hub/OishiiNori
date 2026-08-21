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

export type PaymentMethod = 'gcash' | 'cash';

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
  table_number: number;
  items: SubmitOrderItem[];
  addons?: SubmitOrderAddon[];
  payment_method: PaymentMethod;
  customer_note?: string;
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

export interface DigitalOrderStatus {
  id: string;
  order_number: number;
  table_number: number;
  status: 'pending' | 'approved' | 'rejected';
  subtotal: number;
  rejected_reason: string | null;
  items: DigitalOrderStatusItem[];
  addons: DigitalOrderStatusAddon[];
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
