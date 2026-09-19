import React from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { formatCurrency, formatTimestamp12h } from '@/lib/utils';

export interface ReceiptLine {
  name: string;
  quantity: number;
  unitPrice: number;
  addons: { name: string; quantity: number; unitPrice: number }[];
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
  delivery: { customerName: string; phone: string; address: string | null; barangay: string | null } | null;
}

const ORDER_TYPE_LABEL: Record<string, string> = { dine_in: 'Dine-in', takeout: 'Takeout', delivery: 'Delivery' };

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function row(left: string, right: string, bold = false): string {
  return `<div class="row${bold ? ' b' : ''}"><span>${esc(left)}</span><span>${esc(right)}</span></div>`;
}

/** Self-contained 58mm receipt document, shared by the preview and the print iframe. */
export function receiptHtml(r: ReceiptData): string {
  const lines = r.lines
    .map((l) => {
      const addons = l.addons
        .map((a) => row(`  + ${a.quantity}x ${a.name}`, formatCurrency(a.unitPrice * a.quantity)))
        .join('');
      return row(`${l.quantity}x ${l.name}`, formatCurrency(l.unitPrice * l.quantity)) + addons;
    })
    .join('');
  const type = r.orderType ? ORDER_TYPE_LABEL[r.orderType] ?? r.orderType : '';
  return `<div class="receipt">
    <div class="c b big">OISHII NORI</div>
    <div class="c">Thank you!</div>
    <hr/>
    <div class="c">Your order number</div>
    <div class="c b ticket">${r.orderNumber != null ? `#${r.orderNumber}` : '--'}</div>
    <div class="c">${esc(type)}${r.tableNumber != null ? ` - Table ${r.tableNumber}` : ''}</div>
    <div class="c small">${esc(formatTimestamp12h(r.openedAt))}</div>
    <hr/>
    ${lines}
    <hr/>
    ${r.discountAmount > 0 ? row('Discount', `-${formatCurrency(r.discountAmount)}`) : ''}
    ${r.deliveryFee > 0 ? row('Delivery fee', formatCurrency(r.deliveryFee)) : ''}
    ${r.taxAmount > 0 ? row('Tax (incl.)', formatCurrency(r.taxAmount)) : ''}
    ${row('TOTAL', formatCurrency(r.totalAmount), true)}
    ${r.paymentMethod ? row('Paid via', r.paymentMethod.replace(/_/g, ' ')) : ''}
    ${
      r.delivery
        ? `<hr/><div class="small">Deliver to: ${esc(r.delivery.customerName)} ${esc(r.delivery.phone)}<br/>${esc(
            [r.delivery.address, r.delivery.barangay].filter(Boolean).join(', ')
          )}</div>`
        : ''
    }
    <hr/>
    <div class="c small">Please keep this ticket until your order is served.</div>
  </div>`;
}

const RECEIPT_CSS = `
  @page { size: 58mm auto; margin: 0; }
  body { margin: 0; font-family: 'Courier New', monospace; font-size: 12px; color: #000; }
  .receipt { width: 58mm; max-width: 100%; margin: 0 auto; padding: 3mm; font-family: 'Courier New', monospace; font-size: 12px; color: #000; }
  .receipt * { box-sizing: border-box; }
  .receipt .row { display: flex; justify-content: space-between; gap: 6px; }
  .receipt .row span:first-child { flex: 1; word-break: break-word; }
  .receipt .c { text-align: center; } .receipt .b { font-weight: 700; } .receipt .small { font-size: 10px; }
  .receipt .big { font-size: 16px; } .receipt .ticket { font-size: 30px; line-height: 1.2; margin: 2px 0; }
  .receipt hr { border: 0; border-top: 1px dashed #000; margin: 5px 0; }
`;

/** Prints through a hidden iframe: no popup for the browser to block, no app-wide print CSS. */
export function printReceipt(r: ReceiptData): void {
  const iframe = document.createElement('iframe');
  iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
  document.body.appendChild(iframe);
  const doc = iframe.contentDocument;
  if (!doc || !iframe.contentWindow) {
    iframe.remove();
    return;
  }
  doc.open();
  doc.write(`<!doctype html><html><head><title>Receipt</title><style>${RECEIPT_CSS}</style></head><body>${receiptHtml(r)}</body></html>`);
  doc.close();
  const win = iframe.contentWindow;
  win.onafterprint = () => iframe.remove();
  // Let layout settle before the print dialog snapshots the document.
  setTimeout(() => {
    win.focus();
    win.print();
    setTimeout(() => iframe.remove(), 60_000);
  }, 100);
}

export function ReceiptDialog({ receipt, onClose }: { receipt: ReceiptData | null; onClose: () => void }) {
  return (
    <Dialog open={receipt !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Sale complete</DialogTitle>
        </DialogHeader>
        {receipt && (
          <div className="max-h-[60vh] overflow-y-auto border rounded bg-white text-black">
            <style>{RECEIPT_CSS.replace(/@page[^}]*}/, '').replace(/body \{[^}]*\}/, '')}</style>
            <div dangerouslySetInnerHTML={{ __html: receiptHtml(receipt) }} />
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          <Button onClick={() => receipt && printReceipt(receipt)}>Print receipt</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
