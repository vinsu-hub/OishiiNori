/** Per-device printer settings. Each tablet has its own printer, so these
 * live in this browser's localStorage rather than on the server -- a
 * manager opening Kitchen Display on a phone must never start printing. */

export type ReceiptMode = 'browser' | 'rawbt';

const RECEIPT_MODE_KEY = 'oishii.printer.receiptMode';
const KITCHEN_PRINT_KEY = 'oishii.printer.kitchenPrintOnAccept';

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private mode / blocked storage -- the setting just won't persist.
  }
}

export function getReceiptMode(): ReceiptMode {
  return read(RECEIPT_MODE_KEY) === 'rawbt' ? 'rawbt' : 'browser';
}

export function setReceiptMode(mode: ReceiptMode): void {
  write(RECEIPT_MODE_KEY, mode);
}

export function getKitchenPrintOnAccept(): boolean {
  return read(KITCHEN_PRINT_KEY) === '1';
}

export function setKitchenPrintOnAccept(on: boolean): void {
  write(KITCHEN_PRINT_KEY, on ? '1' : '0');
}
