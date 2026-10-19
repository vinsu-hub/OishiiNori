import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import { toast } from 'sonner';
import { fetchDigitalOrders } from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';
import { useVisiblePolling } from '@/hooks/useVisiblePolling';
import { playOnlineOrderBeep, playTableOrderBeep } from '@/lib/orderSounds';
import { formatCurrency } from '@/lib/utils';

interface TableOrderAlertsContextType {
  pendingCount: number;
  pendingPickupCount: number;
  pendingDeliveryCount: number;
  pendingScheduledCount: number;
  /** Website delivery/pickup orders waiting for a cashier (any schedule). */
  pendingOnlineCount: number;
  /** When the longest-waiting online order came in (ms), or null. */
  oldestOnlinePendingAt: number | null;
  /** Whether this account reviews online orders. */
  onlineEnabled: boolean;
}

const TableOrderAlertsContext = createContext<TableOrderAlertsContextType>({
  pendingCount: 0,
  pendingPickupCount: 0,
  pendingDeliveryCount: 0,
  pendingScheduledCount: 0,
  pendingOnlineCount: 0,
  oldestOnlinePendingAt: null,
  onlineEnabled: false,
});

/** Where cashiers review website orders: the Online Orders page. */
export const ONLINE_ORDERS_ROUTE = '/online-orders';
// An online order left this long gets a repeat beep every minute.
const ONLINE_REMINDER_AFTER_MS = 2 * 60_000;
const ONLINE_REMINDER_EVERY_MS = 60_000;

// Pages where a pending (not yet approved) QR order isn't actionable: the
// kitchen only cares once the cashier approves it, and Kitchen Display
// already beeps then.
const QUIET_PATHS = ['/kitchen-display'];
// Roles that never approve table orders.
const NON_CASHIER_ROLES = new Set(['rider', 'stocker']);

