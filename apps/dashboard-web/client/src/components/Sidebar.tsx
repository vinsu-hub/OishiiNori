import React, { useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useInventoryAlerts } from '@/contexts/InventoryAlertsContext';
import { useLocation, useSearch } from 'wouter';
import { DEPARTMENT_CONFIG } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  ShoppingCart,
  ListOrdered,
  QrCode,
  CalendarCheck,
  ChefHat,
  Package,
  Boxes,
  Warehouse,
  ClipboardList,
  Bell,
  ListChecks,
  AlertCircle,
  Zap,
  Users,
  Wallet,
  CalendarDays,
  Percent,
  LayoutDashboard,
  TrendingUp,
  Sparkles,
  Truck,
  UtensilsCrossed,
  DollarSign,
  Settings,
  HelpCircle,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  X,
} from 'lucide-react';

interface SidebarProps {
  collapsed: boolean;
  onToggleCollapse: () => void;
  mobileOpen: boolean;
  onCloseMobile: () => void;
}

interface NavItem {
  icon: typeof Package;
  label: string;
  href: string;
  badge?: number;
}

export function Sidebar({ collapsed, onToggleCollapse, mobileOpen, onCloseMobile }: SidebarProps) {
  const { user } = useAuth();
  const { lowStockCount } = useInventoryAlerts();
  const [location, navigate] = useLocation();
  const search = useSearch();

  // Persisted independently of the overall sidebar collapsed/expanded state
  // (a different concern -- whether the Stock group's own children are
  // shown). Mirrors DashboardLayout's sidebarCollapsed persistence pattern.
  const [stockGroupOpen, setStockGroupOpen] = useState(
    () => typeof window === 'undefined' || localStorage.getItem('stockNavGroupOpen') !== 'false'
  );

  if (!user) return null;

  const deptConfig = user.department ? DEPARTMENT_CONFIG[user.department] : { name: 'Oishii Nori', color: '#D42A2A' };
  const isManagerOrExecutive = user.role === 'manager' || user.role === 'executive';
  const isExecutive = user.role === 'executive';

  const handleStockGroupOpenChange = (open: boolean) => {
    setStockGroupOpen(open);
    localStorage.setItem('stockNavGroupOpen', String(open));
  };

  // Ingredient Stock / Station Items are both the /stock route, split by a
  // ?tab= query param -- Stock.tsx reads this reactively (not just on
  // mount), so these two links correctly switch tabs even when /stock is
  // already the active page. Legacy /inventory-count and /stock-count paths
  // still resolve to the same component and are treated as aliases here too.
  const stationsQueryActive = new URLSearchParams(search).get('tab') === 'stations';
  const isOverviewActive = location === '/stock/overview';
  const isRecipeIngredientsActive = (location === '/stock' && !stationsQueryActive) || location === '/inventory-count';
  const isStationItemsActive = (location === '/stock' && stationsQueryActive) || location === '/stock-count';
  const isReceiveShipmentActive = location === '/inventory-movements';
  const isAlertsActive = location === '/stock/alerts';
  const isVarianceLogActive = location === '/stock/variance-log';
  const isStockFamilyActive =
    isOverviewActive ||
    isRecipeIngredientsActive ||
    isStationItemsActive ||
    isReceiveShipmentActive ||
    isAlertsActive ||
    isVarianceLogActive;

  const stockChildren: (NavItem & { isActive: boolean })[] = [
    ...(isManagerOrExecutive
      ? [{ icon: ClipboardList, label: 'Overview', href: '/stock/overview', isActive: isOverviewActive }]
      : []),
    { icon: Package, label: 'Ingredient Stock', href: '/stock', isActive: isRecipeIngredientsActive },
    { icon: Boxes, label: 'Station Items', href: '/stock?tab=stations', isActive: isStationItemsActive },
    { icon: Truck, label: 'Receive Shipment', href: '/inventory-movements', isActive: isReceiveShipmentActive },
    ...(isManagerOrExecutive
      ? [{ icon: Bell, label: 'Alerts', href: '/stock/alerts', isActive: isAlertsActive, badge: lowStockCount }]
      : []),
    ...(isManagerOrExecutive
      ? [{ icon: ListChecks, label: 'Variance Log', href: '/stock/variance-log', isActive: isVarianceLogActive }]
      : []),
  ];

  // WS-11 strict role isolation: a cashier (employee) sidebar is exactly
  // POS · Order Queue · Kitchen Display · Reservations · Settings ·
  // Menu Editing · Help. Pending Orders, the whole Stock & Inventory group,
  // Loss Log, and Utility Log move to manager+; Menu Editing and Help open
  // to every role (client decision -- cashiers may edit the menu).
  const beforeStockItems: NavItem[] = [
    { icon: ShoppingCart, label: 'POS Terminal', href: '/pos' },
    { icon: ListOrdered, label: 'Order Queue', href: '/order-queue' },
    ...(isManagerOrExecutive ? [{ icon: QrCode, label: 'Pending Orders', href: '/pending-orders' }] : []),
    { icon: ChefHat, label: 'Kitchen Display', href: '/kitchen-display' },
    { icon: CalendarCheck, label: 'Reservations', href: '/reservations' },
  ];

  const afterStockItems: NavItem[] = [
    ...(isManagerOrExecutive
      ? [
          { icon: AlertCircle, label: 'Loss Log', href: '/loss-log' },
          { icon: Zap, label: 'Utility Log', href: '/utility-log' },
          { icon: Percent, label: 'POS Management', href: '/pos-management' },
          { icon: Users, label: 'Employees', href: '/employees' },
          { icon: Users, label: 'HR Attendance', href: '/hr/attendance' },
          { icon: Wallet, label: 'Payroll', href: '/hr/payroll' },
          { icon: CalendarDays, label: 'Holiday Calendar', href: '/hr/holiday-calendar' },
          { icon: Wallet, label: 'Payroll Settings', href: '/hr/payroll-settings' },
        ]
      : []),
    ...(isExecutive
      ? [
          { icon: LayoutDashboard, label: 'Command Center', href: '/command-center' },
          { icon: TrendingUp, label: 'Trend Analysis', href: '/trends' },
          { icon: DollarSign, label: 'P&L', href: '/pnl' },
          { icon: Sparkles, label: 'Oishii AI', href: '/oishii-ai' },
        ]
      : []),
    { icon: UtensilsCrossed, label: 'Menu Editing', href: '/menu-editing' },
    { icon: HelpCircle, label: 'Help', href: '/help' },
    { icon: Settings, label: 'Settings', href: '/settings' },
  ];

  const renderNavButton = (item: NavItem, isActive: boolean, isCollapsed: boolean, onNavigate: (href: string) => void) => {
    const Icon = item.icon;
    return (
      <Button
        key={item.href}
        variant={isActive ? 'default' : 'ghost'}
        title={isCollapsed ? item.label : undefined}
        className={`w-full mb-1 ${isCollapsed ? 'justify-center px-0' : 'justify-start gap-3'} ${
          isActive ? '' : 'text-foreground shadow-none hover:bg-accent'
        }`}
        onClick={() => onNavigate(item.href)}
      >
        <Icon className="w-4 h-4 shrink-0" />
        {!isCollapsed && <span className="font-corp-body text-sm">{item.label}</span>}
        {!isCollapsed && !!item.badge && item.badge > 0 && (
          <Badge variant="destructive" className="text-xs px-1.5 py-0 ml-auto">
            {item.badge}
          </Badge>
        )}
      </Button>
    );
  };

  const renderStockGroup = (isCollapsed: boolean, onNavigate: (href: string) => void) => {
    if (isCollapsed) {
      // No inline flyout submenu exists anywhere in this app today -- the
      // whole group collapses to one icon-only button linking straight to
      // /stock (today's highest-frequency page), same muscle memory as
      // before this group existed.
      return (
        <Button
          variant={isStockFamilyActive ? 'default' : 'ghost'}
          title="Stock & Inventory"
          className={`w-full mb-1 justify-center px-0 relative ${
            isStockFamilyActive ? '' : 'text-foreground shadow-none hover:bg-accent'
          }`}
          onClick={() => onNavigate('/stock')}
        >
          <Warehouse className="w-4 h-4 shrink-0" />
          {lowStockCount > 0 && (
            <span className="absolute top-1 right-1.5 w-2 h-2 rounded-full bg-destructive" />
          )}
        </Button>
      );
    }

    const effectiveOpen = stockGroupOpen || isStockFamilyActive;

    return (
      <Collapsible open={effectiveOpen} onOpenChange={handleStockGroupOpenChange} className="mb-1">
        <CollapsibleTrigger asChild>
          <button type="button" className="w-full flex items-center gap-2 px-2 pt-2 pb-1">
            <Warehouse className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              Stock &amp; Inventory
            </span>
            {lowStockCount > 0 && (
              <Badge variant="destructive" className="text-xs px-1.5 py-0">
                {lowStockCount}
              </Badge>
            )}
            <ChevronDown
              className={`w-3.5 h-3.5 text-muted-foreground ml-auto transition-transform ${effectiveOpen ? 'rotate-180' : ''}`}
            />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent className="pl-3">
          {stockChildren.map((item) => renderNavButton(item, item.isActive, false, onNavigate))}
        </CollapsibleContent>
      </Collapsible>
    );
  };

  const renderSidebar = (isCollapsed: boolean, onNavigate: (href: string) => void) => {
    return (
      <>
        <div className={`p-4 border-b border-border flex items-center gap-3 ${isCollapsed ? 'justify-center px-2' : ''}`}>
          <div
            className="w-10 h-10 shrink-0 rounded-full overflow-hidden flex items-center justify-center shadow-l2-raised"
            style={{ backgroundColor: deptConfig.color }}
            title={isCollapsed ? deptConfig.name : undefined}
          >
            <img src="/logo.jpg" alt="Oishii Nori" className="w-full h-full rounded-full object-cover" />
          </div>
          {!isCollapsed && (
            <div className="min-w-0">
              <h2 className="text-sm font-corp-display font-semibold text-foreground truncate">Oishii Nori</h2>
              <p className="text-xs text-muted-foreground capitalize">
                {user.role} &middot; {deptConfig.name}
              </p>
            </div>
          )}
        </div>

        <nav className="flex-1 overflow-y-auto overflow-x-hidden p-2">
          {beforeStockItems.map((item) => renderNavButton(item, location === item.href, isCollapsed, onNavigate))}
          {isManagerOrExecutive && renderStockGroup(isCollapsed, onNavigate)}
          {afterStockItems.map((item) => renderNavButton(item, location === item.href, isCollapsed, onNavigate))}
        </nav>

        {!isCollapsed && (
          <div className="p-4 border-t border-border text-xs text-muted-foreground font-corp-body">
            <p>Oishii Nori Command Suite</p>
            <p>v1.0.0</p>
          </div>
        )}
      </>
    );
  };

  return (
    <>
      <aside
        className={`hidden md:flex flex-col bg-sidebar border-r border-sidebar-border transition-[width] duration-200 relative ${
          collapsed ? 'w-20' : 'w-64'
        }`}
      >
        {renderSidebar(collapsed, (href) => navigate(href))}
        <Button
          variant="outline"
          size="icon-sm"
          onClick={onToggleCollapse}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className="absolute -right-3 top-16 rounded-full bg-card shadow-l2-raised"
        >
          {collapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
        </Button>
      </aside>

      {mobileOpen && (
        <div className="fixed inset-0 z-[60] bg-black/50 md:hidden" onClick={onCloseMobile}>
          <aside
            className="absolute left-0 top-0 bottom-0 w-64 bg-sidebar flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex justify-end p-2">
              <Button variant="ghost" size="icon-sm" onClick={onCloseMobile} aria-label="Close menu">
                <X className="w-5 h-5" />
              </Button>
            </div>
            {renderSidebar(false, (href) => {
              navigate(href);
              onCloseMobile();
            })}
          </aside>
        </div>
      )}
    </>
  );
}
