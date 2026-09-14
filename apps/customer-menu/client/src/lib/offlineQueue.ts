// Minimal localStorage-backed offline queue for order/reservation
// submission on a customer's own phone -- the single most realistic "bad
// connection" device in this whole system (their own cellular data, not a
// staff terminal on the restaurant's WiFi). Mirrors
// apps/staff-clock/client/src/lib/offlineQueue.ts's typed multi-action
// shape (this app also has two distinct action types, order and
// reservation) plus apps/dashboard-web's onQueueChange listener --needed
// here to drive a "queued, waiting to send" screen instead of a one-off
// toast, since a customer has no other page to come back and check.

export type QueuedActionType = 'order' | 'reservation';

export interface QueuedAction {
  queueId: string;
  type: QueuedActionType;
  payload: Record<string, unknown>;
  createdAt: number;
}

type Executor = (payload: Record<string, unknown>) => Promise<unknown>;

const QUEUE_KEY = 'customer-menu:offline-queue';
// Result (or error) of a queued action once it's actually replayed, keyed
// by queueId -- the UI polls this to know when to leave the "queued" screen
// and switch to the normal receipt/confirmation view, since the page has no
// other way to learn a background flush finished.
const COMPLETIONS_KEY = 'customer-menu:offline-completions';

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
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  } catch {
    /* private mode / storage disabled -- queued action just won't survive
       a reload in that case, not worth surfacing an error over. */
  }
}

function readCompletions(): Record<string, unknown> {
  try {
    return JSON.parse(localStorage.getItem(COMPLETIONS_KEY) || '{}');
  } catch {
    return {};
  }
}

function writeCompletions(completions: Record<string, unknown>) {
  try {
    localStorage.setItem(COMPLETIONS_KEY, JSON.stringify(completions));
  } catch {
    /* private mode / storage disabled */
  }
}

/** fetch() rejects with a network-level TypeError on connection failure --
 * distinct from a resolved 4xx/5xx response, which must surface immediately
 * rather than queue (a slot just taken, or an item just out of stock, must
 * never silently queue and retry later against a now-stale request). */
export function isNetworkError(err: unknown): boolean {
  return err instanceof TypeError;
}

type Listener = () => void;
const listeners = new Set<Listener>();

export function onQueueChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notifyListeners() {
  listeners.forEach((fn) => fn());
}

export function enqueue(type: QueuedActionType, payload: Record<string, unknown>): string {
  const queue = readQueue();
  const queueId = crypto.randomUUID();
  queue.push({ queueId, type, payload, createdAt: Date.now() });
  writeQueue(queue);
  notifyListeners();
  return queueId;
}

export function queueLength(): number {
  return readQueue().length;
}

/** The real result once a queued action finishes replaying -- either the
 * created resource, or `{ __error: message }` if it came back as a genuine
 * rejection (not a network failure) on replay. `undefined` means still
 * pending (or unknown queueId). */
export function getCompletion(queueId: string): unknown {
  return readCompletions()[queueId];
}

export function clearCompletion(queueId: string): void {
  const completions = readCompletions();
  if (queueId in completions) {
    delete completions[queueId];
    writeCompletions(completions);
  }
}

let flushing = false;

export async function flushQueue(): Promise<void> {
  // Reentrancy guard: a flaky connection can fire the browser's 'online'
  // event multiple times in quick succession during a reconnect. Without
  // this, two overlapping calls can both read the same queue snapshot
  // before either clears it, replaying the same submission twice.
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

  const completions = readCompletions();
  const remaining: QueuedAction[] = [];

  for (let i = 0; i < queue.length; i++) {
    const action = queue[i];
    const executor = executors[action.type];
    if (!executor) {
      remaining.push(action, ...queue.slice(i + 1));
      break;
    }

    try {
      completions[action.queueId] = await executor(action.payload);
    } catch (err) {
      if (isNetworkError(err)) {
        // Still offline -- stop here, preserve remaining order for next flush.
        remaining.push(action, ...queue.slice(i + 1));
        break;
      }
      // A real rejection on replay (e.g. the reservation slot filled up, or
      // an item sold out, while this was queued) -- record it so the
      // waiting screen can show the actual reason instead of spinning
      // forever, and drop it from the queue rather than retrying forever.
      completions[action.queueId] = { __error: err instanceof Error ? err.message : 'This could not be sent' };
    }
  }

  writeQueue(remaining);
  writeCompletions(completions);
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
