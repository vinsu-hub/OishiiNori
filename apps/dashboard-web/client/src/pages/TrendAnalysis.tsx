import { useEffect, useMemo, useState } from 'react';
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import { DashboardLayout } from '@/components/DashboardLayout';
import { useAuth } from '@/contexts/AuthContext';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart';
import { ApiTrendInsights, fetchTrendInsights } from '@/lib/api';
import { daysAgoIsoPH, todayIsoPH } from '@/lib/constants';
import { formatCurrency } from '@/lib/utils';

const chartConfig: ChartConfig = {
  revenue: { label: 'Selected period', color: 'var(--primary)' },
  previous_revenue: { label: 'Previous period', color: 'var(--muted-foreground)' },
};
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const SOURCE: Record<string, string> = { pos: 'POS', qr: 'QR', online: 'Online', grab: 'Grab', unspecified: 'Unspecified' };
const FULFILLMENT: Record<string, string> = { dine_in: 'Dine-in', takeout: 'Pickup / takeout', delivery: 'Delivery', unspecified: 'Unspecified' };

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return <Card><CardHeader><CardTitle className="font-corp-display">{title}</CardTitle>{note && <p className="text-xs text-muted-foreground">{note}</p>}</CardHeader><CardContent>{children}</CardContent></Card>;
}
function DataTable({ headings, rows }: { headings: string[]; rows: (string | number)[][] }) {
  if (!rows.length) return <p className="py-4 text-sm text-muted-foreground">No data in this range.</p>;
  return <div className="max-h-[460px] overflow-auto"><Table><TableHeader><TableRow>{headings.map((heading) => <TableHead key={heading}>{heading}</TableHead>)}</TableRow></TableHeader>
    <TableBody>{rows.map((row, index) => <TableRow key={index}>{row.map((value, cell) => <TableCell key={cell}>{value}</TableCell>)}</TableRow>)}</TableBody></Table></div>;
}
function Delta({ change, previous }: { change: number | null; previous: number }) {
  if (change == null) return <span className="text-xs text-muted-foreground">{previous === 0 ? 'No prior sales' : 'No comparison'}</span>;
  return <span className={change >= 0 ? 'text-xs text-emerald-700' : 'text-xs text-destructive'}>{change >= 0 ? '▲' : '▼'} {Math.abs(change).toFixed(1)}% vs previous period</span>;
}
function Kpi({ title, value, previous, change }: { title: string; value: string; previous: number; change: number | null }) {
  return <Section title={title}><p className="text-2xl font-semibold">{value}</p><Delta change={change} previous={previous} /></Section>;
}
function Mix({ title, rows, labelKey, labels, mode }: { title: string; rows: (ApiTrendInsights['sources'][number] | ApiTrendInsights['fulfillment'][number])[]; labelKey: 'source' | 'fulfillment'; labels: Record<string, string>; mode: 'revenue' | 'orders' }) {
  return <Section title={title}>{!rows.length && <p className="text-sm text-muted-foreground">No sales in this range.</p>}
    <div className="space-y-3">{rows.map((row) => {
      const key = String(labelKey === 'source' ? (row as ApiTrendInsights['sources'][number]).source : (row as ApiTrendInsights['fulfillment'][number]).fulfillment);
      const percent = mode === 'revenue' ? row.revenue_share_pct : row.order_share_pct;
      return <div key={key}><div className="flex justify-between gap-2 text-sm"><span>{labels[key] ?? key}</span><span>{mode === 'revenue' ? formatCurrency(row.revenue) : String(row.order_count) + ' orders'} · {percent.toFixed(1)}%</span></div><div className="mt-1 h-2 rounded bg-muted"><div className="h-2 rounded bg-primary" style={{ width: Math.min(100, percent) + '%' }} /></div></div>;
    })}</div></Section>;
}
function Heatmap({ rows }: { rows: ApiTrendInsights['heatmap'] }) {
  const counts = new Map(rows.map((row) => [row.weekday + ':' + row.hour, row.order_count]));
  const max = Math.max(1, ...rows.map((row) => row.order_count));
  function tone(count: number) {
    if (!count) return 'bg-muted/40';
    if (count / max >= .7) return 'bg-primary text-primary-foreground';
    if (count / max >= .4) return 'bg-primary/65 text-primary-foreground';
    if (count / max >= .15) return 'bg-primary/35';
    return 'bg-primary/15';
  }
  return <Section title="Orders by weekday and hour" note="Philippine time · darker cells had more paid orders"><div className="overflow-x-auto"><div role="grid" aria-label="Paid orders by weekday and hour" className="grid min-w-[530px] gap-1 text-center text-xs" style={{ gridTemplateColumns: '50px repeat(7, minmax(55px, 1fr))' }}>
    <span />{DAYS.map((day) => <span key={day} className="font-semibold">{day}</span>)}
    {Array.from({ length: 24 }, (_, hour) => <div className="contents" key={hour}><span className="self-center text-muted-foreground">{String(hour).padStart(2, '0')}:00</span>{DAYS.map((day, weekday) => {
      const count = counts.get(weekday + ':' + hour) ?? 0;
      const label = day + ' ' + String(hour).padStart(2, '0') + ':00 · ' + count + ' orders';
      return <div key={weekday} role="gridcell" aria-label={label} title={label} className={'rounded py-1.5 ' + tone(count)}>{count || '·'}</div>;
    })}</div>)}
  </div></div></Section>;
}

