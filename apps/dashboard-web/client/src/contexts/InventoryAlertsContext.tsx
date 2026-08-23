import React, { createContext, useContext, useEffect, useState } from 'react';
import { ApiLowStockIngredient, ApiLowStockStockItem, fetchLowStockSummary } from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';

const POLL_INTERVAL_MS = 90_000; // low stock doesn't change minute to minute -- deliberately slower than any page's own poll.

interface InventoryAlertsContextType {
  lowStockCount: number;
  ingredients: ApiLowStockIngredient[];
  stockItems: ApiLowStockStockItem[];
  loading: boolean;
}

const InventoryAlertsContext = createContext<InventoryAlertsContextType | undefined>(undefined);

// Mounted once at the App root (not inside Sidebar, which every page
// remounts on navigation with no persistent layout wrapper) so navigating
// between pages doesn't refire this fetch.
export function InventoryAlertsProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const [ingredients, setIngredients] = useState<ApiLowStockIngredient[]>([]);
  const [stockItems, setStockItems] = useState<ApiLowStockStockItem[]>([]);
  // Separate from the arrays above, which the backend caps at 10 each for
  // payload size -- the badge count must reflect the true total, not just
  // how many detail rows were sent.
  const [lowStockCount, setLowStockCount] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    const load = () => {
      fetchLowStockSummary()
        .then((data) => {
          if (cancelled) return;
          setIngredients(data.ingredients);
          setStockItems(data.stock_items);
          setLowStockCount(data.ingredient_count + data.stock_item_count);
        })
        .catch(() => {
          // Non-critical -- the badge/card just stays at its last known value.
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    };
    load();
    const interval = setInterval(load, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [user]);

  return (
    <InventoryAlertsContext.Provider value={{ lowStockCount, ingredients, stockItems, loading }}>
      {children}
    </InventoryAlertsContext.Provider>
  );
}

export function useInventoryAlerts() {
  const context = useContext(InventoryAlertsContext);
  if (context === undefined) {
    throw new Error('useInventoryAlerts must be used within an InventoryAlertsProvider');
  }
  return context;
}
