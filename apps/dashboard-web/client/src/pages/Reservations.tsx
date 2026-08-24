import React, { useEffect, useState } from 'react';
import { useSearch } from 'wouter';
import { DashboardLayout } from '@/components/DashboardLayout';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { RequestsPanel } from '@/components/reservations/RequestsPanel';
import { TablesPanel } from '@/components/reservations/TablesPanel';

type ReservationsTab = 'requests' | 'tables';

function resolveTab(search: string): ReservationsTab {
  return new URLSearchParams(search).get('tab') === 'tables' ? 'tables' : 'requests';
}

export default function Reservations() {
  const search = useSearch();
  const [activeTab, setActiveTab] = useState<ReservationsTab>(() => resolveTab(search));

  useEffect(() => {
    setActiveTab(resolveTab(search));
  }, [search]);

  return (
    <DashboardLayout title="Reservations">
      <div className="p-6 space-y-4">
        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as ReservationsTab)}>
          <TabsList>
            <TabsTrigger value="requests">Requests</TabsTrigger>
            <TabsTrigger value="tables">Tables</TabsTrigger>
          </TabsList>
        </Tabs>

        {/* Both panels stay mounted (just hidden) so switching tabs is instant
            and doesn't lose in-progress work or re-fetch on every click. */}
        <div className={activeTab === 'requests' ? '' : 'hidden'}>
          <RequestsPanel />
        </div>
        <div className={activeTab === 'tables' ? '' : 'hidden'}>
          <TablesPanel />
        </div>
      </div>
    </DashboardLayout>
  );
}
