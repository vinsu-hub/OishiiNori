import React from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useInventoryAlerts } from '@/contexts/InventoryAlertsContext';
import { useLocation } from 'wouter';
import { DashboardLayout } from '@/components/DashboardLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { AlertCircle } from 'lucide-react';

export default function Home() {
  const { user } = useAuth();
  const { lowStockCount, ingredients, stockItems } = useInventoryAlerts();
  const [, navigate] = useLocation();

  // Executive's landing page is Command Center, mirroring the SMFC
  // reference's Home.tsx role router; manager/employee keep this welcome
  // card unchanged (out of scope -- only the executive tab was missing
  // content).
  React.useEffect(() => {
    if (user?.role === 'executive') {
      navigate('/command-center');
    }
  }, [user, navigate]);

  if (user?.role === 'executive') {
    return null;
  }

  const lowStockNames = [...ingredients.map((i) => i.name), ...stockItems.map((i) => i.name)];
  // WS-11: Stock & Inventory (and its low-stock alerts) is now manager+ only
  // -- a cashier no longer has anywhere to route to from this card, and the
  // welcome copy should list what their own sidebar actually contains.
  // (executive already redirected away above, so only 'manager' remains here.)
  const isManagerOrExecutive = user?.role === 'manager';
  // Phase 4: the two new restricted-department roles get their own copy --
  // neither has a POS/Order Queue/Menu Editing sidebar entry at all.
  const isStocker = user?.role === 'stocker';
  const isRider = user?.role === 'rider';
  const showLowStockCard = (isManagerOrExecutive || isStocker) && lowStockCount > 0;

  let welcomeCopy: string;
  if (isStocker) {
    welcomeCopy = 'Use the sidebar to get to Stock & Inventory.';
  } else if (isRider) {
    welcomeCopy = 'Use the sidebar to get to your Delivery tab.';
  } else if (isManagerOrExecutive) {
    welcomeCopy =
      'Use the sidebar to get to POS Terminal, Order Queue, Kitchen Display, Reservations, Inventory, Menu Editing, and HR & Payroll.';
  } else {
    welcomeCopy = 'Use the sidebar to get to POS Terminal, Order Queue, Kitchen Display, Reservations, and Menu Editing.';
  }

  return (
    <DashboardLayout title="Home">
      <div className="p-6 space-y-4">
        <Card className="max-w-xl">
          <CardHeader>
            <CardTitle className="font-corp-display">Welcome, {user?.name}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">{welcomeCopy}</p>
          </CardContent>
        </Card>

        {showLowStockCard && (
          <Card className="max-w-xl border-l-4 border-l-destructive bg-error-bg">
            <CardHeader>
              <CardTitle className="text-destructive flex items-center gap-2">
                <AlertCircle className="w-4 h-4" />
                Low Stock ({lowStockCount})
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                {lowStockNames.slice(0, 3).join(', ')}
                {lowStockCount > lowStockNames.slice(0, 3).length ? ', and more' : ''} at or below reorder
                threshold.
              </p>
              <div className="flex gap-3 mt-3">
                <button
                  type="button"
                  className="text-xs text-primary underline underline-offset-2"
                  onClick={() => navigate('/stock')}
                >
                  Ingredient Stock &rarr;
                </button>
                <button
                  type="button"
                  className="text-xs text-primary underline underline-offset-2"
                  onClick={() => navigate('/stock?tab=stations')}
                >
                  Station Items &rarr;
                </button>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </DashboardLayout>
  );
}
