import React, { useState } from 'react';
import { DashboardLayout } from '@/components/DashboardLayout';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAuth } from '@/contexts/AuthContext';
import { DigitalOrdersQueue } from '@/components/shared/DigitalOrdersQueue';
import { DeliveryMonitor } from '@/components/shared/DeliveryMonitor';

// WS-7 (Phase 6): delivery orders placed through the general (non-table)
// ordering link. Approving hands the order to the rider panel (WS-8) once
// it's a real transaction. Manager/executive additionally get a second
// tab monitoring the rider pipeline end to end (out for delivery ->
// completed) -- everyone else just sees the approval queue, unchanged.
type DeliveryTab = 'requests' | 'monitor';

export default function DeliveryRequests() {
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState<DeliveryTab>('requests');
  const canMonitor = user?.role === 'manager' || user?.role === 'executive';

  if (!canMonitor) {
    return (
      <DigitalOrdersQueue channel="delivery" title="Delivery Requests" emptyLabel="No pending delivery requests." />
    );
  }

  return (
    <DashboardLayout title="Delivery Requests">
      <div className="p-6 space-y-4">
        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as DeliveryTab)}>
          <TabsList>
            <TabsTrigger value="requests">Requests</TabsTrigger>
            <TabsTrigger value="monitor">In Progress / Completed</TabsTrigger>
          </TabsList>
        </Tabs>

        <div className={activeTab === 'requests' ? '' : 'hidden'}>
          <DigitalOrdersQueue
            channel="delivery"
            title="Delivery Requests"
            emptyLabel="No pending delivery requests."
            embedded
          />
        </div>
        {activeTab === 'monitor' && <DeliveryMonitor />}
      </div>
    </DashboardLayout>
  );
}
