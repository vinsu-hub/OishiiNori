import { useState } from 'react';
import { Volume2, VolumeX } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardLayout';
import { Button } from '@/components/ui/button';
import { OnlineOrdersBoard } from '@/components/orders/OnlineOrdersBoard';
import { OnlineOrderHistory } from '@/components/orders/OnlineOrderHistory';
import { isOnlineOrderSoundMuted, playOnlineOrderBeep, setOnlineOrderSoundMuted } from '@/lib/orderSounds';

type Tab = 'live' | 'history';

// Every website delivery/pickup order in one place for the cashier: review,
// send to the kitchen, log the cash when it comes back, and look back at past
// orders with their proof of payment.
export default function OnlineOrders() {
  const [tab, setTab] = useState<Tab>('live');
  const [muted, setMuted] = useState(isOnlineOrderSoundMuted);

  function toggleSound() {
    const next = !muted;
    setOnlineOrderSoundMuted(next);
    setMuted(next);
    // Unmuting plays the doorbell once so the cashier knows what to listen for.
    if (!next) playOnlineOrderBeep(true);
  }

  return (
    <DashboardLayout title="Online Orders">
      <div className="space-y-4 p-4 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex gap-2" role="tablist" aria-label="Online orders view">
            <Button role="tab" aria-selected={tab === 'live'} variant={tab === 'live' ? 'default' : 'outline'} className="min-h-10" onClick={() => setTab('live')}>
              Live orders
            </Button>
            <Button role="tab" aria-selected={tab === 'history'} variant={tab === 'history' ? 'default' : 'outline'} className="min-h-10" onClick={() => setTab('history')}>
              History
            </Button>
          </div>
          <Button
            variant="outline"
            className="min-h-10 gap-2"
            onClick={toggleSound}
            aria-pressed={!muted}
            title={muted ? 'New-order doorbell is off' : 'New-order doorbell is on'}
          >
            {muted ? <VolumeX className="h-4 w-4" aria-hidden /> : <Volume2 className="h-4 w-4" aria-hidden />}
            {muted ? 'Sound off' : 'Sound on'}
          </Button>
        </div>
        {tab === 'live' ? <OnlineOrdersBoard /> : <OnlineOrderHistory />}
      </div>
    </DashboardLayout>
  );
}
