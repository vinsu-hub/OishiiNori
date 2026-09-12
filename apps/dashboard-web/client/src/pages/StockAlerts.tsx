import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation } from 'wouter';
import { toast } from 'sonner';
import { DashboardLayout } from '@/components/DashboardLayout';
import { useAuth } from '@/contexts/AuthContext';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Loader2 } from 'lucide-react';
import {
  ApiExpiringIngredient,
  ApiIngredient,
  ApiStockItem,
  StockStation,
  fetchExpiringSoon,
  fetchInventory,
  fetchStockItems,
} from '@/lib/api';
import { StockStatusBadge, StockStatusVariant } from '@/components/stock/StockStatusBadge';
import { STOCK_TABLE_CELL_CLASS, STOCK_TABLE_HEAD_CLASS, STOCK_TABLE_ROW_CLASS } from '@/components/stock/stockTableStyle';

const STATION_LABELS: Record<StockStation, string> = {
  tako_snack: 'Tako / Snack',
  cafe_drinks: 'Cafe / Drinks',
  sushi_kitchen_main: 'Sushi-Kitchen Main',
  ramen_hot_line: 'Ramen / Hot Line',
};

type AlertType = 'low_stock' | 'expiring' | 'verify';
type AlertSource = 'Recipe Ingredient' | 'Station Item';

interface AlertRow {
  key: string;
  itemName: string;
  type: AlertType;
  typeLabel: string;
  variant: StockStatusVariant;
  detail: string;
  source: AlertSource;
  actionHref: string;
}

const VARIANT_RANK: Record<StockStatusVariant, number> = { critical: 0, warning: 1, ok: 2, neutral: 3 };
const TYPE_LABELS: Record<AlertType, string> = { low_stock: 'Low Stock', expiring: 'Expiring', verify: 'Verify Needed' };

