// Polling, not websockets/Supabase realtime -- matches the reference app's
// pattern (see build plan architecture notes). Shared by every live-board
// page (Order Queue, Kitchen Display, Pending Orders) so the interval stays
// in sync across them.
export const POLL_INTERVAL_MS = 30_000;

// Matches the backend's ph_time.py: timestamps are stored/compared as true
// UTC everywhere, but a "today"/date-range default needs to mean a
// Philippines calendar day, not whatever the viewing device's local
// timezone (or plain UTC, via Date.toISOString()) happens to be.
const PH_UTC_OFFSET_MS = 8 * 60 * 60 * 1000;

// CPU guardrail: on 2026-10-16 Vercel paused every app because the API used
// up the Hobby plan's 4 h/month of Active CPU -- mostly the kitchen tablet
// polling the full order list every 5 s, all day. useVisiblePolling enforces
// these for every live page, so a new page can't quietly reintroduce that.
// Nothing polls faster than this:
export const MIN_POLL_INTERVAL_MS = 15_000;
// ...and outside the PH window below (opening hours are 11:00-21:00, with
// room for prep and late orders) screens left open overnight check only
// every 5 minutes. Switching back to a tab still refreshes immediately.
export const QUIET_POLL_INTERVAL_MS = 5 * 60_000;
const BUSY_FROM_HOUR_PH = 9;
const BUSY_UNTIL_HOUR_PH = 23;

export function effectivePollMs(intervalMs: number): number {
  const hour = new Date(Date.now() + PH_UTC_OFFSET_MS).getUTCHours();
  const base = Math.max(intervalMs, MIN_POLL_INTERVAL_MS);
  return hour >= BUSY_FROM_HOUR_PH && hour < BUSY_UNTIL_HOUR_PH ? base : Math.max(base, QUIET_POLL_INTERVAL_MS);
}

export function todayIsoPH(): string {
  return new Date(Date.now() + PH_UTC_OFFSET_MS).toISOString().slice(0, 10);
}

export function orderHistoryDateIsoPH(): string {
  // A 22:00 Manila cutoff makes orders placed after closing belong to the
  // following selected history date.
  return new Date(Date.now() + PH_UTC_OFFSET_MS + 2 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function daysAgoIsoPH(days: number): string {
  return new Date(Date.now() + PH_UTC_OFFSET_MS - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function toIsoDatePH(isoTimestamp: string): string {
  return new Date(new Date(isoTimestamp).getTime() + PH_UTC_OFFSET_MS).toISOString().slice(0, 10);
}

// Public customer menu on the production domain (landing-page rewrites /menu
// to the customer-menu app). A table's QR code is this + ?table=<pos_table_number>.
export const CUSTOMER_MENU_URL = 'https://www.oishiinori.com/menu';

export function tableOrderUrl(tableNumber: number): string {
  return `${CUSTOMER_MENU_URL}?table=${tableNumber}`;
}
