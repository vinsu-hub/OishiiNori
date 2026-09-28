import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { DashboardLayout } from '@/components/DashboardLayout';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Loader2, Printer, Receipt as ReceiptIcon, AlertTriangle, RefreshCw } from 'lucide-react';
import { fetchKitchenPrinterStatus, type KitchenPrinterStatus } from '@/lib/api';
import { formatDateTime12h } from '@/lib/utils';
import { printReceipt, type ReceiptData } from '@/components/pos/Receipt';

const POLL_MS = 15_000;
// The bridge reports every poll cycle (default 20s, kitchen-print-bridge/.env
// POLL_INTERVAL_SECONDS) -- these bands are a few cycles' worth of grace
// before calling it "delayed" or "offline", so one slow cycle doesn't flash red.
const ONLINE_WITHIN_MS = 90_000;
const DELAYED_WITHIN_MS = 5 * 60_000;

function connectionState(lastHeartbeatAt: string | null): { label: string; tone: 'online' | 'delayed' | 'offline' } {
  if (!lastHeartbeatAt) return { label: 'Never connected', tone: 'offline' };
  const ageMs = Date.now() - new Date(lastHeartbeatAt).getTime();
  if (ageMs <= ONLINE_WITHIN_MS) return { label: 'Online', tone: 'online' };
  if (ageMs <= DELAYED_WITHIN_MS) return { label: 'Delayed', tone: 'delayed' };
  return { label: 'Offline', tone: 'offline' };
}

const TONE_CLASSES: Record<string, string> = {
  online: 'bg-green-100 text-green-800 border-green-300',
  delayed: 'bg-amber-100 text-amber-800 border-amber-300',
  offline: 'bg-red-100 text-red-800 border-red-300',
};

// Realistic sample data for the POS receipt test print -- same shape a real
// sale produces, exercised through the exact printReceipt() staff already
// use after a sale, so this tests the real print path, not a lookalike.
const SAMPLE_RECEIPT: ReceiptData = {
  orderNumber: 1042,
  openedAt: new Date().toISOString(),
  orderType: 'dine_in',
  tableNumber: 5,
  lines: [
    { name: 'Oishii Nori Ramen', quantity: 2, unitPrice: 289, addons: [{ name: 'Extra Egg', quantity: 1, unitPrice: 35 }] },
    { name: 'Torikatsu Maki (8pcs)', quantity: 1, unitPrice: 169, addons: [] },
    { name: 'Iced Tea (16oz)', quantity: 3, unitPrice: 75, addons: [] },
  ],
  discountAmount: 50,
  taxAmount: 113.29,
  deliveryFee: 0,
  totalAmount: 957,
  paymentMethod: 'test_print',
  delivery: null,
};

/** Kitchen ticket printer status and the POS receipt printer's test print,
 * in one place. The kitchen bridge runs on a separate on-prem machine next
 * to the XP-58H with no direct network path to this hosted dashboard, so
 * its status here is read-only -- reported by the bridge itself via
 * POST /kitchen-printer/heartbeat, not queried live from here. Configuring
 * or reconfiguring the bridge's port is a local action on that machine
 * (`python bridge.py --setup`), not something this page can do remotely. */
export default function PrinterSetup() {
  const [status, setStatus] = useState<KitchenPrinterStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [testPrinting, setTestPrinting] = useState(false);

  const load = useCallback(() => {
    fetchKitchenPrinterStatus()
      .then(setStatus)
      .catch((err) => toast.error(err instanceof Error ? err.message : 'Failed to load printer status'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, POLL_MS);
    return () => clearInterval(interval);
  }, [load]);

  const state = connectionState(status?.last_heartbeat_at ?? null);

  const handleTestPrint = () => {
    setTestPrinting(true);
    try {
      printReceipt({ ...SAMPLE_RECEIPT, openedAt: new Date().toISOString() });
      toast.success('Sent to the print dialog -- pick your receipt printer there.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to open the print dialog');
    } finally {
      setTestPrinting(false);
    }
  };

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6 max-w-3xl">
        <div>
          <h1 className="text-2xl font-semibold">Printer Setup</h1>
          <p className="text-muted-foreground text-sm">Connection and verification for both printers used in the kitchen and at the register.</p>
        </div>

        <Card>
          <CardHeader className="flex flex-row items-start justify-between gap-4">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Printer className="w-5 h-5" aria-hidden="true" />
                Kitchen Ticket Printer
              </CardTitle>
              <CardDescription>The XP-58H next to the kitchen, driven by kitchen-print-bridge on its own machine.</CardDescription>
            </div>
            <Button variant="outline" size="sm" onClick={load} disabled={loading}>
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
              Refresh
            </Button>
          </CardHeader>
          <CardContent className="space-y-4">
            {loading && !status ? (
              <div className="flex items-center gap-2 text-muted-foreground text-sm">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading status...
              </div>
            ) : (
              <>
                <div className="flex items-center gap-3">
                  <Badge variant="outline" className={TONE_CLASSES[state.tone]}>
                    {state.label}
                  </Badge>
                  <span className="text-sm text-muted-foreground">
                    {status?.last_heartbeat_at
                      ? `Last seen ${formatDateTime12h(status.last_heartbeat_at)}`
                      : "This bridge has never reported in -- it may not be running, or hasn't been configured yet."}
                  </span>
                </div>

                <div className="grid sm:grid-cols-2 gap-4 text-sm">
                  <div>
                    <div className="text-muted-foreground">Last ticket printed</div>
                    <div className="font-medium">
                      {status?.last_print_at
                        ? `#${status.last_print_order_number ?? '?'} · ${formatDateTime12h(status.last_print_at)}`
                        : 'None yet'}
                    </div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">Last error</div>
                    <div className="font-medium">
                      {status?.last_error ? formatDateTime12h(status.last_error_at ?? '') : 'None'}
                    </div>
                  </div>
                </div>

                {status?.last_error && (
                  <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
                    <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
                    <span>{status.last_error}</span>
                  </div>
                )}

                <div className="text-sm text-muted-foreground border-t pt-3">
                  This status is reported by the bridge itself -- this page can't reach that machine
                  directly. To connect, reconfigure, or test the printer's port, run{' '}
                  <code className="rounded bg-muted px-1 py-0.5">python bridge.py --setup</code> on the
                  machine next to the printer (see <code className="rounded bg-muted px-1 py-0.5">kitchen-print-bridge/README.md</code>).
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ReceiptIcon className="w-5 h-5" aria-hidden="true" />
              POS Receipt Printer
            </CardTitle>
            <CardDescription>Prints from this browser's own print dialog after a sale -- there's no persistent connection to check.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              This uses whichever printer is selected in this device's print dialog -- make sure the
              58mm receipt printer is set up as this device's printer (or its default) before relying
              on it during service. Use the button below to send a sample receipt through the exact
              same path a real sale uses.
            </p>
            <Button onClick={handleTestPrint} disabled={testPrinting}>
              {testPrinting ? <Loader2 className="w-4 h-4 animate-spin" /> : <ReceiptIcon className="w-4 h-4" />}
              Print test receipt
            </Button>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
