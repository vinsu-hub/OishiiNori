import { useEffect } from 'react';
import { effectivePollMs } from '@/lib/constants';

/**
 * Drop-in replacement for the `load(); setInterval(load, ms); clearInterval`
 * pattern repeated across every polling page (Order Queue, Kitchen Display,
 * Pending Orders, Receive Shipment, Loss Log, Utility Log, Command Center,
 * InventoryAlertsContext) -- none of those checked document.visibilityState,
 * so a backgrounded tab polled exactly as often as a foregrounded one. This
 * skips the actual fetch while hidden, and refetches immediately the moment
 * the tab becomes visible again so data isn't stale when you switch back.
 *
 * Every wait goes through effectivePollMs (lib/constants.ts): never below
 * MIN_POLL_INTERVAL_MS, and slowed right down outside business hours. It's
 * re-evaluated on each tick, so a screen left open overnight speeds back up
 * on its own in the morning.
 *
 * Deliberately mirrors the exact dependency semantics the original
 * `useEffect(() => {...}, [load])` call sites had (effect re-fires and
 * immediately re-fetches whenever `load`'s identity changes) rather than
 * hiding `load` behind a ref -- InventoryAlertsContext's `load` depends on
 * `user`, and needs an immediate re-fetch the moment auth resolves, not a
 * silent wait for the next interval tick.
 */
export function useVisiblePolling(load: () => void, intervalMs: number) {
  useEffect(() => {
    load();

    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      if (document.visibilityState === 'visible') {
        load();
      }
      timer = setTimeout(tick, effectivePollMs(intervalMs));
    };
    timer = setTimeout(tick, effectivePollMs(intervalMs));

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        load();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [load, intervalMs]);
}
