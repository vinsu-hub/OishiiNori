import React, { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { DashboardLayout } from '@/components/DashboardLayout';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  ApiDigitalOrder,
  ApiTransaction,
  KitchenStatus,
  TransactionStatus,
  fetchDigitalOrders,
  fetchTransactions,
  voidTransaction,
} from '@/lib/api';
import { formatCurrency } from '@/lib/utils';
import { POLL_INTERVAL_MS } from '@/lib/constants';
import { buildDigitalOrderLookup } from '@/lib/digitalOrderLookup';
import { DigitalOrderInfo } from '@/components/shared/DigitalOrderInfo';

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

export default function OrderQueue() {
  const [transactions, setTransactions] = useState<ApiTransaction[]>([]);
  const [digitalOrderLookup, setDigitalOrderLookup] = useState<Map<string, ApiDigitalOrder>>(new Map());
  const [loading, setLoading] = useState(true);
  const [voidTarget, setVoidTarget] = useState<ApiTransaction | null>(null);
  const [voidReason, setVoidReason] = useState('');
  const [voiding, setVoiding] = useState(false);

  const load = useCallback(() => {
    Promise.all([fetchTransactions(), fetchDigitalOrders('approved')])
      .then(([data, digitalOrders]) => {
        setTransactions([...data].sort((a, b) => b.opened_at.localeCompare(a.opened_at)));
        setDigitalOrderLookup(buildDigitalOrderLookup(digitalOrders));
      })
      .catch((e) => toast.error(`Failed to load orders: ${e instanceof Error ? e.message : 'Unknown error'}`))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [load]);

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
        {loading && <p className="text-sm text-muted-foreground">Loading orders...</p>}
        {!loading && transactions.length === 0 && (
          <p className="text-sm text-muted-foreground">No orders yet.</p>
        )}
        {transactions.map((t) => {
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
