// CPU guardrail (see apps/dashboard-web/client/src/lib/constants.ts): on
// 2026-10-16 Vercel paused every app after the API used up the Hobby plan's
// monthly Active CPU. Polls here skip while the page is hidden (phone locked,
// tab in the background) and drop to every 5 minutes outside the PH window
// below, for a TV board or phone left open overnight.
const PH_UTC_OFFSET_MS = 8 * 60 * 60 * 1000;
const QUIET_POLL_INTERVAL_MS = 5 * 60_000;
const BUSY_FROM_HOUR_PH = 9;
const BUSY_UNTIL_HOUR_PH = 23;

function effectivePollMs(intervalMs: number): number {
  const hour = new Date(Date.now() + PH_UTC_OFFSET_MS).getUTCHours();
  return hour >= BUSY_FROM_HOUR_PH && hour < BUSY_UNTIL_HOUR_PH ? intervalMs : Math.max(intervalMs, QUIET_POLL_INTERVAL_MS);
}

/** Calls `fn` every `intervalMs` while the page is visible, and right away when it becomes visible again. Returns a stop function. */
export function startVisiblePolling(fn: () => void, intervalMs: number): () => void {
  let timer: ReturnType<typeof setTimeout>;
  const tick = () => {
    if (document.visibilityState === 'visible') fn();
    timer = setTimeout(tick, effectivePollMs(intervalMs));
  };
  timer = setTimeout(tick, effectivePollMs(intervalMs));
  const onVisibility = () => {
    if (document.visibilityState === 'visible') fn();
  };
  document.addEventListener('visibilitychange', onVisibility);
  return () => {
    clearTimeout(timer);
    document.removeEventListener('visibilitychange', onVisibility);
  };
}
