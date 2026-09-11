import React from 'react';
import { DigitalOrdersQueue } from '@/components/shared/DigitalOrdersQueue';

// WS-7 (Phase 6): pickup orders placed through the general (non-table)
// ordering link -- customer picks up in-house, so these never reach the
// rider panel; approving labels the kitchen ticket takeout the same as
// delivery (see digital_menu.py's approve_digital_order).
export default function OnlineOrders() {
  return (
    <DigitalOrdersQueue
      channel="pickup"
      title="Online Orders"
      emptyLabel="No pending online (pickup) orders."
    />
  );
}
