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

/** Kitchen ticket bytes. Prints as a picture (raster) so the big text comes
 * out the same on any printer -- many 58mm units and RawBT set-ups ignore
 * the ESC/POS "double size" commands, which left tickets in small print.
 * Falls back to text commands where there's no canvas (tests, Node). */
export function kitchenTicketEscpos(order: TicketOrder, index: TicketProductIndex, width = PAPER_WIDTH_CHARS): Uint8Array {
  const raster = typeof document !== 'undefined' ? kitchenTicketRaster(order, index) : null;
  return raster ?? kitchenTicketTextCommands(order, index, width);
}

/** Text-command version (double width/height via GS !). */
export function kitchenTicketTextCommands(order: TicketOrder, index: TicketProductIndex, width = PAPER_WIDTH_CHARS): Uint8Array {
  const divider = '-'.repeat(width);
  const wide = Math.floor(width / 2);
  const header = buildTicketHeader(order, wide);
  const time = header.pop() ?? '';
  const p = new EscPos().align('center').bold(true).size('large');
  for (const line of header) p.line(line.trim());
  p.size('tall').line(time.trim());
  p.align('left').bold(false).size('normal').line(divider);
  for (const item of order.items) {
    const { head } = buildItemLines(item, index, wide);
    const { sub } = buildItemLines(item, index, width);
    p.bold(true).size('large');
    for (const line of head) p.line(line);
    p.size('tall');
    for (const line of sub) p.line(line);
    p.size('normal').bold(false).feed(1);
  }
  return p.line(divider).cut().build();
}

// ---- Raster (picture) ticket -------------------------------------------
const DOTS = 384; // 58mm paper at 203 dpi
const PAD = 6;
const FONT = '"Arial Black", "Roboto", "Helvetica Neue", Arial, sans-serif';

type Run = { text: string; size: number; weight: string; align: 'left' | 'center'; indent?: number; gapAfter?: number };

function wrapToWidth(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (ctx.measureText(next).width <= maxWidth || !cur) {
      cur = next;
    } else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  // Break any single word that is still too wide.
  return lines.flatMap((line) => {
    if (ctx.measureText(line).width <= maxWidth) return [line];
    const parts: string[] = [];
    let chunk = '';
    for (const ch of line) {
      if (ctx.measureText(chunk + ch).width > maxWidth && chunk) {
        parts.push(chunk);
        chunk = ch;
      } else chunk += ch;
    }
    if (chunk) parts.push(chunk);
    return parts;
  });
}

function ticketRuns(order: TicketOrder, index: TicketProductIndex): Run[] {
  const runs: Run[] = [];
  const orderType = order.order_type || 'takeout';
  runs.push({ text: `ORDER #${order.order_number ?? order.id.slice(0, 8)}`, size: 44, weight: '900', align: 'center' });
  runs.push({
    text: orderType === 'dine_in' && order.table_number != null ? `TABLE ${order.table_number}` : ORDER_TYPE_LABEL[orderType] ?? orderType.toUpperCase(),
    size: 46,
    weight: '900',
    align: 'center',
  });
  const d = order.delivery;
  if (d) {
    runs.push({ text: d.customer_name ?? '', size: 28, weight: '700', align: 'center' });
    if (d.customer_phone) runs.push({ text: d.customer_phone, size: 26, weight: '700', align: 'center' });
    const address = d.landmark ? `${d.address ?? ''} (${d.landmark})` : d.address ?? '';
    if (address) runs.push({ text: address, size: 24, weight: '700', align: 'center' });
  }
  runs.push({ text: phTime12h(order.opened_at), size: 28, weight: '700', align: 'center', gapAfter: 6 });
  runs.push({ text: '---', size: 0, weight: '700', align: 'left' }); // divider marker
  for (const item of order.items) {
    const resolved = index.get(item.product_size_id);
    const name = resolved ? `${resolved.name} (${resolved.sizeLabel})` : 'Item';
    runs.push({ text: `${Number(item.quantity)}x ${name}`, size: 40, weight: '900', align: 'left' });
    for (const held of item.held_ingredients ?? []) runs.push({ text: `NO ${held}`, size: 34, weight: '900', align: 'left', indent: 18 });
    for (const addon of item.addons ?? []) {
      const qty = addon.quantity ?? 1;
      runs.push({ text: `+ ${addon.addon_name || 'Add-on'}${qty > 1 ? ` x${qty}` : ''}`, size: 32, weight: '800', align: 'left', indent: 18 });
    }
    runs[runs.length - 1].gapAfter = 16;
  }
  runs.push({ text: '---', size: 0, weight: '700', align: 'left' });
  return runs;
}

