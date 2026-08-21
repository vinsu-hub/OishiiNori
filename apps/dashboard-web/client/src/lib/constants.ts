// Polling, not websockets/Supabase realtime -- matches the reference app's
// pattern (see build plan architecture notes). Shared by every live-board
// page (Order Queue, Kitchen Display, Pending Orders) so the interval stays
// in sync across them.
export const POLL_INTERVAL_MS = 20_000;

// Client-side preview only, used by POS Terminal to show a discount/tax
// estimate before charging -- the backend recomputes authoritatively from
// the live discount_type row (see services/api-fastapi/app/routers/
// transactions.py's own VAT_RATE constant) and this must be kept in sync
// with it by hand if that ever changes.
export const VAT_RATE_PREVIEW = 0.12;
