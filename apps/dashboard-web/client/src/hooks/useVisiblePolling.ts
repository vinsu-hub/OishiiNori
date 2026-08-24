import { useEffect } from 'react';

/**
 * Drop-in replacement for the `load(); setInterval(load, ms); clearInterval`
 * pattern repeated across every polling page (Order Queue, Kitchen Display,
 * Pending Orders, Receive Shipment, Loss Log, Utility Log, Command Center,
 * InventoryAlertsContext) -- none of those checked document.visibilityState,
 * so a backgrounded tab polled exactly as often as a foregrounded one. This
 * keeps the timer running (cheap) but skips the actual fetch while hidden,
 * and refetches immediately the moment the tab becomes visible again so
 * data isn't stale when you switch back to it.
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

    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') {
        load();
      }
    }, intervalMs);

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        load();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [load, intervalMs]);
}
