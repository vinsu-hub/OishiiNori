import React, { useState } from 'react';
import { DashboardLayout } from '@/components/DashboardLayout';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { DigitalOrdersQueue } from '@/components/shared/DigitalOrdersQueue';

// Advance orders placed through the customer-menu's "Schedule an Order" link
// (delivery or pickup for a chosen date/time). Approving one confirms it; the
// backend then holds it out of Kitchen Display/print until 20 minutes before
// the requested time, which is why an approved order moves to "Upcoming".
type ScheduledTab = 'pending' | 'upcoming';

export default function ScheduledOrders() {
  const [activeTab, setActiveTab] = useState<ScheduledTab>('pending');

  return (
    <DashboardLayout title="Scheduled Orders">
      <div className="p-6 space-y-4">
        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as ScheduledTab)}>
          <TabsList>
            <TabsTrigger value="pending">Pending approval</TabsTrigger>
            <TabsTrigger value="upcoming">Upcoming</TabsTrigger>
          </TabsList>
        </Tabs>

        {activeTab === 'pending' ? (
          <DigitalOrdersQueue
            key="pending"
            channel="all"
            scheduledOnly
            view="pending"
            title="Scheduled Orders"
            emptyLabel="No scheduled orders waiting for approval."
            embedded
          />
        ) : (
          <DigitalOrdersQueue
            key="upcoming"
            channel="all"
            scheduledOnly
            view="upcoming"
            title="Scheduled Orders"
            emptyLabel="No approved scheduled orders waiting for their kitchen time."
            embedded
          />
        )}
      </div>
    </DashboardLayout>
  );
}
