import React, { createContext, useCallback, useContext, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import { toast } from 'sonner';
import { fetchDigitalOrders } from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';
import { useVisiblePolling } from '@/hooks/useVisiblePolling';
import { POLL_INTERVAL_MS } from '@/lib/constants';
import { playTableOrderBeep } from '@/lib/orderSounds';
import { formatCurrency } from '@/lib/utils';

interface TableOrderAlertsContextType {
  pendingCount: number;
}

const TableOrderAlertsContext = createContext<TableOrderAlertsContextType>({ pendingCount: 0 });

// Pages where a pending (not yet approved) QR order isn't actionable: the
// kitchen only cares once the cashier approves it, and Kitchen Display
// already beeps then.
const QUIET_PATHS = ['/kitchen-display'];
// Roles that never approve table orders.
const NON_CASHIER_ROLES = new Set(['rider', 'stocker']);

/** Watches for new QR table orders (customer scanned a table sticker and
 * ordered) and alerts the cashier on whatever page they're on: a chime, a
 * toast that jumps to Table Orders, and the sidebar badge count. Mounted
 * once inside the router (same posture as InventoryAlertsProvider) so it
 * survives page navigation instead of re-baselining on every page. */
export function TableOrderAlertsProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const [location, navigate] = useLocation();
  const [pendingCount, setPendingCount] = useState(0);
  // null until the first load -- that load only records what's already
  // waiting, so opening the app doesn't chime for old orders.
  const seenIdsRef = useRef<Set<string> | null>(null);
  const locationRef = useRef(location);
  locationRef.current = location;

  const enabled = !!user && !NON_CASHIER_ROLES.has(user.role);

  const load = useCallback(() => {
    if (!enabled) return;
    fetchDigitalOrders('pending')
      .then((orders) => {
        const tableOrders = orders.filter((o) => o.order_channel === 'dine_in_qr');
        setPendingCount(tableOrders.length);

        const seen = seenIdsRef.current;
        seenIdsRef.current = new Set(tableOrders.map((o) => o.id));
        if (!seen) return;
        const fresh = tableOrders.filter((o) => !seen.has(o.id));
        if (fresh.length === 0) return;

        const path = locationRef.current;
        if (QUIET_PATHS.includes(path)) return;
        playTableOrderBeep();
        if (path === '/pending-orders') return; // the list itself shows it
        for (const o of fresh) {
          toast(`New table order — Table ${o.table_number ?? '?'}`, {
            description: `Order #${o.order_number} · ${formatCurrency(o.subtotal)} · waiting for approval`,
            duration: Infinity,
            action: { label: 'Review', onClick: () => navigate('/pending-orders') },
          });
        }
      })
      .catch(() => {
        // Non-critical -- the next poll tries again; Table Orders itself
        // surfaces real load errors.
      });
  }, [enabled, navigate]);

  useVisiblePolling(load, POLL_INTERVAL_MS);

  return (
    <TableOrderAlertsContext.Provider value={{ pendingCount: enabled ? pendingCount : 0 }}>
      {children}
    </TableOrderAlertsContext.Provider>
  );
}

export function useTableOrderAlerts() {
  return useContext(TableOrderAlertsContext);
}
