import React, { useRef } from 'react';
import { Printer } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import type { ApiBusinessSettings } from '@/lib/api';
import { formatCurrency } from '@/lib/utils';
import {
  asciiSafe,
  center,
  EscPos,
  PAPER_WIDTH_CHARS,
  columns,
  wrapLine,
} from '@/lib/escpos';
import { sendToRawBT } from '@/lib/rawbt';
import { getReceiptMode, KITCHEN_RECEIPT_BLOCKED_MESSAGE, printReceiptAllowed } from '@/lib/printerPrefs';
import { useAuth } from '@/contexts/AuthContext';

export interface ReceiptLine {
  name: string;
  quantity: number;
  unitPrice: number;
  addons: { name: string; quantity: number; unitPrice: number }[];
}
export interface ReceiptBusiness {
  name: string | null;
  address: string | null;
  phone: string | null;
  tin: string | null;
  footer: string | null;
}
/** Settings -> Receipt details, with blank fields as null (not printed). */
export function receiptBusinessFromSettings(settings: ApiBusinessSettings): ReceiptBusiness {
  const value = (v: string | null | undefined) => v?.trim() || null;
  return {
    name: value(settings.receipt_business_name),
    address: value(settings.receipt_address),
    phone: value(settings.receipt_phone),
    tin: value(settings.receipt_tin),
    footer: value(settings.receipt_footer),
  };
}

export interface ReceiptData {
  orderNumber: number | null;
  openedAt: string;
  orderType: string | null;
  tableNumber: number | null;
  lines: ReceiptLine[];
  discountAmount: number;
  taxAmount: number;
  deliveryFee: number;
  totalAmount: number;
  paymentMethod: string | null;
  delivery: {
    customerName: string;
    phone: string;
    address: string | null;
    barangay: string | null;
  } | null;
  business: ReceiptBusiness;
  cashierName: string | null;
  reference: string | null;
  subtotal: number;
  discountLabel: string | null;
  vatExempt: boolean;
  cashTendered: number | null;
  changeDue: number | null;
  itemCount: number;
  /** Pay on delivery: the rider collects the total from the customer. */
  payOnDelivery?: boolean;
}

const ORDER_TYPE_LABEL: Record<string, string> = {
  dine_in: 'Dine-in',
  takeout: 'Takeout',
  delivery: 'Delivery',
};

function esc(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ]!,
  );
}
function orderTypeLabel(r: ReceiptData): string {
  const type = r.orderType
    ? (ORDER_TYPE_LABEL[r.orderType] ?? r.orderType)
    : '';
  return r.orderType === 'dine_in' && r.tableNumber != null
    ? `${type} · Table ${r.tableNumber}`
    : type;
}
function paymentLabel(method: string): string {
  return method
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}
function timestamp(iso: string): string {
  return new Intl.DateTimeFormat('en-PH', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Manila',
  }).format(new Date(iso));
}
function deliveryAddress(d: NonNullable<ReceiptData['delivery']>): string {
  return [d.address, d.barangay].filter(Boolean).join(', ');
}
function row(left: string, right: string, bold = false): string {
  return `<div class="row${bold ? ' b' : ''}"><span>${esc(left)}</span><span>${esc(right)}</span></div>`;
}
function htmlText(className: string, text: string): string {
  return text ? `<div class="${className}">${esc(text)}</div>` : '';
}

