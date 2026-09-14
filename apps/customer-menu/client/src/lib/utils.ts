type ClassValue = string | number | boolean | undefined | null | ClassValue[] | Record<string, boolean>;

function clsx(...inputs: ClassValue[]) {
  const classes: string[] = [];
  for (const input of inputs) {
    if (!input) continue;
    if (typeof input === 'string' || typeof input === 'number') {
      classes.push(String(input));
    } else if (Array.isArray(input)) {
      classes.push(...clsx(...input));
    } else if (typeof input === 'object') {
      for (const [key, value] of Object.entries(input)) {
        if (value) classes.push(key);
      }
    }
  }
  return classes.join(' ');
}

export function cn(...inputs: ClassValue[]) {
  return clsx(...inputs);
}

/** Converts a bare "HH:MM" or "HH:MM:SS" backend time string (reservation
 * slot times, confirmed reservation start/end) into "h:mm AM/PM" -- the
 * backend always sends 24-hour as an unambiguous wire format; this is
 * purely a display conversion. Mirrors apps/landing-page's own
 * formatTime12h and apps/dashboard-web's lib/utils.ts equivalent. */
export function formatTime12h(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m).padStart(2, '0')} ${period}`;
}