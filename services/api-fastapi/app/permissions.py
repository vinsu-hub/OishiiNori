"""Canonical list of individually-grantable dashboard tabs (profiles.extra_pages).

Mirrored exactly in apps/dashboard-web/client/src/lib/permissions.ts -- keep
both lists in sync when adding/removing a grantable tab. Keys match the
dashboard's route paths 1:1 so they read the same in the UI checklist, the
API payload, and require_role_or_grant() call sites.

Four keys (command-center, trends, pnl, oishii-ai) are normally
executive-only tabs -- granting one of these to a non-executive is a bigger
step up than granting a manager-tier tab, so app/routers/hr.py restricts who
may hand those four out (see _EXECUTIVE_ONLY_GRANTS there).
"""

GRANTABLE_PAGES: dict[str, str] = {
    "pending-orders": "Table Orders",
    "online-orders": "Online Orders",
    "stock": "Stock & Inventory (manage)",
    "business-day-report": "Business Day Report",
    "refund-approval": "Refund Approval",
    "reviews": "Customer Reviews",
    "loss-log": "Loss Log",
    "utility-log": "Utility Log",
    "pos-management": "POS Management",
    "employees": "Employees",
    "hr-attendance": "HR Attendance",
    "hr-payroll": "Payroll",
    "hr-holiday-calendar": "Holiday Calendar",
    "hr-payroll-settings": "Payroll Settings",
    "command-center": "Command Center",
    "trends": "Trend Analysis",
    "pnl": "P&L",
    "oishii-ai": "Oishii AI",
}

EXECUTIVE_ONLY_GRANTS: frozenset[str] = frozenset({"command-center", "trends", "pnl", "oishii-ai"})
