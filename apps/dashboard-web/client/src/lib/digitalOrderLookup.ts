import { ApiDigitalOrder } from '@/lib/api';

// Once a digital (QR-scan) order is approved, digital_orders.transaction_id
// links it to the real sale it became -- but nothing on the transaction
// itself points back. Building this lookup client-side (rather than a
// backend join) keeps table_number/add-on info available to staff without
// a schema change, matching how PendingOrders.tsx already renders the same
// data pre-approval.
export function buildDigitalOrderLookup(orders: ApiDigitalOrder[]): Map<string, ApiDigitalOrder> {
  const map = new Map<string, ApiDigitalOrder>();
  for (const order of orders) {
    if (order.status === 'approved' && order.transaction_id) {
      map.set(order.transaction_id, order);
    }
  }
  return map;
}
