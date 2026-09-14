import { Loader2, WifiOff } from 'lucide-react';

/** Shown in place of the normal receipt/confirmation screen while a
 * connection drop has this order/reservation sitting in the local offline
 * queue -- so the customer sees "we're on it," not a dead end, and doesn't
 * need to notice a toast or manually retry. Automatically replaced by the
 * real receipt/confirmation view once the queue actually flushes (see
 * useQueuedCompletion in App.tsx/ReservationView.tsx). */
export default function QueuedSubmissionView({ label }: { label: string }) {
  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="item-modal" style={{ position: 'static', maxWidth: 380, textAlign: 'center' }}>
        <div className="modal-body">
          <WifiOff size={40} color="#a51f26" style={{ margin: '0 auto 12px' }} />
          <h2>You're offline</h2>
          <p style={{ margin: '8px 0 0' }}>
            We've saved your {label} on this device. It'll send automatically the moment your connection is back --
            no need to do anything.
          </p>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 18, color: '#918378' }}>
            <Loader2 size={16} className="animate-spin" /> Waiting for a connection…
          </div>
        </div>
      </div>
    </div>
  );
}
