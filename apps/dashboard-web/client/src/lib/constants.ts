// Polling, not websockets/Supabase realtime -- matches the reference app's
// pattern (see build plan architecture notes). Shared by every live-board
// page (Order Queue, Kitchen Display, Pending Orders) so the interval stays
// in sync across them.
export const POLL_INTERVAL_MS = 20_000;

// Matches the backend's ph_time.py: timestamps are stored/compared as true
// UTC everywhere, but a "today"/date-range default needs to mean a
// Philippines calendar day, not whatever the viewing device's local
// timezone (or plain UTC, via Date.toISOString()) happens to be.
const PH_UTC_OFFSET_MS = 8 * 60 * 60 * 1000;

export function todayIsoPH(): string {
  return new Date(Date.now() + PH_UTC_OFFSET_MS).toISOString().slice(0, 10);
}

export function daysAgoIsoPH(days: number): string {
  return new Date(Date.now() + PH_UTC_OFFSET_MS - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function toIsoDatePH(isoTimestamp: string): string {
  return new Date(new Date(isoTimestamp).getTime() + PH_UTC_OFFSET_MS).toISOString().slice(0, 10);
}
