import { WifiOff } from 'lucide-react';
import { useOnlineStatus } from '@/hooks/useOnlineStatus';

/** Persistent, unmissable strip shown the instant the browser goes offline
 * -- so a customer knows before they tap "Place order"/"Request this
 * table," not just after a submission silently queues. */
export default function OfflineBanner() {
  const online = useOnlineStatus();
  if (online) return null;
  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        zIndex: 60,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        padding: '6px 12px',
        background: '#a51f26',
        color: '#fff',
        fontSize: 12,
        fontWeight: 700,
        letterSpacing: '.02em',
      }}
    >
      <WifiOff size={14} /> You're offline -- anything you submit now will send automatically once you're back
    </div>
  );
}