/** Self-contained 58mm receipt document, shared by the preview and the print iframe. */
export function receiptHtml(r: ReceiptData): string {
  const name = r.business.name || 'OISHII NORI';
  const vatSales = r.totalAmount - r.taxAmount - r.deliveryFee;
  const items = r.lines
    .map((line) => {
      const addons = line.addons
        .map((addon) =>
          row(
            `  + ${addon.quantity}x ${addon.name}`,
            formatCurrency(addon.unitPrice * addon.quantity),
          ),
        )
        .join('');
      return (
        row(
          `${line.quantity}x ${line.name}`,
          formatCurrency(line.unitPrice * line.quantity),
        ) + addons
      );
    })
    .join('');
  return `<div class="receipt">
    <header class="header"><div class="c b brand">${esc(name)}</div>${htmlText('c small detail', r.business.phone || '')}${htmlText('c small detail', r.business.tin ? `TIN: ${r.business.tin}` : '')}<div class="c slip-title">ORDER SLIP</div></header>
    <hr/><section class="order-number c"><div class="eyebrow">YOUR ORDER NUMBER</div><div class="b ticket">${r.orderNumber != null ? `#${r.orderNumber}` : '--'}</div><div class="small">Watch the screen for your number</div><div class="small">Now Serving = ready for pick-up</div></section>
    <hr/><section class="meta small">${htmlText('meta-line', orderTypeLabel(r))}${htmlText('meta-line', timestamp(r.openedAt))}${htmlText('meta-line', r.cashierName ? `Cashier: ${r.cashierName}` : '')}${htmlText('meta-line', r.reference ? `Ref: ${r.reference}` : '')}</section>
    <hr/><section class="items">${items}${row('Items:', String(r.itemCount))}</section><hr/>
    <section class="totals">${row('Subtotal', formatCurrency(r.subtotal))}${r.discountAmount > 0 ? row(`Discount (${r.discountLabel || 'Discount'})`, `-${formatCurrency(r.discountAmount)}`) : ''}${r.deliveryFee > 0 ? row('Delivery fee', formatCurrency(r.deliveryFee)) : ''}${row('TOTAL', formatCurrency(r.totalAmount), true)}</section>
    ${r.taxAmount > 0 || r.vatExempt ? `<section class="vat small">${r.vatExempt ? row('VAT-exempt sales', formatCurrency(r.totalAmount - r.deliveryFee)) : row('VATable sales', formatCurrency(vatSales))}${!r.vatExempt && r.taxAmount > 0 ? row('VAT 12%', formatCurrency(r.taxAmount)) : ''}</section>` : ''}
    ${r.payOnDelivery ? `<hr/><section class="payment"><div class="c b">PAY ON DELIVERY</div>${row('Rider collects', formatCurrency(r.totalAmount), true)}</section>` : r.paymentMethod ? `<hr/><section class="payment">${row('Paid via', paymentLabel(r.paymentMethod))}${r.cashTendered != null ? row('Cash tendered', formatCurrency(r.cashTendered)) : ''}${r.cashTendered != null ? row('Change', formatCurrency(r.changeDue ?? 0)) : ''}</section>` : ''}
    ${r.delivery ? `<hr/><section class="delivery small"><div class="b">Deliver to:</div>${htmlText('delivery-line', r.delivery.customerName)}${htmlText('delivery-line', r.delivery.phone)}${htmlText('delivery-line', deliveryAddress(r.delivery))}</section>` : ''}
    <hr/><footer class="c small"><div class="b legal">THIS IS NOT AN OFFICIAL RECEIPT</div><div>Keep this slip until your order is served.</div></footer>
  </div>`;
}

const RECEIPT_CSS = `
  @page { size: 58mm auto; margin: 0; }
  body { width: 58mm; margin: 0; padding: 0; font-family: "Courier New", monospace; font-size: 12px; color: #000; }
  .receipt { box-sizing: border-box; width: 58mm; max-width: 100%; margin: 0 auto; padding: 3mm; font-family: "Courier New", monospace; font-size: 12px; line-height: 1.38; color: #000; }
  .receipt * { box-sizing: border-box; }.receipt .c { text-align: center; }.receipt .b { font-weight: 700; }.receipt .small { font-size: 10px; }
  .receipt .brand { font-size: 16px; letter-spacing: .06em; overflow-wrap: anywhere; }.receipt .detail, .receipt .meta-line, .receipt .delivery-line { overflow-wrap: anywhere; }
  .receipt .slip-title { margin-top: 4px; font-size: 13px; font-weight: 700; letter-spacing: .08em; }.receipt .eyebrow { font-size: 10px; font-weight: 700; letter-spacing: .08em; }
  .receipt .ticket { margin: 2px 0 4px; font-size: 36px; line-height: 1.05; letter-spacing: .02em; font-variant-numeric: tabular-nums; }
  .receipt .row { display: flex; align-items: flex-start; justify-content: space-between; gap: 6px; margin: 1px 0; }.receipt .row span:first-child { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }.receipt .row span:last-child { flex: 0 0 auto; text-align: right; font-variant-numeric: tabular-nums; }
  .receipt .totals .b { margin-top: 3px; font-size: 14px; }.receipt .vat { margin-top: 5px; }.receipt .legal { margin-top: 5px; font-size: 10px; }.receipt hr { border: 0; border-top: 1px dashed #000; margin: 6px 0; }
`;

function safeWrapped(prefix: string, text: string, width: number): string[] {
  return wrapLine(prefix, asciiSafe(text), width).flatMap((line) => {
    if (line.length <= width) return [line];
    const chunks: string[] = [];
    for (let start = 0; start < line.length; start += width)
      chunks.push(line.slice(start, start + width));
    return chunks;
  });
}

/** Same receipt as receiptHtml(), as raw ESC/POS for RawBT on an Android tablet. */
export function receiptEscpos(
  r: ReceiptData,
  width = PAPER_WIDTH_CHARS,
): Uint8Array {
  const p = new EscPos();
  const divider = '-'.repeat(width);
  const money = (amount: number) => asciiSafe(formatCurrency(amount));
  const textLines = (prefix: string, text: string) =>
    safeWrapped(prefix, text, width).forEach((line) => p.line(line));
  const centered = (text: string) =>
    safeWrapped('', text, width).forEach((line) => p.line(center(line, width)));
  const rows = (left: string, right: string) => {
    for (const line of columns(asciiSafe(left), asciiSafe(right), width)) {
      if (line.length <= width) p.line(line);
      else safeWrapped('', line, width).forEach((wrapped) => p.line(wrapped));
    }
  };
  const name = asciiSafe(r.business.name || 'OISHII NORI');
  const vatSales = r.totalAmount - r.taxAmount - r.deliveryFee;
  p.align('center').bold(true).size('tall');
  centered(name);
  p.size('normal').bold(false);
  if (r.business.phone) centered(r.business.phone);
  if (r.business.tin) centered(`TIN: ${r.business.tin}`);
  p.bold(true);
  centered('ORDER SLIP');
  p.bold(false).line(divider);
  centered('YOUR ORDER NUMBER');
  p.bold(true)
    .size('large')
    .line(r.orderNumber != null ? `#${r.orderNumber}` : '--')
    .size('normal')
    .bold(false);
  centered('Watch the screen for your number');
  centered('Now Serving = ready for pick-up');
  p.align('left').line(divider);
  if (orderTypeLabel(r)) textLines('', orderTypeLabel(r));
  textLines('', timestamp(r.openedAt));
  if (r.cashierName) textLines('Cashier: ', r.cashierName);
  if (r.reference) textLines('Ref: ', r.reference);
  p.line(divider);
  for (const line of r.lines) {
    rows(
      `${line.quantity}x ${line.name}`,
      money(line.unitPrice * line.quantity),
    );
    for (const addon of line.addons)
      rows(
        `  + ${addon.quantity}x ${addon.name}`,
        money(addon.unitPrice * addon.quantity),
      );
  }
  rows('Items:', String(r.itemCount));
  p.line(divider);
  rows('Subtotal', money(r.subtotal));
  if (r.discountAmount > 0)
    rows(
      `Discount (${r.discountLabel || 'Discount'})`,
      `-${money(r.discountAmount)}`,
    );
  if (r.deliveryFee > 0) rows('Delivery fee', money(r.deliveryFee));
  p.bold(true).size('tall');
  rows('TOTAL', money(r.totalAmount));
  p.size('normal').bold(false);
  if (r.taxAmount > 0 || r.vatExempt) {
    if (r.vatExempt)
      rows('VAT-exempt sales', money(r.totalAmount - r.deliveryFee));
    else rows('VATable sales', money(vatSales));
    if (!r.vatExempt && r.taxAmount > 0) rows('VAT 12%', money(r.taxAmount));
  }
  if (r.payOnDelivery) {
    p.line(divider).align('center').bold(true).size('tall');
    centered('PAY ON DELIVERY');
    p.size('normal');
    p.align('left');
    rows('Rider collects', money(r.totalAmount));
    p.bold(false);
  } else if (r.paymentMethod) {
    p.line(divider);
    rows('Paid via', paymentLabel(r.paymentMethod));
    if (r.cashTendered != null) {
      rows('Cash tendered', money(r.cashTendered));
      rows('Change', money(r.changeDue ?? 0));
    }
  }
  if (r.delivery) {
    p.line(divider).bold(true);
    textLines('', 'Deliver to:');
    p.bold(false);
    textLines('', r.delivery.customerName);
    textLines('', r.delivery.phone);
    const address = deliveryAddress(r.delivery);
    if (address) textLines('', address);
  }
  p.line(divider).align('center');
  p.bold(true);
  centered('THIS IS NOT AN OFFICIAL RECEIPT');
  p.bold(false);
  centered('Keep this slip until your order is served.');
  return p.cut().build();
}

export function printReceipt(r: ReceiptData, userRole?: string | null): void {
  // Tablet lock: the kitchen tablet's printer is the KITCHEN one.
  if (!printReceiptAllowed(userRole)) throw new Error(KITCHEN_RECEIPT_BLOCKED_MESSAGE);
  if (getReceiptMode() === 'rawbt') {
    sendToRawBT(receiptEscpos(r));
    return;
  }
  printReceiptViaBrowser(r);
}
function printReceiptViaBrowser(r: ReceiptData): void {
  const iframe = document.createElement('iframe');
  iframe.style.cssText =
    'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
  document.body.appendChild(iframe);
  const doc = iframe.contentDocument;
  if (!doc || !iframe.contentWindow) {
    iframe.remove();
    return;
  }
  doc.open();
  doc.write(
    `<!doctype html><html><head><title>Order slip</title><style>${RECEIPT_CSS}</style></head><body>${receiptHtml(r)}</body></html>`,
  );
  doc.close();
  const win = iframe.contentWindow;
  win.onafterprint = () => iframe.remove();
  setTimeout(() => {
    win.focus();
    win.print();
    setTimeout(() => iframe.remove(), 60_000);
  }, 100);
}

export function ReceiptDialog({
  receipt,
  onClose,
}: {
  receipt: ReceiptData | null;
  onClose: () => void;
}) {
  const printButtonRef = useRef<HTMLButtonElement>(null);
  const { user } = useAuth();
  const canPrint = printReceiptAllowed(user?.role);
  return (
    <Dialog open={receipt !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="max-h-[calc(100vh-2rem)] max-w-sm overflow-hidden p-4 sm:p-6"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          printButtonRef.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>
            Sale complete
            {receipt?.orderNumber != null
              ? ` · Order #${receipt.orderNumber}`
              : ''}
          </DialogTitle>
          <DialogDescription>
            Print the customer order slip, or close to begin the next order.
          </DialogDescription>
        </DialogHeader>
        {receipt && (
          <div
            className="mx-auto max-h-[58vh] w-full overflow-y-auto rounded-md border bg-white text-black shadow-inner"
            role="document"
            aria-label={`Order slip preview${receipt.orderNumber != null ? ` for order ${receipt.orderNumber}` : ''}`}
          >
            <style>
              {RECEIPT_CSS.replace(/@page[^}]*}/, '').replace(
                /body \{[^}]*\}/,
                '',
              )}
            </style>
            <div dangerouslySetInnerHTML={{ __html: receiptHtml(receipt) }} />
          </div>
        )}
        <DialogFooter className="pt-1 sm:grid sm:grid-cols-[auto_1fr]">
          <Button className="min-h-11" variant="outline" onClick={onClose}>
            Close
          </Button>
          {!canPrint ? (
            <p className="self-center text-sm font-medium text-destructive">
              {KITCHEN_RECEIPT_BLOCKED_MESSAGE}
            </p>
          ) : (
            <Button
              ref={printButtonRef}
              className="min-h-11 text-base"
              onClick={() => {
                if (!receipt) return;
                try {
                  printReceipt(receipt, user?.role);
                } catch (e) {
                  toast.error(
                    e instanceof Error ? e.message : 'Failed to print receipt',
                  );
                }
              }}
            >
              <Printer aria-hidden="true" />
              Print order slip
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