export default function TrendAnalysisExpanded() {
  const { user } = useAuth();
  const [dateFrom, setDateFrom] = useState(daysAgoIsoPH(29));
  const [dateTo, setDateTo] = useState(todayIsoPH());
  const [data, setData] = useState<ApiTrendInsights | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mixMode, setMixMode] = useState<'revenue' | 'orders'>('revenue');
  const [showAllSizes, setShowAllSizes] = useState(false);
  const rangeError = useMemo(() => {
    if (!dateFrom || !dateTo) return 'Choose both dates.';
    if (dateTo < dateFrom) return 'The end date must be on or after the start date.';
    if (dateTo > todayIsoPH()) return 'Future dates are not available.';
    if ((Date.parse(dateTo + 'T00:00:00Z') - Date.parse(dateFrom + 'T00:00:00Z')) / 86400000 >= 366) return 'Choose up to one year.';
    return null;
  }, [dateFrom, dateTo]);
  useEffect(() => {
    if (rangeError) { setLoading(false); return; }
    let active = true;
    setLoading(true); setError(null);
    fetchTrendInsights(dateFrom, dateTo).then((result) => { if (active) setData(result); })
      .catch((reason) => { if (active) { setData(null); setError(reason instanceof Error ? reason.message : 'Could not load trends'); } })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [dateFrom, dateTo, rangeError]);

  if (user && user.role !== 'executive' && !user.extraPages.includes('trends')) {
    return <DashboardLayout title="Trend Analysis"><p className="p-6 text-sm text-muted-foreground">You don't have access to this page.</p></DashboardLayout>;
  }
  const chartData = data?.daily.map((point) => ({ ...point, label: point.date.slice(5) })) ?? [];
  const shownSizes = showAllSizes ? data?.sizes ?? [] : data?.sizes.slice(0, 30) ?? [];
  return <DashboardLayout title="Trend Analysis"><div className="space-y-5 p-6">
    <div className="flex flex-wrap items-end gap-3"><div className="space-y-1"><Label htmlFor="trends-from">From</Label><Input id="trends-from" type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} /></div><div className="space-y-1"><Label htmlFor="trends-to">To</Label><Input id="trends-to" type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} /></div></div>
    {rangeError && <p role="alert" className="text-sm text-destructive">{rangeError}</p>}
    {loading && <p className="text-sm text-muted-foreground">Loading paid sales trends…</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {!loading && !rangeError && data && <>
      <p className="text-sm text-muted-foreground">Paid, non-voided orders · {data.partial_current_day ? 'today through now' : 'complete days'} · compared with the equally long preceding period.</p>
      <div className="grid gap-4 md:grid-cols-3"><Kpi title="Revenue" value={formatCurrency(data.kpis.revenue)} previous={data.kpis.previous_revenue} change={data.kpis.revenue_change_pct} /><Kpi title="Orders" value={String(data.kpis.order_count)} previous={data.kpis.previous_order_count} change={data.kpis.order_change_pct} /><Kpi title="Avg. order value" value={formatCurrency(data.kpis.average_order_value)} previous={data.kpis.previous_average_order_value} change={data.kpis.average_order_value_change_pct} /></div>
      <Section title="Daily revenue vs previous period"><ChartContainer config={chartConfig} className="h-64 w-full"><BarChart data={chartData}><CartesianGrid vertical={false} /><XAxis dataKey="label" tickLine={false} axisLine={false} /><YAxis tickLine={false} axisLine={false} /><ChartTooltip content={<ChartTooltipContent />} /><Bar dataKey="revenue" fill="var(--color-revenue)" radius={3} /><Bar dataKey="previous_revenue" fill="var(--color-previous_revenue)" radius={3} /></BarChart></ChartContainer></Section>
      <Heatmap rows={data.heatmap} />
      <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-corp-display text-lg font-semibold">Channel mix</h2><div className="flex gap-2"><Button size="sm" variant={mixMode === 'revenue' ? 'default' : 'outline'} onClick={() => setMixMode('revenue')}>Revenue</Button><Button size="sm" variant={mixMode === 'orders' ? 'default' : 'outline'} onClick={() => setMixMode('orders')}>Orders</Button></div></div>
      <div className="grid gap-4 lg:grid-cols-2"><Mix title="Order source" rows={data.sources} labelKey="source" labels={SOURCE} mode={mixMode} /><Mix title="Fulfillment" rows={data.fulfillment} labelKey="fulfillment" labels={FULFILLMENT} mode={mixMode} /></div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Exact menu categories" note="Gross item sales before order-level discounts; delivery fees are not assigned to items."><DataTable headings={['Category', 'Units', 'Gross item sales', 'Share']} rows={data.categories.map((r) => [r.category, r.quantity_sold, formatCurrency(r.gross_item_sales), r.share_pct.toFixed(1) + '%'])} /></Section>
        <Section title="Top product movers" note="Ranked by gross item sales; arrows compare units sold with the previous period."><DataTable headings={['Product', 'Units', 'Change', 'Gross sales']} rows={data.top_products.map((r) => [r.name, r.quantity_sold, r.quantity_change_pct == null ? 'New' : (r.quantity_change_pct >= 0 ? '▲ ' : '▼ ') + Math.abs(r.quantity_change_pct).toFixed(1) + '%', formatCurrency(r.gross_item_sales)])} /></Section>
        <Section title="Slowest sellers" note="Active menu products, including items with zero sales."><DataTable headings={['Product', 'Category', 'Units']} rows={data.slowest_products.map((r) => [r.name, r.category, r.quantity_sold])} /></Section>
        <Section title="Basket pairings" note="Products bought together in the same paid order; each pair counts once per order."><DataTable headings={['Products', 'Orders', 'Share']} rows={data.pairings.map((r) => [r.product_a + ' + ' + r.product_b, r.order_count, r.order_share_pct.toFixed(1) + '%'])} /></Section>
        <Section title="Add-on attach rate" note={data.addon_attach.rate_pct.toFixed(1) + '% of paid orders · ' + data.addon_attach.order_count + ' orders'}><DataTable headings={['Add-on', 'Units', 'Gross sales']} rows={data.addon_attach.addons.map((r) => [r.name, r.quantity, formatCurrency(r.gross_sales)])} /></Section>
        <Section title="Sizes sold" note="Each size's share of its own product's units."><DataTable headings={['Product / size', 'Units', 'Product share']} rows={shownSizes.map((r) => [r.product_name + ' · ' + r.size_label, r.quantity_sold, r.share_of_product_pct.toFixed(1) + '%'])} />{data.sizes.length > 30 && <Button size="sm" variant="link" onClick={() => setShowAllSizes((v) => !v)}>{showAllSizes ? 'Show fewer sizes' : 'Show all ' + data.sizes.length + ' sizes'}</Button>}</Section>
        <Section title="Discount usage" note="Recorded discount amounts exclude any VAT exemption effect."><DataTable headings={['Discount', 'Orders', 'Order share', 'Sales from orders', 'Revenue share', 'Amount off']} rows={data.discounts.map((r) => [r.name, r.order_count, r.order_share_pct.toFixed(1) + '%', formatCurrency(r.order_revenue), r.revenue_share_pct.toFixed(1) + '%', formatCurrency(r.discount_amount)])} /></Section>
        <Section title="Delivery by barangay" note="Paid delivery orders; missing barangays appear as Unspecified."><DataTable headings={['Barangay', 'Orders', 'Revenue']} rows={data.barangays.map((r) => [r.barangay, r.order_count, formatCurrency(r.revenue)])} /></Section>
      </div>
      <Section title="Dine-in and takeout"><div className="flex flex-wrap gap-6 text-sm"><p>Dine-in: <strong>{data.fulfillment.find((r) => r.fulfillment === 'dine_in')?.order_count ?? 0}</strong> orders</p><p>Pickup / takeout: <strong>{data.fulfillment.find((r) => r.fulfillment === 'takeout')?.order_count ?? 0}</strong> orders</p><p>Delivery: <strong>{data.fulfillment.find((r) => r.fulfillment === 'delivery')?.order_count ?? 0}</strong> orders</p></div><p className="mt-2 text-sm">Average dine-in guests: <strong>{data.dine_in_guests.average?.toFixed(1) ?? '—'}</strong> <span className="text-muted-foreground">({data.dine_in_guests.orders_with_count} of {data.dine_in_guests.dine_in_orders} dine-in orders recorded a guest count)</span></p></Section>
    </>}
  </div></DashboardLayout>;
}