export function kitchenTicketRaster(order: TicketOrder, index: TicketProductIndex): Uint8Array | null {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  // Lay out first to know the height.
  type Placed = { text: string; font: string; x: number; y: number; align: 'left' | 'center'; divider?: boolean; strike?: boolean };
  const placed: Placed[] = [];
  let y = PAD;
  for (const run of ticketRuns(order, index)) {
    if (run.text === '---' && run.size === 0) {
      placed.push({ text: '', font: '', x: 0, y: y + 6, align: 'left', divider: true });
      y += 18;
      continue;
    }
    const font = `${run.weight} ${run.size}px ${FONT}`;
    ctx.font = font;
    const indent = run.indent ?? 0;
    for (const line of wrapToWidth(ctx, run.text, DOTS - 2 * PAD - indent)) {
      const lineH = Math.round(run.size * 1.18);
      placed.push({ text: line, font, x: run.align === 'center' ? DOTS / 2 : PAD + indent, y: y + run.size, align: run.align, strike: line.startsWith('NO ') });
      y += lineH;
    }
    y += run.gapAfter ?? 2;
  }
  const height = y + PAD;

  canvas.width = DOTS;
  canvas.height = height;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, DOTS, height);
  ctx.fillStyle = '#000';
  ctx.textBaseline = 'alphabetic';
  for (const p of placed) {
    if (p.divider) {
      ctx.fillRect(PAD, p.y, DOTS - 2 * PAD, 4);
      continue;
    }
    ctx.font = p.font;
    ctx.textAlign = p.align;
    if (p.strike) {
      // Held ingredient: white text on a black bar so "NO ..." can't be missed.
      const size = parseInt(p.font.split(' ')[1], 10);
      const w = ctx.measureText(p.text).width;
      ctx.fillRect(p.x - 6, p.y - size, w + 12, Math.round(size * 1.15));
      ctx.fillStyle = '#fff';
      ctx.fillText(p.text, p.x, p.y);
      ctx.fillStyle = '#000';
    } else {
      ctx.fillText(p.text, p.x, p.y);
    }
  }

  // 1-bit pack, then GS v 0 in bands (some printers have small buffers).
  const pixels = ctx.getImageData(0, 0, DOTS, height).data;
  const rowBytes = DOTS / 8;
  const out: number[] = [0x1b, 0x40, 0x1b, 0x61, 0x00];
  const BAND = 120;
  for (let top = 0; top < height; top += BAND) {
    const rows = Math.min(BAND, height - top);
    out.push(0x1d, 0x76, 0x30, 0x00, rowBytes & 0xff, rowBytes >> 8, rows & 0xff, rows >> 8);
    for (let r = top; r < top + rows; r++) {
      for (let bx = 0; bx < rowBytes; bx++) {
        let byte = 0;
        for (let bit = 0; bit < 8; bit++) {
          const i = (r * DOTS + bx * 8 + bit) * 4;
          const lum = pixels[i] * 0.299 + pixels[i + 1] * 0.587 + pixels[i + 2] * 0.114;
          if (lum < 140) byte |= 0x80 >> bit;
        }
        out.push(byte);
      }
    }
  }
  out.push(0x0a, 0x0a, 0x0a, 0x0a, 0x1d, 0x56, 0x01); // feed past tear bar, cut
  return Uint8Array.from(out);
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
