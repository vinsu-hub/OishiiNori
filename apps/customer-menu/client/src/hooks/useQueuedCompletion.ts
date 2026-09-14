import { useEffect, useState } from 'react';
import { clearCompletion, getCompletion, onQueueChange } from '@/lib/offlineQueue';

export type QueuedCompletion<T> = { status: 'pending' } | { status: 'done'; result: T } | { status: 'error'; message: string };

/** Watches a queued order/reservation submission until the offline queue
 * actually replays it (successfully or not) -- reacts to onQueueChange
 * (fired right after a flush attempt) rather than polling on a timer, since
 * the queue itself already knows exactly when something changed. */
export function useQueuedCompletion<T>(queueId: string | null): QueuedCompletion<T> {
  const [state, setState] = useState<QueuedCompletion<T>>({ status: 'pending' });

  useEffect(() => {
    if (!queueId) {
      setState({ status: 'pending' });
      return;
    }
    setState({ status: 'pending' });

    const check = () => {
      const completion = getCompletion(queueId);
      if (completion === undefined) return;
      clearCompletion(queueId);
      if (completion && typeof completion === 'object' && '__error' in (completion as Record<string, unknown>)) {
        setState({ status: 'error', message: String((completion as { __error: unknown }).__error) });
      } else {
        setState({ status: 'done', result: completion as T });
      }
    };

    check();
    return onQueueChange(check);
  }, [queueId]);

  return state;
}
