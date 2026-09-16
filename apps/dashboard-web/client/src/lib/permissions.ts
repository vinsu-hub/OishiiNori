/**
 * Canonical list of individually-grantable dashboard tabs (profiles.extra_pages).
 *
 * Mirrored exactly in services/api-fastapi/app/permissions.py -- keep both
 * lists in sync when adding/removing a grantable tab. Keys match the
 * dashboard's route paths 1:1.
 *
 * Four keys (command-center, trends, pnl, oishii-ai) are normally
 * executive-only tabs -- the backend restricts who may grant those four
 * (see app/permissions.py's EXECUTIVE_ONLY_GRANTS); this list mirrors that
 * so the checklist UI can grey them out for a non-executive caller too.
 */

export interface GrantablePage {
  key: string;
  label: string;
  group: string;
}

export const GRANTABLE_PAGES: GrantablePage[] = [
  { key: 'pending-orders', label: 'Table Orders', group: 'POS & Orders' },
  { key: 'online-orders', label: 'Online Orders', group: 'POS & Orders' },
  { key: 'stock', label: 'Stock & Inventory (manage)', group: 'Stock & Inventory' },
  { key: 'business-day-report', label: 'Business Day Report', group: 'Business & Finance' },
  { key: 'refund-approval', label: 'Refund Approval', group: 'Business & Finance' },
  { key: 'reviews', label: 'Customer Reviews', group: 'Business & Finance' },
  { key: 'loss-log', label: 'Loss Log', group: 'Business & Finance' },
  { key: 'utility-log', label: 'Utility Log', group: 'Business & Finance' },
  { key: 'pos-management', label: 'POS Management', group: 'Business & Finance' },
  { key: 'employees', label: 'Employees', group: 'HR' },
  { key: 'hr-attendance', label: 'HR Attendance', group: 'HR' },
  { key: 'hr-payroll', label: 'Payroll', group: 'HR' },
  { key: 'hr-holiday-calendar', label: 'Holiday Calendar', group: 'HR' },
  { key: 'hr-payroll-settings', label: 'Payroll Settings', group: 'HR' },
  { key: 'command-center', label: 'Command Center', group: 'Executive Analytics' },
  { key: 'trends', label: 'Trend Analysis', group: 'Executive Analytics' },
  { key: 'pnl', label: 'P&L', group: 'Executive Analytics' },
  { key: 'oishii-ai', label: 'Oishii AI', group: 'Executive Analytics' },
];

export const EXECUTIVE_ONLY_GRANTS = new Set(['command-center', 'trends', 'pnl', 'oishii-ai']);
