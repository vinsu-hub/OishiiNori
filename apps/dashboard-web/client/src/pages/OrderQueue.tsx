import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { DashboardLayout } from '@/components/DashboardLayout';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Volume2, VolumeX } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  ApiDigitalOrder,
  ApiProduct,
  ApiTransaction,
  KitchenStatus,
  TransactionStatus,
  fetchDigitalOrders,
  fetchProducts,
  fetchTransactions,
  voidTransaction,
} from '@/lib/api';
import { formatCurrency } from '@/lib/utils';
import { POLL_INTERVAL_MS, todayIsoPH } from '@/lib/constants';
import { buildDigitalOrderLookup } from '@/lib/digitalOrderLookup';
import { DigitalOrderInfo } from '@/components/shared/DigitalOrderInfo';
import { playOrderReadyBeep } from '@/lib/orderSounds';

type BadgeVariant = 'default' | 'secondary' | 'destructive' | 'outline' | 'gold';

const STATUS_VARIANT: Record<TransactionStatus, BadgeVariant> = {
  open: 'default',
  closed: 'secondary',
  voided: 'destructive',
};

const KITCHEN_STATUS_VARIANT: Record<KitchenStatus, BadgeVariant> = {
  queued: 'outline',
  preparing: 'secondary',
  ready: 'gold',
  completed: 'default',
};

// Conflates transactions.status and kitchen_status into one dropdown,
// matching SMFC's own StatusFilter -- the two are disjoint value sets
// (open/closed/voided vs queued/preparing/ready/completed) so a single
// union is unambiguous. date + a transactions.status value filter
// server-side (the backend already supports both); a kitchen_status value
// has no backend param and filters client-side after fetch.
type StatusFilterValue = 'all' | TransactionStatus | KitchenStatus;

const TRANSACTION_STATUS_VALUES: TransactionStatus[] = ['open', 'closed', 'voided'];
const KITCHEN_STATUS_VALUES: KitchenStatus[] = ['queued', 'preparing', 'ready', 'completed'];

const PAGE_SIZE = 10;

