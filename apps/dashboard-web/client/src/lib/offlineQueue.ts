// Minimal localStorage-backed offline queue for POS Terminal sale creation,
// ported from apps/staff-clock/client/src/lib/offlineQueue.ts. Simpler than
// that version: a queued sale has no dependent follow-up action that needs
// its real id (unlike a clock-in/clock-out pair), so there's no id-map.

export interface QueuedSale {
  queueId: string;
  payload: Record<string, unknown>;
  createdAt: number;
}

type Executor = (payload: Record<string, unknown>) => Promise<unknown>;

const QUEUE_KEY = 'pos:offline-queue';

let executor: Executor | null = null;

export function registerExecutor(fn: Executor) {
  executor = fn;
}

function readQueue(): QueuedSale[] {
  try {
    return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
  } catch {
    return [];
  }
}

function writeQueue(queue: QueuedSale[]) {
  localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
}

/** fetch() rejects with a network-level TypeError on connection failure --
 * distinct from a resolved 4xx/5xx response, which must surface immediately
 * rather than queue (e.g. insufficient stock should never silently queue). */
export function isNetworkError(err: unknown): boolean {
  return err instanceof TypeError;
}

type Listener = (length: number) => void;
const listeners = new Set<Listener>();

/** Lets SyncContext react to queue-length changes without polling --
 * staff-clock has no equivalent because it surfaces queueing via a one-off
 * toast, not a persistent header badge. */
export function onQueueChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notifyListeners() {
  const length = queueLength();
  listeners.forEach((fn) => fn(length));
}

export function enqueue(payload: Record<string, unknown>): string {
  const queue = readQueue();
  const queueId = crypto.randomUUID();
  queue.push({ queueId, payload, createdAt: Date.now() });
  writeQueue(queue);
  notifyListeners();
  return queueId;
}

export function queueLength(): number {
  return readQueue().length;
}

let flushing = false;

export async function flushQueue(): Promise<void> {
  // Reentrancy guard: flaky WiFi can fire the browser's 'online' event
  // multiple times in quick succession during a reconnect. Without this,
  // two overlapping calls can both read the same queue snapshot before
  // either clears it, replaying the same sale twice against the backend.
  if (flushing) return;
  flushing = true;
  try {
    await doFlush();
  } finally {
    flushing = false;
  }
}

async function doFlush(): Promise<void> {
  if (!executor) return;
  const queue = readQueue();
  if (queue.length === 0) return;

  const remaining: QueuedSale[] = [];
  for (let i = 0; i < queue.length; i++) {
    const action = queue[i];
    try {
      await executor(action.payload);
    } catch (err) {
      if (isNetworkError(err)) {
        // Still offline -- stop here, preserve remaining order for next flush.
        remaining.push(action, ...queue.slice(i + 1));
        break;
      }
      // A real business-logic rejection on replay (e.g. a discount type
      // deactivated while offline) -- drop this one sale rather than
      // blocking the rest of the queue forever. Matches staff-clock's own
      // equivalent behavior.
      continue;
    }
  }

  writeQueue(remaining);
  notifyListeners();
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
