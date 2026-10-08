/** Direct Bluetooth printing from Chrome via Web Serial (Bluetooth RFCOMM).
 *
 * Chrome on Android supports Web Serial over Bluetooth Classic (SPP), which
 * is how the XP-58H talks. After a one-time tap to pick the printer
 * (requestPort), Chrome remembers the permission: getPorts() returns it on
 * every later visit with no tap, and writes need no user gesture -- so the
 * kitchen tablet can print new orders by itself, with no RawBT app switch.
 *
 * The port is opened per job and closed right after, so the printer is never
 * held open (an SPP printer accepts one connection at a time). */

const SPP_UUID = '00001101-0000-1000-8000-00805f9b34fb';

// Web Serial isn't in every TS DOM lib version -- keep the types local.
interface SerialPortLike {
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  writable: WritableStream<Uint8Array> | null;
  getInfo?(): { bluetoothServiceClassId?: string };
}
interface SerialLike {
  getPorts(): Promise<SerialPortLike[]>;
  requestPort(options?: { allowedBluetoothServiceClassIds?: string[]; filters?: { bluetoothServiceClassId: string }[] }): Promise<SerialPortLike>;
}

function serial(): SerialLike | null {
  const s = (navigator as Navigator & { serial?: SerialLike }).serial;
  return s ?? null;
}

export function serialPrintingSupported(): boolean {
  return typeof navigator !== 'undefined' && serial() !== null;
}

/** The printer chosen on this tablet before, if Chrome still has permission. */
export async function getSavedSerialPrinter(): Promise<SerialPortLike | null> {
  const s = serial();
  if (!s) return null;
  try {
    const ports = await s.getPorts();
    return ports[0] ?? null;
  } catch {
    return null;
  }
}

/** One-time setup: must be called from a tap. Shows Chrome's printer picker. */
export async function chooseSerialPrinter(): Promise<SerialPortLike> {
  const s = serial();
  if (!s) throw new Error('This browser cannot connect to a Bluetooth printer directly. Update Google Chrome.');
  // No filter: list every paired Bluetooth device. A strict SPP-UUID filter
  // hid XPrinter models whose service record Android hadn't cached yet
  // ("No compatible devices found"). allowedBluetoothServiceClassIds still
  // lets Chrome open the standard serial (SPP) channel on the chosen printer.
  return s.requestPort({ allowedBluetoothServiceClassIds: [SPP_UUID] });
}

let busy: Promise<void> = Promise.resolve();

/** Prints raw ESC/POS bytes on the saved printer. Jobs are queued one at a time. */
export function printViaSerial(bytes: Uint8Array): Promise<void> {
  const job = busy.then(async () => {
    const port = await getSavedSerialPrinter();
    if (!port) throw new Error('No printer connected on this tablet');
    await port.open({ baudRate: 9600 });
    try {
      const writer = port.writable!.getWriter();
      try {
        await writer.write(bytes);
      } finally {
        writer.releaseLock();
      }
      // Let the printer finish receiving before the link closes.
      await new Promise((r) => setTimeout(r, 400));
    } finally {
      await port.close().catch(() => {});
    }
  });
  busy = job.catch(() => {});
  return job;
}