/** Watches the shared pending digital-order queue across dashboard pages. */
export function TableOrderAlertsProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const [location, navigate] = useLocation();
  const [pendingCount, setPendingCount] = useState(0);
  const [pendingPickupCount, setPendingPickupCount] = useState(0);
  const [pendingDeliveryCount, setPendingDeliveryCount] = useState(0);
  const [pendingScheduledCount, setPendingScheduledCount] = useState(0);
  const [pendingOnlineCount, setPendingOnlineCount] = useState(0);
  const [oldestOnlinePendingAt, setOldestOnlinePendingAt] = useState<number | null>(null);
  // First successful load establishes a baseline, without chiming for old orders.
  const seenTableIdsRef = useRef<Set<string> | null>(null);
  const seenOnlineIdsRef = useRef<Set<string> | null>(null);
  const userIdRef = useRef(user?.id);
  const inFlightForRef = useRef<string | null>(null);
  const locationRef = useRef(location);
  locationRef.current = location;

  const tableEnabled = !!user && !NON_CASHIER_ROLES.has(user.role);
  // Cashiers review website orders too (Order Queue → Online).
  const onlineEnabled = !!user && !['kitchen', 'rider', 'stocker'].includes(user.role) && (
    ['employee', 'manager', 'executive'].includes(user.role) || user.extraPages.includes('online-orders')
  );

  useEffect(() => {
    userIdRef.current = user?.id;
    inFlightForRef.current = null;
    seenTableIdsRef.current = null;
    seenOnlineIdsRef.current = null;
    setPendingCount(0);
    setPendingPickupCount(0);
    setPendingDeliveryCount(0);
    setPendingScheduledCount(0);
    setPendingOnlineCount(0);
    setOldestOnlinePendingAt(null);
  }, [user?.id]);

  const load = useCallback(() => {
    if ((!tableEnabled && !onlineEnabled) || inFlightForRef.current === user?.id) return;
    inFlightForRef.current = user?.id ?? null;
    const requestedFor = user?.id;
    fetchDigitalOrders('pending')
      .then((orders) => {
        if (userIdRef.current !== requestedFor) return;
        const tableOrders = orders.filter((o) => o.order_channel === 'dine_in_qr');
        const onlineOrders = orders.filter((o) => o.order_channel === 'pickup' || o.order_channel === 'delivery');
        if (tableEnabled) setPendingCount(tableOrders.length);
        if (onlineEnabled) {
          setPendingPickupCount(onlineOrders.filter((o) => o.order_channel === 'pickup' && !o.scheduled_for).length);
          setPendingDeliveryCount(onlineOrders.filter((o) => o.order_channel === 'delivery' && !o.scheduled_for).length);
          setPendingScheduledCount(onlineOrders.filter((o) => !!o.scheduled_for).length);
          setPendingOnlineCount(onlineOrders.length);
          setOldestOnlinePendingAt(onlineOrders.length
            ? Math.min(...onlineOrders.map((o) => Date.parse(o.created_at)))
            : null);
        }

        const seenTable = seenTableIdsRef.current;
        const seenOnline = seenOnlineIdsRef.current;
        if (tableEnabled) seenTableIdsRef.current = new Set([...(seenTable ? Array.from(seenTable) : []), ...tableOrders.map((o) => o.id)]);
        if (onlineEnabled) seenOnlineIdsRef.current = new Set([...(seenOnline ? Array.from(seenOnline) : []), ...onlineOrders.map((o) => o.id)]);

        const path = locationRef.current;
        const freshTable = seenTable && tableEnabled ? tableOrders.filter((o) => !seenTable.has(o.id)) : [];
        if (freshTable.length && !QUIET_PATHS.includes(path)) {
          playTableOrderBeep();
          if (path !== '/pending-orders') {
            for (const o of freshTable) {
              toast(`New table order — Table ${o.table_number ?? '?'}`, {
                description: `Order #${o.order_number} · ${formatCurrency(o.subtotal)} · waiting for approval`,
                duration: Infinity,
                action: { label: 'Review', onClick: () => navigate('/pending-orders') },
              });
            }
          }
        }

        const freshOnline = seenOnline && onlineEnabled ? onlineOrders.filter((o) => !seenOnline.has(o.id)) : [];
        if (freshOnline.length) {
          playOnlineOrderBeep();
          for (const order of freshOnline) {
            const destination = ONLINE_ORDERS_ROUTE;
            const kind = order.order_channel === 'delivery' ? 'Delivery' : 'Pickup';
            const amount = formatCurrency(order.subtotal + (order.delivery?.delivery_fee ?? 0));
            toast.custom((toastId) => (
              <div className="w-full max-w-sm rounded-2xl border border-border bg-card/95 p-4 text-card-foreground shadow-2xl backdrop-blur-md" role="status">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-primary">New online order</p>
                    <p className="mt-1 font-corp-display text-base font-semibold">Order #{order.order_number}</p>
                    <p className="mt-1 text-sm text-muted-foreground">{kind}{order.scheduled_for ? ' · Scheduled' : ''} · {amount}</p>
                  </div>
                  <button type="button" className="rounded-md px-2 py-1 text-muted-foreground hover:bg-muted" aria-label={`Dismiss order ${order.order_number} notification`} onClick={() => toast.dismiss(toastId)}>×</button>
                </div>
                <button type="button" className="mt-3 rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90" onClick={() => { toast.dismiss(toastId); navigate(destination); }}>Review order</button>
              </div>
            ), { id: `online-order-${order.id}`, duration: Infinity, position: 'bottom-right' });
          }
        }
      })
      .catch(() => {
        // Non-critical -- the next poll tries again; Table Orders itself
        // surfaces real load errors.
      })
      .finally(() => {
        if (inFlightForRef.current === requestedFor) inFlightForRef.current = null;
      });
  }, [tableEnabled, onlineEnabled, navigate, user?.id]);

  // The new-order alarm stays a little quicker than the 30s boards; it's a cheap call.
  useVisiblePolling(load, 20_000);

  // Reminder: an online order nobody has reviewed for 2 minutes beeps again
  // every minute until someone approves or declines it.
  useEffect(() => {
    if (!onlineEnabled || oldestOnlinePendingAt === null) return;
    const timer = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - oldestOnlinePendingAt >= ONLINE_REMINDER_AFTER_MS) playOnlineOrderBeep();
    }, ONLINE_REMINDER_EVERY_MS);
    return () => clearInterval(timer);
  }, [onlineEnabled, oldestOnlinePendingAt]);

  return (
    <TableOrderAlertsContext.Provider value={{
      pendingCount: tableEnabled ? pendingCount : 0,
      pendingPickupCount: onlineEnabled ? pendingPickupCount : 0,
      pendingDeliveryCount: onlineEnabled ? pendingDeliveryCount : 0,
      pendingScheduledCount: onlineEnabled ? pendingScheduledCount : 0,
      pendingOnlineCount: onlineEnabled ? pendingOnlineCount : 0,
      oldestOnlinePendingAt: onlineEnabled ? oldestOnlinePendingAt : null,
      onlineEnabled,
    }}>
      {children}
    </TableOrderAlertsContext.Provider>
  );
}

export function useTableOrderAlerts() {
  return useContext(TableOrderAlertsContext);
}
