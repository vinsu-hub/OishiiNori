import type { ReactNode } from 'react';

export type StockStatusVariant = 'ok' | 'warning' | 'critical' | 'neutral';

const VARIANT_CLASSES: Record<StockStatusVariant, string> = {
  ok: 'bg-success-bg text-success border-success/30',
  warning: 'bg-warning-bg text-foreground border-warning/50',
  critical: 'bg-error-bg text-destructive border-destructive/30',
  neutral: 'bg-secondary text-secondary-foreground border-border-regular',
};

const DOT_CLASSES: Record<StockStatusVariant, string> = {
  ok: 'bg-success',
  warning: 'bg-warning',
  critical: 'bg-destructive',
  neutral: 'bg-muted-foreground',
};

interface StockStatusBadgeProps {
  variant: StockStatusVariant;
  children: ReactNode;
  className?: string;
}

/**
 * Compact "stamp" style status pill for the Stock subsystem's ruled-sheet
 * tables -- a leading colored dot + uppercase tracked label, recolored onto
 * this app's existing brand tokens (not a fork of components/ui/badge.tsx,
 * so unrelated Badge usages across the app are unaffected).
 */
export function StockStatusBadge({ variant, children, className }: StockStatusBadgeProps) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-sm border px-1.5 py-0.5 text-[10px] font-corp-mono font-semibold uppercase tracking-wide whitespace-nowrap ${VARIANT_CLASSES[variant]} ${className || ''}`}
    >
      <span className={`inline-block w-[5px] h-[5px] rounded-full shrink-0 ${DOT_CLASSES[variant]}`} />
      {children}
    </span>
  );
}
