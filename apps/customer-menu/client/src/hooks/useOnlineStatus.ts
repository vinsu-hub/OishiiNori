import { useEffect, useState } from 'react';

// Lets a customer know they're offline *before* they submit, not just after
// a failed request -- driven by the browser's own online/offline events
// (the same signal apps/dashboard-web and apps/staff-clock's offline queues
// already key their resync off), not a poll.
export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));

  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  return online;
}
