import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Converts a bare "HH:MM" or "HH:MM:SS" business-hours string into
 * "h:mm AM/PM". Mirrors apps/dashboard-web and apps/customer-menu's own
 * lib/utils.ts equivalents; scripts/prerender.mjs keeps its own copy since
 * it runs outside the Vite React SSR pipeline's easy reach at the point
 * it's called -- see that file's own comment. */
export function formatTime12h(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m).padStart(2, '0')} ${period}`;
}
