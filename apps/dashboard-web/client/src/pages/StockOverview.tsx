import React, { useCallback, useEffect, useState } from 'react';
import { useLocation } from 'wouter';
import { toast } from 'sonner';
import { DashboardLayout } from '@/components/DashboardLayout';
import { useAuth } from '@/contexts/AuthContext';
import { useInventoryAlerts } from '@/contexts/InventoryAlertsContext';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Loader2 } from 'lucide-react';
import {
  ApiExpiringIngredient,
  ApiIngredient,
  ApiInventoryMovement,
  ApiStockItem,
  StockStation,
  fetchExpiringSoon,
  fetchInventory,
  fetchInventoryMovements,
  fetchStockItems,
} from '@/lib/api';
import { StockStatTile } from '@/components/stock/StockStatTile';
import { STOCK_TABLE_CELL_CLASS, STOCK_TABLE_HEAD_CLASS, STOCK_TABLE_ROW_CLASS } from '@/components/stock/stockTableStyle';

const STATIONS: { value: StockStation; label: string }[] = [
  { value: 'tako_snack', label: 'Tako / Snack' },
  { value: 'cafe_drinks', label: 'Cafe / Drinks' },
  { value: 'sushi_kitchen_main', label: 'Sushi-Kitchen Main' },
  { value: 'ramen_hot_line', label: 'Ramen / Hot Line' },
];

const MOVEMENT_TYPE_LABELS: Record<string, string> = {
  delivery: 'Delivery',
  trans_in: 'Received',
  trans_out: 'Removed',
  transfer_in: 'Transfer in',
  transfer_out: 'Transfer out',
  count_adjustment: 'Count adjustment',
};

