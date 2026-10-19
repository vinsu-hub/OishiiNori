import { DashboardLayout } from '@/components/DashboardLayout';
import { AdvanceOrdersSection } from '@/components/pos/AdvanceOrdersSection';

export default function AdvanceOrders() {
  return <DashboardLayout title="Advance Orders"><div className="p-6 space-y-4">
    <div><h2 className="font-corp-display text-xl font-semibold">POS advance pickup orders</h2><p className="text-sm text-muted-foreground">Times are when food must be ready for pickup. Orders due within the hour have an amber edge; late ones are red. Delivery advance orders appear in Deliveries; website scheduled orders are approved in Scheduled Orders.</p></div>
    <AdvanceOrdersSection orderType="takeout" />
  </div></DashboardLayout>;
}
