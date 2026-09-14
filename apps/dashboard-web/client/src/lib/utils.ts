import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const phpFormatter = new Intl.NumberFormat("en-PH", {
  style: "currency",
  currency: "PHP",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatCurrency(amount: number): string {
  return phpFormatter.format(amount);
}

/** Converts a bare "HH:MM" or "HH:MM:SS" backend time string (reservation
 * start/end times, business hours) into "h:mm AM/PM" -- the backend always
 * sends 24-hour as an unambiguous wire format; this is purely a display
 * conversion. Every reservation-time display in this app should go through
 * this instead of the old `.slice(0, 5)` truncate-only pattern, which left
 * e.g. "18:00" on screen with no AM/PM conversion at all. */
export function formatTime12h(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m).padStart(2, '0')} ${period}`;
}

/** Formats a full ISO timestamp (opened_at, closed_at, created_at, ...) as
 * "h:mm AM/PM", explicitly -- not relying on `.toLocaleTimeString()`'s
 * locale-default formatting, which happens to render 12-hour under en-US
 * but isn't guaranteed and wasn't consistent with formatTime12h above. */
export function formatTimestamp12h(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

/** Full date + explicit-12-hour time, for the many "recorded at" / "created
 * at" columns across Stock/Refund/Loss/Payroll/Delivery history tables that
 * used to call bare `.toLocaleString()` with no options -- locale-default
 * formatting that happens to be 12-hour under en-US but wasn't explicit or
 * guaranteed. */
export function formatDateTime12h(iso: string): string {
  return `${new Date(iso).toLocaleDateString('en-US')} ${formatTimestamp12h(iso)}`;
}
