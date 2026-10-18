import { Link, useLocation } from 'wouter';
import { BellRing } from 'lucide-react';
import { ONLINE_ORDERS_ROUTE, useTableOrderAlerts } from '@/contexts/TableOrderAlertsContext';

/** Reminds cashiers on every page that a website order is waiting for review. */
export function OnlineOrdersBanner() {
  const { onlineEnabled, pendingOnlineCount } = useTableOrderAlerts();
  const [location] = useLocation();
  if (!onlineEnabled || pendingOnlineCount === 0 || location === '/order-queue') return null;
  return (
    <div role="status" className="flex flex-wrap items-center gap-2 border-b border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-950">
      <BellRing className="h-4 w-4 shrink-0" aria-hidden />
      <span>
        {pendingOnlineCount} online order{pendingOnlineCount === 1 ? '' : 's'} waiting for review
      </span>
      <Link href={ONLINE_ORDERS_ROUTE} className="font-semibold underline underline-offset-2">Review now</Link>
    </div>
  );
}
