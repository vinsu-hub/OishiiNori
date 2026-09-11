import React from 'react';
import { DigitalOrdersQueue } from '@/components/shared/DigitalOrdersQueue';

// WS-7 (Phase 6): renamed "Table Orders" in the nav -- this is specifically
// the per-table QR flow now that Delivery Requests / Online Orders exist
// as their own tabs for the other two digital-order channels.
export default function PendingOrders() {
  return (
    <DigitalOrdersQueue
      channel="dine_in_qr"
      title="Table Orders"
      emptyLabel="No pending table (QR) orders."
    />
  );
}
