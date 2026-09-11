import React from 'react';
import { DigitalOrdersQueue } from '@/components/shared/DigitalOrdersQueue';

// WS-7 (Phase 6): delivery orders placed through the general (non-table)
// ordering link. Approving hands the order to the rider panel (WS-8) once
// it's a real transaction.
export default function DeliveryRequests() {
  return (
    <DigitalOrdersQueue
      channel="delivery"
      title="Delivery Requests"
      emptyLabel="No pending delivery requests."
    />
  );
}
