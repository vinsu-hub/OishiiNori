/**
 * Shared class-name constants for the Stock subsystem's "ruled sheet" table
 * look -- denser padding, an uppercase tracked mono header label. Applied
 * via existing components/ui/table.tsx cells' className prop; deliberately
 * not a fork of that shared component, so unrelated tables elsewhere in the
 * app are unaffected.
 */
export const STOCK_TABLE_HEAD_CLASS =
  'text-[10.5px] font-corp-mono font-semibold uppercase tracking-wider text-muted-foreground py-2';

export const STOCK_TABLE_ROW_CLASS = 'border-b border-border-regular last:border-b-0';

export const STOCK_TABLE_CELL_CLASS = 'font-corp-body py-2.5';
