import React, { useEffect, useState } from 'react';
import { useSearch } from 'wouter';
import { DashboardLayout } from '@/components/DashboardLayout';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { RequestsPanel } from '@/components/reservations/RequestsPanel';
import { TablesPanel } from '@/components/reservations/TablesPanel';
import { FloorPlanPanel } from '@/components/reservations/FloorPlanPanel';

type ReservationsTab = 'requests' | 'tables' | 'floor-plan';

function resolveTab(search: string): ReservationsTab {
  const tab = new URLSearchParams(search).get('tab');
  if (tab === 'tables') return 'tables';
  if (tab === 'floor-plan') return 'floor-plan';
  return 'requests';
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
            <TabsTrigger value="floor-plan">Floor Plan</TabsTrigger>
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
        {/* Mounted only when active -- the SVG canvas + 1s tick shouldn't run
            in the background on the other tabs. */}
        {activeTab === 'floor-plan' && <FloorPlanPanel />}
      </div>
    </DashboardLayout>
  );
}
