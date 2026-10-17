import { useEffect, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { AlertTriangle } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { fetchPendingCashCounts, type PendingCashCount } from '@/lib/api';

// Checked once per page visit and remembered briefly: this is a one-off
// notice, not a live board, so it stays off the polling budget.
const CACHE_MS = 2 * 60_000;
let cached: { at: number; rows: PendingCashCount[] } | null = null;

export function clearPendingCashCountCache() {
  cached = null;
}

/** Tells executives a shift was closed by an End-of-Day override and its drawer cash still needs to be entered. */
export function PendingCashCountBanner() {
  const { user } = useAuth();
  const [location] = useLocation();
  const [rows, setRows] = useState<PendingCashCount[]>(cached?.rows ?? []);
  const isExecutive = user?.role === 'executive';

  useEffect(() => {
    if (!isExecutive) return;
    if (cached && Date.now() - cached.at < CACHE_MS) { setRows(cached.rows); return; }
    let live = true;
    fetchPendingCashCounts()
      .then((result) => { cached = { at: Date.now(), rows: result }; if (live) setRows(result); })
      .catch(() => {});
    return () => { live = false; };
  }, [isExecutive, location]);

  if (!isExecutive || !rows.length || location === '/shift-reports') return null;
  return (
    <div role="alert" className="flex flex-wrap items-center gap-2 border-b border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-950">
      <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
      <span>
        End-of-Day cash count needed for {rows.map((row) => row.business_date).join(', ')}. The shift was closed by the system after an outage.
      </span>
      <Link href="/shift-reports" className="font-semibold underline underline-offset-2">Enter cash count</Link>
    </div>
  );
}
