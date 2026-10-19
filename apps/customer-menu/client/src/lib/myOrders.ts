// "Track my order": the customer's recent online orders on this device, so
// the landing card can reopen them after a reload or a closed tab. Storage
// can be blocked (private mode), so every access is best-effort; the
// ?order=<id> link and the number + phone lookup still work without it.

export interface MyOrder {
  id: string;
  order_number: number;
  created_at: string;
}

const KEY = 'customer-menu:my-orders';
const KEEP = 5;
const MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

export function loadMyOrders(): MyOrder[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '[]') as MyOrder[];
    const cutoff = Date.now() - MAX_AGE_MS;
    return Array.isArray(raw) ? raw.filter((o) => o?.id && Date.parse(o.created_at) >= cutoff) : [];
  } catch {
    return [];
  }
}

export function rememberMyOrder(order: { id: string; order_number: number }) {
  try {
    const existing = loadMyOrders().filter((o) => o.id !== order.id);
    const next = [{ id: order.id, order_number: order.order_number, created_at: new Date().toISOString() }, ...existing];
    localStorage.setItem(KEY, JSON.stringify(next.slice(0, KEEP)));
  } catch {
    // Storage blocked: the link in the address bar still works.
  }
}

/** Keeps ?order=<id> in the address bar so a reload or bookmark reopens it. */
export function setOrderInUrl(orderId: string | null) {
  try {
    const url = new URL(window.location.href);
    if (orderId) url.searchParams.set('order', orderId);
    else url.searchParams.delete('order');
    window.history.replaceState(null, '', url);
  } catch {
    // Ignore: tracking still works for this page view.
  }
}

export function orderIdFromUrl(): string | null {
  const id = new URLSearchParams(window.location.search).get('order');
  return id && /^[0-9a-f-]{36}$/i.test(id) ? id : null;
}