export default function StockOverview() {
  const { user } = useAuth();
  const [, navigate] = useLocation();
  const { lowStockCount } = useInventoryAlerts();

  const [ingredients, setIngredients] = useState<ApiIngredient[]>([]);
  const [expiringSoon, setExpiringSoon] = useState<ApiExpiringIngredient[]>([]);
  const [stockItems, setStockItems] = useState<ApiStockItem[]>([]);
  const [movements, setMovements] = useState<ApiInventoryMovement[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([fetchInventory(), fetchExpiringSoon(7), fetchStockItems({ active_only: true }), fetchInventoryMovements({ limit: 10 })])
      .then(([ing, expiring, items, moves]) => {
        setIngredients(ing);
        setExpiringSoon(expiring);
        setStockItems(items);
        setMovements(moves);
      })
      .catch((e) => toast.error(`Failed to load Stock Overview: ${e.message}`))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (user && user.role === 'employee') {
    return (
      <DashboardLayout title="Stock Overview">
        <div className="p-6">
          <p className="text-sm text-muted-foreground">You don't have access to this page.</p>
        </div>
      </DashboardLayout>
    );
  }

  const ingredientById = new Map(ingredients.map((i) => [i.id, i]));
  const needsVerificationCount = stockItems.filter((i) => i.needs_review).length;

  const byStation = STATIONS.map((s) => {
    const items = stockItems.filter((i) => i.station === s.value);
    return {
      ...s,
      itemCount: items.length,
      needsReviewCount: items.filter((i) => i.needs_review).length,
    };
  });

  return (
    <DashboardLayout title="Stock Overview">
      <div className="p-6 space-y-6">
        {loading ? (
          <div className="flex items-center justify-center py-8 text-muted-foreground">
            <Loader2 className="w-5 h-5 mr-2 animate-spin" />
            Loading overview...
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <StockStatTile
                label="Low Stock Items"
                value={lowStockCount}
                accent={lowStockCount > 0 ? 'destructive' : 'success'}
                hint="Recipe ingredients + station items at/below threshold"
                onClick={() => navigate('/stock/alerts')}
              />
              <StockStatTile
                label="Expiring Soon (7d)"
                value={expiringSoon.length}
                accent={expiringSoon.length > 0 ? 'warning' : 'success'}
                hint="Advisory only -- most recent delivery date"
                onClick={() => navigate('/stock/alerts')}
              />
              <StockStatTile
                label="Items Needing Verification"
                value={needsVerificationCount}
                accent={needsVerificationCount > 0 ? 'warning' : 'success'}
                hint="Station items flagged VERIFY"
                onClick={() => navigate('/stock?tab=stations')}
              />
              <StockStatTile
                label="Recipe Ingredients Tracked"
                value={ingredients.length}
                hint="Total ingredient catalog size"
                onClick={() => navigate('/stock')}
              />
            </div>

            <Card>
              <CardHeader>
                <CardTitle className="font-corp-display text-base">By Station</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                  {byStation.map((s) => (
                    <button
                      key={s.value}
                      type="button"
                      onClick={() => navigate(`/stock?tab=stations`)}
                      className="text-left rounded-md border border-border-regular p-3 hover:bg-accent transition-colors"
                    >
                      <p className="text-sm font-semibold text-foreground">{s.label}</p>
                      <p className="text-2xl font-bold text-foreground mt-1">{s.itemCount}</p>
                      <p className="text-xs text-muted-foreground">items tracked</p>
                      {s.needsReviewCount > 0 && (
                        <p className="text-xs text-destructive mt-1">{s.needsReviewCount} need verification</p>
                      )}
                    </button>
                  ))}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="font-corp-display text-base">Expiring Soon</CardTitle>
              </CardHeader>
              <CardContent>
                {expiringSoon.length === 0 ? (
                  <p className="text-sm text-muted-foreground">None within 7 days (advisory only).</p>
                ) : (
                  <div className="space-y-2">
                    {expiringSoon.map((item) => (
                      <button
                        key={item.ingredient_id}
                        type="button"
                        onClick={() => navigate('/stock')}
                        className="w-full flex justify-between items-center p-3 bg-card rounded-md border border-border text-left hover:bg-accent transition-colors"
                      >
                        <p className="font-semibold text-foreground">{item.ingredient_name}</p>
                        <p className="text-xs text-destructive">
                          {item.days_until_expiry <= 0 ? 'Expired' : `${item.days_until_expiry}d left`} -- {item.expiry_date}
                        </p>
                      </button>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0">
                <CardTitle className="font-corp-display text-base">Recent Movements</CardTitle>
                <button
                  type="button"
                  className="text-xs text-primary underline underline-offset-2"
                  onClick={() => navigate('/inventory-movements')}
                >
                  View all &rarr;
                </button>
              </CardHeader>
              <CardContent>
                {movements.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No movements logged yet.</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow className={STOCK_TABLE_ROW_CLASS}>
                        <TableHead className={STOCK_TABLE_HEAD_CLASS}>Date</TableHead>
                        <TableHead className={STOCK_TABLE_HEAD_CLASS}>Ingredient</TableHead>
                        <TableHead className={STOCK_TABLE_HEAD_CLASS}>Type</TableHead>
                        <TableHead className={`${STOCK_TABLE_HEAD_CLASS} text-right`}>Quantity</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {movements.map((m) => (
                        <TableRow key={m.id} className={STOCK_TABLE_ROW_CLASS}>
                          <TableCell className={`${STOCK_TABLE_CELL_CLASS} text-muted-foreground`}>
                            {new Date(m.created_at).toLocaleString()}
                          </TableCell>
                          <TableCell className={`${STOCK_TABLE_CELL_CLASS} font-medium`}>
                            {ingredientById.get(m.ingredient_id)?.name || m.ingredient_id.slice(0, 8)}
                          </TableCell>
                          <TableCell className={STOCK_TABLE_CELL_CLASS}>
                            {MOVEMENT_TYPE_LABELS[m.type] || m.type}
                          </TableCell>
                          <TableCell className={`${STOCK_TABLE_CELL_CLASS} text-right`}>{m.quantity}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </DashboardLayout>
  );
}