export default function OrderQueue() {
  const [transactions, setTransactions] = useState<ApiTransaction[]>([]);
  const [products, setProducts] = useState<ApiProduct[]>([]);
  const [digitalOrderLookup, setDigitalOrderLookup] = useState<Map<string, ApiDigitalOrder>>(new Map());
  const [loading, setLoading] = useState(true);
  const [voidTarget, setVoidTarget] = useState<ApiTransaction | null>(null);
  const [voidReason, setVoidReason] = useState('');
  const [voiding, setVoiding] = useState(false);

  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilterValue>('all');
  const [dateFilter, setDateFilter] = useState(todayIsoPH());
  const [sortOrder, setSortOrder] = useState<'newest' | 'oldest'>('newest');
  const [page, setPage] = useState(1);
  const [soundOn, setSoundOn] = useState(true);
  const seenReadyIdsRef = useRef<Set<string> | null>(null);

  useEffect(() => {
    fetchProducts(true)
      .then(setProducts)
      .catch((e) => toast.error(`Failed to load products: ${e instanceof Error ? e.message : 'Unknown error'}`));
  }, []);

  const load = useCallback(() => {
    const transactionStatusParam = (TRANSACTION_STATUS_VALUES as string[]).includes(statusFilter)
      ? (statusFilter as TransactionStatus)
      : undefined;
    Promise.all([
      fetchTransactions({ date: dateFilter || undefined, status: transactionStatusParam }),
      fetchDigitalOrders('approved'),
    ])
      .then(([data, digitalOrders]) => {
        setTransactions(data);
        setDigitalOrderLookup(buildDigitalOrderLookup(digitalOrders));

        // Chime on any order newly seen in "ready" -- skip the very first
        // load (ref starts null) so opening the page doesn't chime for
        // every already-ready order.
        const readyIds = new Set(data.filter((t) => t.kitchen_status === 'ready').map((t) => t.id));
        if (seenReadyIdsRef.current) {
          const isNew = Array.from(readyIds).some((id) => !seenReadyIdsRef.current!.has(id));
          if (isNew && soundOn) playOrderReadyBeep();
        }
        seenReadyIdsRef.current = readyIds;
      })
      .catch((e) => toast.error(`Failed to load orders: ${e instanceof Error ? e.message : 'Unknown error'}`))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateFilter, statusFilter, soundOn]);

  useEffect(() => {
    load();
    const interval = setInterval(load, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [load]);

  useEffect(() => {
    setPage(1);
  }, [searchQuery, statusFilter, dateFilter, sortOrder]);

  const productNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of products) {
      for (const size of p.sizes) {
        map.set(size.id, p.name);
      }
    }
    return map;
  }, [products]);

  const filteredTransactions = useMemo(() => {
    let list = transactions;
    if ((KITCHEN_STATUS_VALUES as string[]).includes(statusFilter)) {
      list = list.filter((t) => t.kitchen_status === statusFilter);
    }
    const q = searchQuery.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (t) =>
          t.id.toLowerCase().includes(q) ||
          t.items.some((i) => (productNameById.get(i.product_size_id) || '').toLowerCase().includes(q))
      );
    }
    const sorted = [...list].sort((a, b) =>
      sortOrder === 'newest' ? b.opened_at.localeCompare(a.opened_at) : a.opened_at.localeCompare(b.opened_at)
    );
    return sorted;
  }, [transactions, statusFilter, searchQuery, productNameById, sortOrder]);

  const totalPages = Math.max(1, Math.ceil(filteredTransactions.length / PAGE_SIZE));
  const pageTransactions = filteredTransactions.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  async function handleVoid() {
    if (!voidTarget) return;
    if (!voidReason.trim()) {
      toast.error('A void reason is required');
      return;
    }
    setVoiding(true);
    try {
      await voidTransaction(voidTarget.id, voidReason.trim());
      toast.success('Order voided');
      setVoidTarget(null);
      setVoidReason('');
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to void order');
    } finally {
      setVoiding(false);
    }
  }

  return (
    <DashboardLayout title="Order Queue">
      <div className="p-6 space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Search</label>
            <Input
              placeholder="Order id or item name"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-48"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Status</label>
            <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as StatusFilterValue)}>
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="open">Open</SelectItem>
                <SelectItem value="closed">Closed</SelectItem>
                <SelectItem value="voided">Voided</SelectItem>
                <SelectItem value="queued">Kitchen: Queued</SelectItem>
                <SelectItem value="preparing">Kitchen: Preparing</SelectItem>
                <SelectItem value="ready">Kitchen: Ready</SelectItem>
                <SelectItem value="completed">Kitchen: Completed</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Date</label>
            <Input type="date" value={dateFilter} onChange={(e) => setDateFilter(e.target.value)} className="w-40" />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Sort</label>
            <Select value={sortOrder} onValueChange={(v) => setSortOrder(v as 'newest' | 'oldest')}>
              <SelectTrigger className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="newest">Newest first</SelectItem>
                <SelectItem value="oldest">Oldest first</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button
            size="icon"
            variant="outline"
            onClick={() => setSoundOn((v) => !v)}
            aria-label={soundOn ? 'Mute order-ready sound' : 'Unmute order-ready sound'}
            title={soundOn ? 'Mute order-ready sound' : 'Unmute order-ready sound'}
          >
            {soundOn ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}
          </Button>
        </div>

        {loading && <p className="text-sm text-muted-foreground">Loading orders...</p>}
        {!loading && filteredTransactions.length === 0 && (
          <p className="text-sm text-muted-foreground">No orders match these filters.</p>
        )}
        {pageTransactions.map((t) => {
          const digitalOrder = digitalOrderLookup.get(t.id);
          const heldIngredients = Array.from(new Set(t.items.flatMap((i) => i.held_ingredients)));
          return (
          <Card key={t.id}>
            <CardContent className="py-3 flex items-center justify-between">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs text-muted-foreground">{t.id.slice(0, 8)}</span>
                  <Badge variant={STATUS_VARIANT[t.status]}>{t.status}</Badge>
                  <Badge variant={KITCHEN_STATUS_VARIANT[t.kitchen_status]}>{t.kitchen_status}</Badge>
                  {t.is_owner_request && <Badge variant="secondary">Owner's Request</Badge>}
                </div>
                <p className="text-sm text-muted-foreground">
                  {t.items.length} item{t.items.length === 1 ? '' : 's'} -- opened{' '}
                  {new Date(t.opened_at).toLocaleTimeString()}
                </p>
                {(t.discount_amount > 0 || t.tax_amount > 0) && (
                  <p className="text-xs text-muted-foreground">
                    {t.discount_amount > 0 && <>Discount: -{formatCurrency(t.discount_amount)} </>}
                    {t.tax_amount > 0 && <>Tax: {formatCurrency(t.tax_amount)}</>}
                  </p>
                )}
                {heldIngredients.length > 0 && (
                  <p className="text-xs text-destructive">-- hold: {heldIngredients.join(', ')}</p>
                )}
                {digitalOrder && <DigitalOrderInfo order={digitalOrder} />}
              </div>
              <div className="flex items-center gap-3">
                <span className="font-semibold">{formatCurrency(t.total_amount)}</span>
                {t.status === 'open' && (
                  <Button variant="destructive" size="sm" onClick={() => setVoidTarget(t)}>
                    Void
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
          );
        })}

        {!loading && totalPages > 1 && (
          <div className="flex items-center justify-center gap-2 pt-2">
            <Button size="sm" variant="outline" disabled={page === 1} onClick={() => setPage((p) => p - 1)}>
              Prev
            </Button>
            {Array.from({ length: totalPages }, (_, i) => i + 1).map((n) => (
              <Button
                key={n}
                size="sm"
                variant={n === page ? 'default' : 'outline'}
                onClick={() => setPage(n)}
              >
                {n}
              </Button>
            ))}
            <Button size="sm" variant="outline" disabled={page === totalPages} onClick={() => setPage((p) => p + 1)}>
              Next
            </Button>
          </div>
        )}
      </div>

      <Dialog open={!!voidTarget} onOpenChange={(open) => !open && setVoidTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Void order {voidTarget?.id.slice(0, 8)}</DialogTitle>
          </DialogHeader>
          <Input
            placeholder="Reason for voiding"
            value={voidReason}
            onChange={(e) => setVoidReason(e.target.value)}
          />
          <DialogFooter>
            <Button variant="destructive" disabled={voiding} onClick={handleVoid}>
              {voiding ? 'Voiding...' : 'Confirm void'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
}