export default function StockAlerts() {
  const { user } = useAuth();
  const [, navigate] = useLocation();

  const [days, setDays] = useState(7);
  const [ingredients, setIngredients] = useState<ApiIngredient[]>([]);
  const [stockItems, setStockItems] = useState<ApiStockItem[]>([]);
  const [expiringSoon, setExpiringSoon] = useState<ApiExpiringIngredient[]>([]);
  const [loading, setLoading] = useState(true);

  const [typeFilter, setTypeFilter] = useState<'all' | AlertType>('all');
  const [sourceFilter, setSourceFilter] = useState<'all' | AlertSource>('all');
  const [search, setSearch] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([fetchInventory(), fetchStockItems({ active_only: true }), fetchExpiringSoon(days)])
      .then(([ing, items, expiring]) => {
        setIngredients(ing);
        setStockItems(items);
        setExpiringSoon(expiring);
      })
      .catch((e) => toast.error(`Failed to load alerts: ${e.message}`))
      .finally(() => setLoading(false));
  }, [days]);

  useEffect(() => {
    load();
  }, [load]);

  // Computed client-side from the full, uncapped ingredient/stock-item lists
  // (rather than /inventory/low-stock-summary, which the sidebar badge caps
  // its detail arrays at 10 each) so this page shows every real alert, not
  // just a preview.
  const rows = useMemo<AlertRow[]>(() => {
    const out: AlertRow[] = [];
    for (const ing of ingredients) {
      if (ing.current_stock <= ing.reorder_threshold) {
        out.push({
          key: `low-ing-${ing.id}`,
          itemName: ing.name,
          type: 'low_stock',
          typeLabel: TYPE_LABELS.low_stock,
          variant: 'critical',
          detail: `${ing.current_stock} ${ing.base_unit} on hand, threshold ${ing.reorder_threshold} ${ing.base_unit}`,
          source: 'Recipe Ingredient',
          actionHref: '/stock',
        });
      }
      if (ing.needs_review) {
        out.push({
          key: `verify-ing-${ing.id}`,
          itemName: ing.name,
          type: 'verify',
          typeLabel: TYPE_LABELS.verify,
          variant: 'neutral',
          detail: 'Flagged for review',
          source: 'Recipe Ingredient',
          actionHref: '/stock',
        });
      }
    }
    for (const item of stockItems) {
      if (item.reorder_threshold != null && item.current_stock <= item.reorder_threshold) {
        out.push({
          key: `low-item-${item.id}`,
          itemName: item.name,
          type: 'low_stock',
          typeLabel: TYPE_LABELS.low_stock,
          variant: 'critical',
          detail: `${item.current_stock} ${item.unit || ''} on hand, threshold ${item.reorder_threshold} ${item.unit || ''} -- ${STATION_LABELS[item.station]}`,
          source: 'Station Item',
          actionHref: `/stock?tab=stations&station=${item.station}`,
        });
      }
      if (item.needs_review) {
        out.push({
          key: `verify-item-${item.id}`,
          itemName: item.name,
          type: 'verify',
          typeLabel: TYPE_LABELS.verify,
          variant: 'neutral',
          detail: `Station: ${STATION_LABELS[item.station]}`,
          source: 'Station Item',
          actionHref: `/stock?tab=stations&station=${item.station}`,
        });
      }
    }
    for (const exp of expiringSoon) {
      const expired = exp.days_until_expiry <= 0;
      out.push({
        key: `expiring-${exp.ingredient_id}`,
        itemName: exp.ingredient_name,
        type: 'expiring',
        typeLabel: expired ? 'Expired' : TYPE_LABELS.expiring,
        variant: expired ? 'critical' : 'warning',
        detail: expired ? `Expired ${exp.expiry_date}` : `${exp.days_until_expiry}d left (${exp.expiry_date})`,
        source: 'Recipe Ingredient',
        actionHref: '/stock',
      });
    }
    return out;
  }, [ingredients, stockItems, expiringSoon]);

  const filteredRows = rows
    .filter((r) => typeFilter === 'all' || r.type === typeFilter)
    .filter((r) => sourceFilter === 'all' || r.source === sourceFilter)
    .filter((r) => r.itemName.toLowerCase().includes(search.trim().toLowerCase()))
    .sort((a, b) => VARIANT_RANK[a.variant] - VARIANT_RANK[b.variant] || a.itemName.localeCompare(b.itemName));

  if (user && user.role === 'employee' && !user.extraPages.includes('stock')) {
    return (
      <DashboardLayout title="Stock Alerts">
        <div className="p-6">
          <p className="text-sm text-muted-foreground">You don't have access to this page.</p>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout title="Stock Alerts">
      <div className="p-6 space-y-4">
        <Card>
          <CardHeader>
            <CardTitle className="font-corp-display text-base">
              {loading ? 'Loading...' : `${filteredRows.length} of ${rows.length} alert${rows.length === 1 ? '' : 's'}`}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Type</label>
                <Select value={typeFilter} onValueChange={(v) => setTypeFilter(v as 'all' | AlertType)}>
                  <SelectTrigger className="w-44">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All types</SelectItem>
                    <SelectItem value="low_stock">Low Stock</SelectItem>
                    <SelectItem value="expiring">Expiring</SelectItem>
                    <SelectItem value="verify">Verify Needed</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Source</label>
                <Select value={sourceFilter} onValueChange={(v) => setSourceFilter(v as 'all' | AlertSource)}>
                  <SelectTrigger className="w-48">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All sources</SelectItem>
                    <SelectItem value="Recipe Ingredient">Recipe Ingredient</SelectItem>
                    <SelectItem value="Station Item">Station Item</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Expiring window</label>
                <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
                  <SelectTrigger className="w-28">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="3">3 days</SelectItem>
                    <SelectItem value="7">7 days</SelectItem>
                    <SelectItem value="14">14 days</SelectItem>
                    <SelectItem value="30">30 days</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1 flex-1 min-w-[160px]">
                <label className="text-xs text-muted-foreground">Search item</label>
                <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search..." />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            {loading ? (
              <div className="flex items-center justify-center py-8 text-muted-foreground">
                <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                Loading alerts...
              </div>
            ) : filteredRows.length === 0 ? (
              <p className="text-sm text-muted-foreground py-8 text-center">
                {rows.length === 0 ? 'No open alerts -- everything is in good shape.' : 'No alerts match these filters.'}
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className={STOCK_TABLE_ROW_CLASS}>
                    <TableHead className={STOCK_TABLE_HEAD_CLASS}>Item</TableHead>
                    <TableHead className={STOCK_TABLE_HEAD_CLASS}>Type</TableHead>
                    <TableHead className={STOCK_TABLE_HEAD_CLASS}>Detail</TableHead>
                    <TableHead className={STOCK_TABLE_HEAD_CLASS}>Source</TableHead>
                    <TableHead className={STOCK_TABLE_HEAD_CLASS} />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredRows.map((row) => (
                    <TableRow key={row.key} className={STOCK_TABLE_ROW_CLASS}>
                      <TableCell className={`${STOCK_TABLE_CELL_CLASS} font-medium`}>{row.itemName}</TableCell>
                      <TableCell className={STOCK_TABLE_CELL_CLASS}>
                        <StockStatusBadge variant={row.variant}>{row.typeLabel}</StockStatusBadge>
                      </TableCell>
                      <TableCell className={`${STOCK_TABLE_CELL_CLASS} text-muted-foreground`}>{row.detail}</TableCell>
                      <TableCell className={`${STOCK_TABLE_CELL_CLASS} text-muted-foreground`}>{row.source}</TableCell>
                      <TableCell className={STOCK_TABLE_CELL_CLASS}>
                        <Button size="sm" variant="outline" onClick={() => navigate(row.actionHref)}>
                          Count now
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
