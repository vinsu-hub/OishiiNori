/** Per-device printer settings. Each tablet has its own printer, so these
 * live in this browser's localStorage rather than on the server -- a
 * manager opening Kitchen Display on a phone must never start printing. */

export type ReceiptMode = 'browser' | 'rawbt';
/** What this physical device is for -- set once by a manager in Printer Setup. */
export type TabletRole = 'cashier' | 'kitchen' | 'other';

const RECEIPT_MODE_KEY = 'oishii.printer.receiptMode';
const KITCHEN_PRINT_KEY = 'oishii.printer.kitchenPrintOnAccept';
const TABLET_ROLE_KEY = 'oishii.device.tabletRole';

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

export function getTabletRole(): TabletRole {
  const v = read(TABLET_ROLE_KEY);
  return v === 'cashier' || v === 'kitchen' ? v : 'other';
}

export function setTabletRole(role: TabletRole): void {
  write(TABLET_ROLE_KEY, role);
}

/** Tablet lock: the kitchen tablet always prints tickets, the cashier tablet
 * never does -- so the two printers can't be mixed up by a stray toggle. */
export function getKitchenPrintOnAccept(): boolean {
  const role = getTabletRole();
  if (role === 'kitchen') return true;
  if (role === 'cashier') return false;
  return read(KITCHEN_PRINT_KEY) === '1';
}

/** Customer receipts never print from the kitchen tablet (its printer is the
 * KITCHEN one) or from a kitchen-role account. */
export function printReceiptAllowed(userRole?: string | null): boolean {
  return getTabletRole() !== 'kitchen' && userRole !== 'kitchen';
}

export const KITCHEN_RECEIPT_BLOCKED_MESSAGE = 'This is the kitchen tablet — customer receipts print at the cashier.';

export function setKitchenPrintOnAccept(on: boolean): void {
  write(KITCHEN_PRINT_KEY, on ? '1' : '0');
}
