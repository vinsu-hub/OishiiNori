import React, { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { DashboardLayout } from '@/components/DashboardLayout';
import { useAuth } from '@/contexts/AuthContext';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { ChevronDown, ChevronRight, ChevronUp, ChevronsUpDown, Loader2 } from 'lucide-react';
import { ApiBusinessDay, ApiBusinessDayItemRow, fetchBusinessDayItems, fetchBusinessDays } from '@/lib/api';
import { formatCurrency } from '@/lib/utils';
import { STOCK_TABLE_CELL_CLASS, STOCK_TABLE_HEAD_CLASS, STOCK_TABLE_ROW_CLASS } from '@/components/stock/stockTableStyle';

type ItemSortKey = 'product_name' | 'category' | 'quantity_sold' | 'revenue';

function SortIcon({ active, dir }: { active: boolean; dir: 'asc' | 'desc' }) {
  if (!active) return <ChevronsUpDown className="w-3.5 h-3.5 text-muted-foreground/40" />;
  return dir === 'asc' ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />;
}

// Total-items-sold drill-down for one expanded business day -- product /
// category / qty sold / revenue, sortable by clicking any column header
// (mirrors the sortable-column convention this project used on the old
// Inventory Count sheet: click to sort ascending, click again to flip).
function BusinessDayItemsTable({ items }: { items: ApiBusinessDayItemRow[] }) {
  const [sortKey, setSortKey] = useState<ItemSortKey>('category');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  function handleSort(key: ItemSortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  }

  const sorted = [...items].sort((a, b) => {
    let cmp: number;
    if (sortKey === 'product_name' || sortKey === 'category') {
      cmp = a[sortKey].localeCompare(b[sortKey]);
    } else {
      cmp = a[sortKey] - b[sortKey];
    }
    return sortDir === 'asc' ? cmp : -cmp;
  });

  if (items.length === 0) {
    return <p className="text-sm text-muted-foreground py-3 px-1">No items sold this day.</p>;
  }

  const columns: { key: ItemSortKey; label: string; align?: 'right' }[] = [
    { key: 'product_name', label: 'Product' },
    { key: 'category', label: 'Category' },
    { key: 'quantity_sold', label: 'Qty sold', align: 'right' },
    { key: 'revenue', label: 'Revenue', align: 'right' },
  ];

  return (
    <Table>
      <TableHeader>
        <TableRow className={STOCK_TABLE_ROW_CLASS}>
          {columns.map((col) => (
            <TableHead
              key={col.key}
              className={`${STOCK_TABLE_HEAD_CLASS} cursor-pointer select-none ${col.align === 'right' ? 'text-right' : ''}`}
              onClick={() => handleSort(col.key)}
            >
              <span
                className={`inline-flex items-center gap-1 ${col.align === 'right' ? 'flex-row-reverse' : ''}`}
              >
                {col.label}
                <SortIcon active={sortKey === col.key} dir={sortDir} />
              </span>
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {sorted.map((item) => (
          <TableRow key={item.product_id} className={STOCK_TABLE_ROW_CLASS}>
            <TableCell className={`${STOCK_TABLE_CELL_CLASS} font-medium`}>{item.product_name}</TableCell>
            <TableCell className={STOCK_TABLE_CELL_CLASS}>{item.category}</TableCell>
            <TableCell className={`${STOCK_TABLE_CELL_CLASS} text-right`}>{item.quantity_sold}</TableCell>
            <TableCell className={`${STOCK_TABLE_CELL_CLASS} text-right`}>{formatCurrency(item.revenue)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

// WS-13: register-vs-system close-out review -- manager/executive only.
// The cashier-facing endpoints never return cash_register_total/
// system_eod_total at all (see BusinessDayStatusOut on the backend); this
// page is the one place those numbers, and their variance, are visible.
export default function BusinessDayReport() {
  const { user } = useAuth();
  const [days, setDays] = useState<ApiBusinessDay[]>([]);
  const [loading, setLoading] = useState(true);

  // Total items sold -- an expandable per-day drill-down rather than a
  // separate always-on section, so item data is only fetched for days a
  // reviewer actually opens. itemsByDate caches per date so re-toggling a
  // row doesn't re-fetch.
  const [expandedDate, setExpandedDate] = useState<string | null>(null);
  const [itemsByDate, setItemsByDate] = useState<Record<string, ApiBusinessDayItemRow[]>>({});
  const [itemsLoading, setItemsLoading] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    fetchBusinessDays()
      .then(setDays)
      .catch((e) => toast.error(e instanceof Error ? e.message : 'Failed to load business day report'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function toggleExpand(businessDate: string) {
    if (expandedDate === businessDate) {
      setExpandedDate(null);
      return;
    }
    setExpandedDate(businessDate);
    if (!itemsByDate[businessDate]) {
      setItemsLoading(businessDate);
      fetchBusinessDayItems(businessDate)
        .then((res) => setItemsByDate((prev) => ({ ...prev, [businessDate]: res.items })))
        .catch((e) => toast.error(e instanceof Error ? e.message : 'Failed to load items sold'))
        .finally(() => setItemsLoading(null));
    }
  }

  if (user && user.role === 'employee' && !user.extraPages.includes('business-day-report')) {
    return (
      <DashboardLayout title="Business Day Report">
        <div className="p-6">
          <p className="text-sm text-muted-foreground">You don't have access to this page.</p>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout title="Business Day Report">
      <div className="p-6 space-y-4">
        <Card>
          <CardHeader>
            <CardTitle className="font-corp-display text-base">
              {loading ? 'Loading...' : `${days.length} business day${days.length === 1 ? '' : 's'}`}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="flex items-center justify-center py-8 text-muted-foreground">
                <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                Loading...
              </div>
            ) : days.length === 0 ? (
              <p className="text-sm text-muted-foreground py-8 text-center">No business days recorded yet.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className={STOCK_TABLE_ROW_CLASS}>
                    <TableHead className={`${STOCK_TABLE_HEAD_CLASS} w-8`} />
                    <TableHead className={STOCK_TABLE_HEAD_CLASS}>Date</TableHead>
                    <TableHead className={STOCK_TABLE_HEAD_CLASS}>Status</TableHead>
                    <TableHead className={STOCK_TABLE_HEAD_CLASS}>Menu confirmed</TableHead>
                    <TableHead className={`${STOCK_TABLE_HEAD_CLASS} text-right`}>Register total</TableHead>
                    <TableHead className={`${STOCK_TABLE_HEAD_CLASS} text-right`}>System total</TableHead>
                    <TableHead className={`${STOCK_TABLE_HEAD_CLASS} text-right`}>Variance</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {days.map((d) => {
                    const expanded = expandedDate === d.business_date;
                    return (
                      <React.Fragment key={d.id}>
                        <TableRow
                          className={`${STOCK_TABLE_ROW_CLASS} cursor-pointer`}
                          onClick={() => toggleExpand(d.business_date)}
                        >
                          <TableCell className={STOCK_TABLE_CELL_CLASS}>
                            {expanded ? (
                              <ChevronDown className="w-4 h-4 text-muted-foreground" />
                            ) : (
                              <ChevronRight className="w-4 h-4 text-muted-foreground" />
                            )}
                          </TableCell>
                          <TableCell className={`${STOCK_TABLE_CELL_CLASS} font-medium`}>{d.business_date}</TableCell>
                          <TableCell className={STOCK_TABLE_CELL_CLASS}>
                            <Badge variant={d.closed_at ? 'secondary' : 'default'}>
                              {d.closed_at ? 'Closed' : 'Open'}
                            </Badge>
                          </TableCell>
                          <TableCell className={STOCK_TABLE_CELL_CLASS}>
                            {d.menu_confirmed ? (
                              <Badge variant="secondary">Yes</Badge>
                            ) : (
                              <Badge variant="destructive">No</Badge>
                            )}
                          </TableCell>
                          <TableCell className={`${STOCK_TABLE_CELL_CLASS} text-right`}>
                            {d.cash_register_total != null ? formatCurrency(d.cash_register_total) : '--'}
                          </TableCell>
                          <TableCell className={`${STOCK_TABLE_CELL_CLASS} text-right`}>
                            {d.system_eod_total != null ? formatCurrency(d.system_eod_total) : '--'}
                          </TableCell>
                          <TableCell
                            className={`${STOCK_TABLE_CELL_CLASS} text-right font-semibold ${
                              d.variance != null && Math.abs(d.variance) > 0.01 ? 'text-destructive' : ''
                            }`}
                          >
                            {d.variance != null ? formatCurrency(d.variance) : '--'}
                          </TableCell>
                        </TableRow>
                        {expanded && (
                          <TableRow className={STOCK_TABLE_ROW_CLASS}>
                            <TableCell colSpan={7} className="bg-muted/30 p-3">
                              <p className="text-xs font-medium text-muted-foreground mb-1 px-1">
                                Total items sold -- {d.business_date}
                              </p>
                              {itemsLoading === d.business_date ? (
                                <div className="flex items-center justify-center py-4 text-muted-foreground">
                                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                                  Loading...
                                </div>
                              ) : (
                                <BusinessDayItemsTable items={itemsByDate[d.business_date] ?? []} />
                              )}
                            </TableCell>
                          </TableRow>
                        )}
                      </React.Fragment>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
