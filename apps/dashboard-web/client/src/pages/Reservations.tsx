import React, { useEffect, useState } from 'react';
import { useSearch } from 'wouter';
import { DashboardLayout } from '@/components/DashboardLayout';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { RequestsPanel } from '@/components/reservations/RequestsPanel';
import { TablesPanel } from '@/components/reservations/TablesPanel';
import { FloorPlanPanel } from '@/components/reservations/FloorPlanPanel';
import { todayIsoPH } from '@/lib/constants';

type ReservationsTab = 'requests' | 'tables' | 'floor-plan';

function resolveTab(search: string): ReservationsTab {
  const tab = new URLSearchParams(search).get('tab');
  if (tab === 'tables') return 'tables';
  if (tab === 'floor-plan') return 'floor-plan';
  return 'requests';
}

function dayLabel(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  return d.toLocaleDateString('en-PH', { weekday: 'short', month: 'short', day: 'numeric' });
}

export default function Reservations() {
  const search = useSearch();
  const [activeTab, setActiveTab] = useState<ReservationsTab>(() => resolveTab(search));
  // Shared across the Requests and Floor Plan tabs -- the day the whole
  // reservation view is scoped to. Tables (the roster) is day-agnostic.
  const [selectedDay, setSelectedDay] = useState<string>(todayIsoPH());
  const isToday = selectedDay === todayIsoPH();

  useEffect(() => {
    setActiveTab(resolveTab(search));
  }, [search]);

  return (
    <DashboardLayout title="Reservations">
      <div className="p-6 space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as ReservationsTab)}>
            <TabsList>
              <TabsTrigger value="requests">Requests</TabsTrigger>
              <TabsTrigger value="tables">Tables</TabsTrigger>
              <TabsTrigger value="floor-plan">Floor Plan</TabsTrigger>
            </TabsList>
          </Tabs>

          {activeTab !== 'tables' && (
            <div className="flex items-end gap-2">
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Day</label>
                <Input
                  type="date"
                  value={selectedDay}
                  onChange={(e) => setSelectedDay(e.target.value || todayIsoPH())}
                  className="w-40"
                />
              </div>
              {!isToday && (
                <Button size="sm" variant="outline" onClick={() => setSelectedDay(todayIsoPH())}>
                  Today
                </Button>
              )}
            </div>
          )}
        </div>

        {!isToday && activeTab !== 'tables' && (
          <p className="text-xs text-amber-600">
            Viewing {dayLabel(selectedDay)} — live table state (open orders, overdue) only shows for today.
          </p>
        )}

        {/* Both panels stay mounted (just hidden) so switching tabs is instant
            and doesn't lose in-progress work or re-fetch on every click. */}
        <div className={activeTab === 'requests' ? '' : 'hidden'}>
          <RequestsPanel selectedDay={selectedDay} />
        </div>
        <div className={activeTab === 'tables' ? '' : 'hidden'}>
          <TablesPanel />
        </div>
        {/* Mounted only when active -- the SVG canvas + 1s tick shouldn't run
            in the background on the other tabs. */}
        {activeTab === 'floor-plan' && <FloorPlanPanel selectedDay={selectedDay} />}
      </div>
    </DashboardLayout>
  );
}
