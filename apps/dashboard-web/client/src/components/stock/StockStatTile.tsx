import type { ReactNode } from 'react';
import { Card, CardContent } from '@/components/ui/card';

type StockStatAccent = 'success' | 'warning' | 'destructive' | 'primary';

const BORDER_CLASSES: Record<StockStatAccent, string> = {
  success: 'border-l-success',
  warning: 'border-l-warning',
  destructive: 'border-l-destructive',
  primary: 'border-l-primary',
};

const VALUE_CLASSES: Record<StockStatAccent, string> = {
  success: 'text-foreground',
  warning: 'text-warning',
  destructive: 'text-destructive',
  primary: 'text-foreground',
};

interface StockStatTileProps {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  accent?: StockStatAccent;
  onClick?: () => void;
}

/**
 * Shared stat-card for the new Stock sub-pages (Overview/Alerts/Variance
 * Log) -- mirrors the border-l-4 stat card pattern already used inline in
 * IngredientsPanel/StationsPanel, extracted here so the new pages don't
 * duplicate it, without touching those two panels' own existing cards.
 */
export function StockStatTile({ label, value, hint, accent = 'primary', onClick }: StockStatTileProps) {
  return (
    <Card
      className={`border-l-4 ${BORDER_CLASSES[accent]} ${onClick ? 'cursor-pointer hover:shadow-l1-hover transition-shadow' : ''}`}
      onClick={onClick}
    >
      <CardContent className="p-4">
        <p className="text-sm text-muted-foreground mb-1">{label}</p>
        <p className={`text-3xl font-bold ${VALUE_CLASSES[accent]}`}>{value}</p>
        {hint && <p className="text-xs text-muted-foreground mt-2">{hint}</p>}
      </CardContent>
    </Card>
  );
}
