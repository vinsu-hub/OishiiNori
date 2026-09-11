import React from 'react';
import { Badge } from '@/components/ui/badge';
import { ApiDigitalOrder } from '@/lib/api';

interface DigitalOrderInfoProps {
  order: ApiDigitalOrder;
}

// Shown on Order Queue / Kitchen Display for a transaction that started as
// a digital-menu order (QR table scan, or the general delivery/pickup
// link) -- surfaces the origin + any add-ons, which otherwise vanish once
// the order becomes a plain transaction (held ingredients don't need this:
// they're a real field on transaction_items now, shown uniformly
// regardless of a sale's origin). Delivery/pickup orders are also always
// order_type='takeout' on the transaction itself (see digital_menu.py's
// approve_digital_order), so kitchen packaging is unambiguous even without
// this badge.
export function DigitalOrderInfo({ order }: DigitalOrderInfoProps) {
  const label =
    order.order_channel === 'delivery'
      ? 'Delivery'
      : order.order_channel === 'pickup'
        ? 'Online Order (Pickup)'
        : `QR order · Table ${order.table_number}`;
  return (
    <div className="space-y-1">
      <Badge variant="gold">{label}</Badge>
      {order.delivery && (
        <p className="text-xs text-muted-foreground">
          {order.delivery.customer_name} &middot; {order.delivery.customer_phone}
        </p>
      )}
      {order.addons.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {order.addons.map((a) => `${a.quantity}x ${a.addon_name || 'Add-on'}`).join(', ')}
        </p>
      )}
    </div>
  );
}
