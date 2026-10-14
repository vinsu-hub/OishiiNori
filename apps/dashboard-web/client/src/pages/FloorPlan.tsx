import { DashboardLayout } from '@/components/DashboardLayout';
import { FloorPlanPanel } from '@/components/reservations/FloorPlanPanel';
import { todayIsoPH } from '@/lib/constants';

/** Cashier shortcut to today's floor plan, mainly for releasing seated tables. */
export default function FloorPlan() {
  return (
    <DashboardLayout title="Floor Plan">
      <div className="p-6">
        <FloorPlanPanel selectedDay={todayIsoPH()} />
      </div>
    </DashboardLayout>
  );
}
