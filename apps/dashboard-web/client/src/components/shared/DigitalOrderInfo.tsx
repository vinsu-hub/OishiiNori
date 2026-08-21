import React from 'react';
import { Badge } from '@/components/ui/badge';
import { ApiDigitalOrder } from '@/lib/api';

interface DigitalOrderInfoProps {
  order: ApiDigitalOrder;
}

// Shown on Order Queue / Kitchen Display for a transaction that started as
// a QR-scan digital-menu order -- surfaces the table number and any
// add-ons, which otherwise vanish once the order becomes a plain
// transaction (held ingredients don't need this: they're a real field on
// transaction_items now, shown uniformly regardless of a sale's origin).
export function DigitalOrderInfo({ order }: DigitalOrderInfoProps) {
  return (
    <div className="space-y-1">
      <Badge variant="gold">QR order &middot; Table {order.table_number}</Badge>
      {order.addons.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {order.addons.map((a) => `${a.quantity}x ${a.addon_name || 'Add-on'}`).join(', ')}
        </p>
      )}
    </div>
  );
}
