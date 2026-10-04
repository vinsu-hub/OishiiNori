/** Kitchen prep ticket for the 58mm printer -- a port of
 * kitchen-print-bridge/ticket.py so a ticket printed from an Android
 * kitchen tablet (via RawBT) matches one printed by the Python bridge. */

import { EscPos, PAPER_WIDTH_CHARS, asciiSafe, center, wrapLine } from './escpos';

const ORDER_TYPE_LABEL: Record<string, string> = {
  dine_in: 'DINE IN',
  takeout: 'TAKEOUT',
  delivery: 'DELIVERY',
};

export interface TicketItem {
  product_size_id: string;
  quantity: number;
  held_ingredients?: string[] | null;
  addons?: { addon_name: string | null; quantity: number }[] | null;
}

export interface TicketOrder {
  id: string;
  order_number: number | null;
  order_type: string | null;
  table_number: number | null;
  opened_at: string;
  items: TicketItem[];
  delivery?: {
    customer_name: string;
    customer_phone: string;
    address: string | null;
    landmark: string | null;
  } | null;
}

/** product_size_id -> display name parts. */
export type TicketProductIndex = Map<string, { name: string; sizeLabel: string }>;

function phTime12h(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', {
    timeZone: 'Asia/Manila',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

export function buildTicketHeader(order: TicketOrder, width = PAPER_WIDTH_CHARS): string[] {
  const orderType = order.order_type || 'takeout';
  const lines = [center(`ORDER #${order.order_number ?? order.id.slice(0, 8)}`, width)];
  if (orderType === 'dine_in' && order.table_number != null) {
    lines.push(center(`TABLE ${order.table_number}`, width));
  } else {
    lines.push(center(ORDER_TYPE_LABEL[orderType] ?? orderType.toUpperCase(), width));
  }
  const d = order.delivery;
  if (d) {
    for (const w of wrapLine('', asciiSafe(d.customer_name ?? ''), width)) lines.push(center(w, width));
    if (d.customer_phone) {
      for (const w of wrapLine('', asciiSafe(d.customer_phone), width)) lines.push(center(w, width));
    }
    let address = d.address ?? '';
    if (d.landmark) address = `${address} (${d.landmark})`;
    lines.push(...wrapLine('', asciiSafe(address), width));
  }
  lines.push(center(phTime12h(order.opened_at), width));
  return lines;
}

export function buildItemLines(
  item: TicketItem,
  index: TicketProductIndex,
  width = PAPER_WIDTH_CHARS
): { head: string[]; sub: string[] } {
  const resolved = index.get(item.product_size_id);
  const name = resolved ? `${resolved.name} (${resolved.sizeLabel})` : 'Item';
  const head = wrapLine('', asciiSafe(`${Number(item.quantity)}x ${name}`), width);

  const sub: string[] = [];
  for (const held of item.held_ingredients ?? []) sub.push(...wrapLine('  - NO ', asciiSafe(held), width));
  for (const addon of item.addons ?? []) {
    const qty = addon.quantity ?? 1;
    const suffix = qty > 1 ? ` x${qty}` : '';
    sub.push(...wrapLine('  + ', asciiSafe(`${addon.addon_name || 'Add-on'}${suffix}`), width));
  }
  return { head, sub };
}

/** Plain-text version, for comparing against the Python bridge's preview. */
export function kitchenTicketText(order: TicketOrder, index: TicketProductIndex, width = PAPER_WIDTH_CHARS): string {
  const divider = '-'.repeat(width);
  const lines = [...buildTicketHeader(order, width), divider];
  for (const item of order.items) {
    const { head, sub } = buildItemLines(item, index, width);
    lines.push(...head, ...sub);
  }
  lines.push(divider);
  return lines.join('\n');
}

export function kitchenTicketEscpos(order: TicketOrder, index: TicketProductIndex, width = PAPER_WIDTH_CHARS): Uint8Array {
  const divider = '-'.repeat(width);
  const p = new EscPos().align('center').bold(true).size('tall');
  for (const line of buildTicketHeader(order, width)) p.line(line);
  p.align('left').bold(false).size('normal').line(divider);
  for (const item of order.items) {
    const { head, sub } = buildItemLines(item, index, width);
    p.bold(true);
    for (const line of head) p.line(line);
    p.bold(false);
    for (const line of sub) p.line(line);
  }
  return p.line(divider).cut().build();
}

/** Same sample order as kitchen-print-bridge's --test-print. */
export const SAMPLE_KITCHEN_ORDER: TicketOrder = {
  id: 'sample-0000',
  order_number: 1234,
  order_type: 'delivery',
  table_number: null,
  opened_at: new Date().toISOString(),
  delivery: {
    customer_name: 'Juan Dela Cruz',
    customer_phone: '0917 123 4567',
    address: '123 Rizal St, Purok 4, a very long address to test wrapping',
    landmark: 'near the chapel',
  },
  items: [
    { product_size_id: 'size-1', quantity: 2, held_ingredients: ['Wasabi'], addons: [{ addon_name: 'Extra nori', quantity: 1 }] },
    { product_size_id: 'size-2', quantity: 1, held_ingredients: [], addons: [] },
  ],
};

export const SAMPLE_KITCHEN_INDEX: TicketProductIndex = new Map([
  ['size-1', { name: 'California Maki', sizeLabel: 'Regular' }],
  ['size-2', { name: 'Iced Tea', sizeLabel: '16oz' }],
]);
