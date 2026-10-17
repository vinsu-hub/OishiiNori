import React, { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { DashboardLayout } from '@/components/DashboardLayout';
import { useAuth } from '@/contexts/AuthContext';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { ChevronDown, ChevronRight, ChevronUp, ChevronsUpDown, Loader2 } from 'lucide-react';
import { ApiBusinessDay, ApiBusinessDayItemRow, ApiCashExpense, ShiftReport, fetchBusinessDayItems, fetchBusinessDays, fetchCashExpenses, fetchShiftReport } from '@/lib/api';
import { formatCurrency, formatTimestamp12h } from '@/lib/utils';
import { STOCK_TABLE_CELL_CLASS, STOCK_TABLE_HEAD_CLASS, STOCK_TABLE_ROW_CLASS } from '@/components/stock/stockTableStyle';
import { DailyOrderAudit } from '@/components/shared/DailyOrderAudit';

type ItemSortKey = 'product_name' | 'size_label' | 'category' | 'quantity_sold' | 'revenue';

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
  // End-of-day view: category, product subtotal, then every sold size.
  const [grouped, setGrouped] = useState(true);

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
    if (sortKey === 'product_name' || sortKey === 'size_label' || sortKey === 'category') {
      cmp = a[sortKey].localeCompare(b[sortKey]);
    } else {
      cmp = a[sortKey] - b[sortKey];
    }
    return sortDir === 'asc' ? cmp : -cmp;
  });

  if (items.length === 0) {
    return <p className="text-sm text-muted-foreground py-3 px-1">No items sold this day.</p>;
  }

  const groups = (() => {
    const byCategory = new Map<string, ApiBusinessDayItemRow[]>();
    for (const item of items) {
      const key = item.category || 'Uncategorized';
      byCategory.set(key, [...(byCategory.get(key) ?? []), item]);
    }
    return Array.from(byCategory.entries())
      .map(([category, rows]) => {
        const byProduct = new Map<string, ApiBusinessDayItemRow[]>();
        for (const row of rows) byProduct.set(row.product_id, [...(byProduct.get(row.product_id) ?? []), row]);
        const products = Array.from(byProduct.entries()).map(([productId, sizes]) => ({
          productId,
          name: sizes[0].product_name,
          sizes: [...sizes].sort((a, b) => b.quantity_sold - a.quantity_sold || a.size_label.localeCompare(b.size_label)),
          qty: sizes.reduce((sum, row) => sum + row.quantity_sold, 0),
          revenue: sizes.reduce((sum, row) => sum + row.revenue, 0),
        })).sort((a, b) => b.qty - a.qty || a.name.localeCompare(b.name));
        return {
          category, products,
          qty: rows.reduce((sum, r) => sum + r.quantity_sold, 0),
          revenue: rows.reduce((sum, r) => sum + r.revenue, 0),
        };
      })
      .sort((a, b) => a.category.localeCompare(b.category));
  })();

  const toggle = (
    <div className="flex justify-end pb-2">
      <button
        type="button"
        className="min-h-11 rounded-md px-3 text-sm font-medium text-primary underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-pressed={grouped}
        onClick={() => setGrouped((g) => !g)}
      >
        {grouped ? 'Show flat sortable list' : 'Group by category and product'}
      </button>
    </div>
  );

  if (grouped) {
    return (
      <div>
        {toggle}
        <div className="overflow-x-auto rounded-md border">
        <Table aria-label="Items sold by category, product, and size">
          <TableHeader>
            <TableRow className={STOCK_TABLE_ROW_CLASS}>
              <TableHead className={STOCK_TABLE_HEAD_CLASS}>Product</TableHead>
              <TableHead className={STOCK_TABLE_HEAD_CLASS}>Size</TableHead>
              <TableHead className={`${STOCK_TABLE_HEAD_CLASS} text-right`}>Qty sold</TableHead>
              <TableHead className={`${STOCK_TABLE_HEAD_CLASS} text-right`}>Gross item sales</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {groups.map((g) => (
              <React.Fragment key={g.category}>
                <TableRow className={`${STOCK_TABLE_ROW_CLASS} bg-muted/60`}>
                  <TableCell className={`${STOCK_TABLE_CELL_CLASS} font-corp-display font-semibold`}>{g.category}</TableCell>
                  <TableCell className={STOCK_TABLE_CELL_CLASS} />
                  <TableCell className={`${STOCK_TABLE_CELL_CLASS} text-right font-semibold`}>{g.qty}</TableCell>
                  <TableCell className={`${STOCK_TABLE_CELL_CLASS} text-right font-semibold`}>
                    {formatCurrency(g.revenue)}
                  </TableCell>
                </TableRow>
                {g.products.map((product) => (
                  <React.Fragment key={product.productId}>
                    <TableRow className={`${STOCK_TABLE_ROW_CLASS} bg-muted/20`}>
                      <TableCell className={`${STOCK_TABLE_CELL_CLASS} pl-8 font-semibold`}>{product.name}</TableCell>
                      <TableCell className={`${STOCK_TABLE_CELL_CLASS} text-xs text-muted-foreground`}>All sizes</TableCell>
                      <TableCell className={`${STOCK_TABLE_CELL_CLASS} text-right font-semibold`}>{product.qty}</TableCell>
                      <TableCell className={`${STOCK_TABLE_CELL_CLASS} text-right font-semibold`}>{formatCurrency(product.revenue)}</TableCell>
                    </TableRow>
                    {product.sizes.map((item) => (
                      <TableRow key={item.product_size_id} className={STOCK_TABLE_ROW_CLASS}>
                        <TableCell className={`${STOCK_TABLE_CELL_CLASS} pl-12 text-muted-foreground`}>↳</TableCell>
                        <TableCell className={`${STOCK_TABLE_CELL_CLASS} font-medium`}>{item.size_label}</TableCell>
                        <TableCell className={`${STOCK_TABLE_CELL_CLASS} text-right`}>{item.quantity_sold}</TableCell>
                        <TableCell className={`${STOCK_TABLE_CELL_CLASS} text-right`}>{formatCurrency(item.revenue)}</TableCell>
                      </TableRow>
                    ))}
                  </React.Fragment>
                ))}
              </React.Fragment>
            ))}
          </TableBody>
        </Table>
        </div>
      </div>
    );
  }

  const columns: { key: ItemSortKey; label: string; align?: 'right' }[] = [
    { key: 'product_name', label: 'Product' },
    { key: 'size_label', label: 'Size' },
    { key: 'category', label: 'Category' },
    { key: 'quantity_sold', label: 'Qty sold', align: 'right' },
    { key: 'revenue', label: 'Gross item sales', align: 'right' },
  ];

  return (
    <div>
    {toggle}
    <div className="overflow-x-auto rounded-md border">
    <Table aria-label="Items sold sortable list">
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
          <TableRow key={item.product_size_id} className={STOCK_TABLE_ROW_CLASS}>
            <TableCell className={`${STOCK_TABLE_CELL_CLASS} font-medium`}>{item.product_name}</TableCell>
            <TableCell className={STOCK_TABLE_CELL_CLASS}>{item.size_label}</TableCell>
            <TableCell className={STOCK_TABLE_CELL_CLASS}>{item.category}</TableCell>
            <TableCell className={`${STOCK_TABLE_CELL_CLASS} text-right`}>{item.quantity_sold}</TableCell>
            <TableCell className={`${STOCK_TABLE_CELL_CLASS} text-right`}>{formatCurrency(item.revenue)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
    </div>
    </div>
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
  const [expensesByDate, setExpensesByDate] = useState<Record<string, ApiCashExpense[]>>({});
  const [expensesLoading, setExpensesLoading] = useState<string | null>(null);
  const [expensesError, setExpensesError] = useState<Record<string, string>>({});
  const [shiftById, setShiftById] = useState<Record<string, ShiftReport>>({});
  const [shiftError, setShiftError] = useState<Record<string, string>>({});

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

  function toggleExpand(day: ApiBusinessDay) {
    const businessDate = day.business_date;
    if (expandedDate === businessDate) {
      setExpandedDate(null);
      return;
    }
    setExpandedDate(businessDate);
    if (day.closed_at && day.report_version === 1 && !shiftById[day.id]) {
      fetchShiftReport(day.id)
        .then((shift) => setShiftById((prev) => ({ ...prev, [day.id]: shift })))
        .catch((e) => setShiftError((prev) => ({ ...prev, [day.id]: e instanceof Error ? e.message : 'Could not load cash breakdown' })));
    }
    if (!itemsByDate[businessDate]) {
      setItemsLoading(businessDate);
      fetchBusinessDayItems(businessDate)
        .then((res) => setItemsByDate((prev) => ({ ...prev, [businessDate]: res.items })))
        .catch((e) => toast.error(e instanceof Error ? e.message : 'Failed to load items sold'))
        .finally(() => setItemsLoading(null));
    }
    if (!expensesByDate[businessDate]) {
      setExpensesLoading(businessDate);
      fetchCashExpenses(businessDate)
        .then((rows) => {
          setExpensesByDate((prev) => ({ ...prev, [businessDate]: rows }));
          setExpensesError((prev) => { const next = { ...prev }; delete next[businessDate]; return next; });
        })
        .catch((e) => setExpensesError((prev) => ({ ...prev, [businessDate]: e instanceof Error ? e.message : 'Could not load expenses' })))
        .finally(() => setExpensesLoading(null));
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
                    <TableHead className={`${STOCK_TABLE_HEAD_CLASS} text-right`}>Net system total</TableHead>
                    <TableHead className={`${STOCK_TABLE_HEAD_CLASS} text-right`}>Expenses</TableHead>
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
                          onClick={() => toggleExpand(d)}
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
                          <TableCell className={`${STOCK_TABLE_CELL_CLASS} text-right`}>
                            {formatCurrency(d.expenses_total)}
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
                            <TableCell colSpan={8} className="bg-muted/30 p-3">
                              {d.report_version === 1 && <div className="mb-5 rounded-md border bg-background p-3 text-sm">
                                <p className="mb-2 font-semibold">Shift cash and payment breakdown</p>
                                {shiftError[d.id] ? <p role="alert" className="text-destructive">{shiftError[d.id]}</p> : !shiftById[d.id] ? <p>Loading shift breakdown…</p> : <>
                                  <div className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
                                    <p>Cash payments: {formatCurrency(shiftById[d.id].cash_drawer.cash_payments)}</p>
                                    <p>Operating expenses: {formatCurrency(shiftById[d.id].cash_drawer.operating_expenses)}</p>
                                    <p>Expected drawer cash: {formatCurrency(shiftById[d.id].cash_drawer.expected_cash)}</p>
                                    <p className="font-bold">Actual counted cash: {shiftById[d.id].cash_drawer.actual_cash != null ? formatCurrency(shiftById[d.id].cash_drawer.actual_cash!) : 'Awaiting executive count'}</p>
                                    <p>Drawer difference: {shiftById[d.id].cash_drawer.difference != null ? formatCurrency(shiftById[d.id].cash_drawer.difference!) : '--'}</p>
                                    {Object.entries(shiftById[d.id].payments).map(([method, value]) => <p key={method}>{method === 'Grab' ? 'Grab settlement' : method}: {formatCurrency(value)}</p>)}
                                  </div>
                                  <p className="mt-2 text-xs text-muted-foreground">Grab settlement and other digital payments are outside the cash drawer.</p>
                                </>}
                              </div>}
                              <p className="text-xs font-medium text-muted-foreground mb-1 px-1">
                                Items sold by product and size · {d.business_date} · all non-voided orders, including unpaid
                              </p>
                              {itemsLoading === d.business_date ? (
                                <div className="flex items-center justify-center py-4 text-muted-foreground">
                                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                                  Loading...
                                </div>
                              ) : (
                                <BusinessDayItemsTable items={itemsByDate[d.business_date] ?? []} />
                              )}
                              <div className="mt-5 border-t pt-4">
                                <p className="mb-2 text-sm font-semibold">Register expenses · {formatCurrency(d.expenses_total)}</p>
                                {expensesLoading === d.business_date ? <p className="text-sm text-muted-foreground">Loading expenses…</p>
                                  : expensesError[d.business_date] ? <p role="alert" className="text-sm text-destructive">{expensesError[d.business_date]}</p>
                                  : (expensesByDate[d.business_date] ?? []).length === 0 ? <p className="text-sm text-muted-foreground">No register expenses recorded.</p>
                                  : <div className="overflow-x-auto"><Table aria-label={`Register expenses for ${d.business_date}`}><TableHeader><TableRow><TableHead>Time</TableHead><TableHead>Expense / purpose</TableHead><TableHead>Recorded by</TableHead><TableHead className="text-right">Amount</TableHead></TableRow></TableHeader><TableBody>
                                    {expensesByDate[d.business_date].map((row) => <TableRow key={row.id}><TableCell>{formatTimestamp12h(row.created_at)}</TableCell><TableCell>{row.description}</TableCell><TableCell>{row.recorded_by_name ?? 'Unknown staff'}</TableCell><TableCell className="text-right">{formatCurrency(row.amount)}</TableCell></TableRow>)}
                                  </TableBody></Table></div>}
                              </div>
                              <div className="mt-5"><DailyOrderAudit date={d.business_date} /></div>
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
