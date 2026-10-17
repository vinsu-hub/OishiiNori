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
  readable: ReadableStream<Uint8Array> | null;
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

const CHUNK_BYTES = 512;
const CHUNK_PAUSE_MS = 60; // ~8 KB/s, below what Bluetooth SPP printers sustain
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** A Bluetooth link needs a moment after the last close, and the printer may be
 * waking up -- retry the connect a few times before calling it a failure. */
const OPEN_RETRY_WAITS_MS = [1500, 3000];
/** A ticket is ~30 KB at ~8 KB/s; anything far past that means the link died mid-job. */
const JOB_TIMEOUT_MS = 30_000;

/** What the kitchen should check when the printer can't be reached. */
export const PRINTER_UNREACHABLE =
  'Kitchen printer not reachable. Check it is ON with paper, close any other Kitchen Display tab, and make sure no other phone or tablet is connected to it.';

function friendly(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (/open|NetworkError|not found|disconnected|lost/i.test(message) || (error instanceof Error && error.name === 'NetworkError')) {
    return new Error(PRINTER_UNREACHABLE);
  }
  return error instanceof Error ? error : new Error(message);
}

async function openWithRetry(port: SerialPortLike): Promise<void> {
  // Left open by a job that died half-way: free it first.
  if (port.writable || port.readable) await port.close().catch(() => {});
  for (let attempt = 0; ; attempt++) {
    try {
      await port.open({ baudRate: 9600 });
      return;
    } catch (error) {
      if (error instanceof Error && error.name === 'InvalidStateError') {
        await port.close().catch(() => {});
      }
      if (attempt >= OPEN_RETRY_WAITS_MS.length) throw friendly(error);
      await sleep(OPEN_RETRY_WAITS_MS[attempt]);
    }
  }
}

function withTimeout<T>(work: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    work,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => { onTimeout(); reject(new Error(PRINTER_UNREACHABLE)); }, ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

let busy: Promise<void> = Promise.resolve();

/** Prints raw ESC/POS bytes on the saved printer. Jobs are queued one at a time. */
export function printViaSerial(bytes: Uint8Array): Promise<void> {
  const job = busy.then(async () => {
    const port = await getSavedSerialPrinter();
    if (!port) throw new Error('No printer connected on this tablet');
    await openWithRetry(port);
    let writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
    try {
      writer = port.writable!.getWriter();
      const w = writer;
      await withTimeout((async () => {
        // Paced chunks: a 58mm printer has a small buffer and a picture
        // ticket is ~30 KB. Dumping it in one write and closing the link
        // right away cut tickets off half-way.
        for (let i = 0; i < bytes.length; i += CHUNK_BYTES) {
          await w.ready;
          await w.write(bytes.subarray(i, i + CHUNK_BYTES));
          await sleep(CHUNK_PAUSE_MS);
        }
        await w.ready;
      })(), JOB_TIMEOUT_MS, () => { w.abort().catch(() => {}); });
      writer.releaseLock();
      writer = null;
      // Keep the link open until the printer has had time to take it all.
      await sleep(1500);
    } catch (error) {
      throw friendly(error);
    } finally {
      if (writer) {
        try { writer.releaseLock(); } catch { /* already released */ }
      }
      // Always free the printer, even after a failed job, or every later job fails to open it.
      await port.close().catch(() => {});
    }
  });
  busy = job.catch(() => {});
  return job;
}

/** Connects and disconnects without printing: is the printer reachable again? */
export function probeSerialPrinter(): Promise<boolean> {
  const job = busy.then(async () => {
    const port = await getSavedSerialPrinter();
    if (!port) return false;
    try {
      if (port.writable || port.readable) await port.close().catch(() => {});
      await port.open({ baudRate: 9600 });
      await port.close().catch(() => {});
      return true;
    } catch {
      return false;
    }
  });
  busy = job.then(() => {}, () => {});
  return job;
}
