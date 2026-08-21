// Minimal localStorage-backed offline queue for the kiosk, ported from the
// SMFC reference (apps/staff-clock/client/src/lib/offlineQueue.ts).
//
// Each queued action carries a client-generated `localId` so a clock-out
// queued in the same offline visit as its clock-in can reference the
// clock-in before a real attendance_log_id exists. On flush, clock-in
// resolves to a real id first; the dependent clock-out looks up that
// mapping before replaying. Oishii Nori's kiosk.py has no break endpoints
// (unlike SMFC's), so this only ever queues clock-in/clock-out.

export type QueuedActionType = 'clock-in' | 'clock-out';

export interface QueuedAction {
  queueId: string;
  type: QueuedActionType;
  payload: Record<string, unknown>;
  createdAt: number;
}

type Executor = (payload: Record<string, unknown>) => Promise<{ id: string } & Record<string, unknown>>;

const QUEUE_KEY = 'staff-clock:offline-queue';
const ID_MAP_KEY = 'staff-clock:offline-id-map';

const executors: Partial<Record<QueuedActionType, Executor>> = {};

export function registerExecutor(type: QueuedActionType, fn: Executor) {
  executors[type] = fn;
}

function readQueue(): QueuedAction[] {
  try {
    return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
  } catch {
    return [];
  }
}

function writeQueue(queue: QueuedAction[]) {
  localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
}

function readIdMap(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(ID_MAP_KEY) || '{}');
  } catch {
    return {};
  }
}

function writeIdMap(map: Record<string, string>) {
  localStorage.setItem(ID_MAP_KEY, JSON.stringify(map));
}

export function resolveId(localId: string): string {
  return readIdMap()[localId] || localId;
}

/** fetch() rejects with a network-level TypeError on connection failure —
 * distinct from a resolved 4xx/5xx response, which must surface immediately
 * rather than queue (e.g. a wrong PIN should never silently queue). */
export function isNetworkError(err: unknown): boolean {
  return err instanceof TypeError;
}

export function enqueue(type: QueuedActionType, payload: Record<string, unknown>): string {
  const queue = readQueue();
  const queueId = crypto.randomUUID();
  queue.push({ queueId, type, payload, createdAt: Date.now() });
  writeQueue(queue);
  return queueId;
}

export function queueLength(): number {
  return readQueue().length;
}

let flushing = false;

export async function flushQueue(): Promise<void> {
  // Reentrancy guard: flaky kiosk WiFi can fire the browser's 'online' event
  // multiple times in quick succession during a reconnect. Without this,
  // two overlapping calls can both read the same queue snapshot before
  // either clears it, replaying the same action twice against the backend.
  if (flushing) return;
  flushing = true;
  try {
    await doFlush();
  } finally {
    flushing = false;
  }
}

async function doFlush(): Promise<void> {
  const queue = readQueue();
  if (queue.length === 0) return;

  const idMap = readIdMap();
  const remaining: QueuedAction[] = [];

  for (let i = 0; i < queue.length; i++) {
    const action = queue[i];
    const executor = executors[action.type];
    if (!executor) {
      remaining.push(action, ...queue.slice(i + 1));
      break;
    }

    const payload = { ...action.payload };
    if (typeof payload.attendance_log_id === 'string') {
      payload.attendance_log_id = idMap[payload.attendance_log_id] ?? payload.attendance_log_id;
    }

    try {
      const result = await executor(payload);
      if (action.type === 'clock-in' && typeof payload.localId === 'string') {
        idMap[payload.localId] = result.id;
        writeIdMap(idMap);
      }
    } catch (err) {
      if (isNetworkError(err)) {
        // Still offline — stop here, preserve remaining order for next flush.
        remaining.push(action, ...queue.slice(i + 1));
        break;
      }
      // A real business-logic rejection (e.g. already completed today) on
      // replay — drop this one action rather than blocking the rest forever.
      continue;
    }
  }

  writeQueue(remaining);
}

let listenerAttached = false;

export function initOfflineQueue() {
  if (listenerAttached) return;
  listenerAttached = true;
  window.addEventListener('online', () => {
    flushQueue();
  });
  flushQueue();
}
