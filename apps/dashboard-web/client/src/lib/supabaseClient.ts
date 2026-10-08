import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
const supabasePublishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string;

export const supabase = createClient(supabaseUrl, supabasePublishableKey);

// Tablets: Chrome pauses timers while the tab is hidden (screen off, or the
// cashier switched to RawBT to print), so the token can expire unnoticed.
// Refresh it as soon as the dashboard is visible again.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      supabase.auth.startAutoRefresh();
      void supabase.auth.getSession();
    } else {
      supabase.auth.stopAutoRefresh();
    }
  });
}
