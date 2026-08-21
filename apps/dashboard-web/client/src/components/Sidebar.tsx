import React from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useLocation } from 'wouter';
import { DEPARTMENT_CONFIG } from '@/lib/types';
import { Button } from '@/components/ui/button';
import {
  ShoppingCart,
  ListOrdered,
  QrCode,
  ChefHat,
  Package,
  AlertCircle,
  Truck,
  Zap,
  Users,
  Wallet,
  CalendarDays,
  Settings,
  ChevronLeft,
  ChevronRight,
  X,
} from 'lucide-react';

interface SidebarProps {
  collapsed: boolean;
  onToggleCollapse: () => void;
  mobileOpen: boolean;
  onCloseMobile: () => void;
}

export function Sidebar({ collapsed, onToggleCollapse, mobileOpen, onCloseMobile }: SidebarProps) {
  const { user } = useAuth();
  const [location, navigate] = useLocation();

  if (!user) return null;

  const deptConfig = user.department ? DEPARTMENT_CONFIG[user.department] : { name: 'Oishii Nori', color: '#D42A2A' };
  const isManagerOrExecutive = user.role === 'manager' || user.role === 'executive';

  const navItems = [
    { icon: ShoppingCart, label: 'POS Terminal', href: '/pos' },
    { icon: ListOrdered, label: 'Order Queue', href: '/order-queue' },
    { icon: QrCode, label: 'Pending Orders', href: '/pending-orders' },
    { icon: ChefHat, label: 'Kitchen Display', href: '/kitchen-display' },
    { icon: Package, label: 'Inventory Count', href: '/inventory-count' },
    { icon: AlertCircle, label: 'Loss Log', href: '/loss-log' },
    { icon: Truck, label: 'Inventory Movements', href: '/inventory-movements' },
    { icon: Zap, label: 'Utility Log', href: '/utility-log' },
    ...(isManagerOrExecutive
      ? [
          { icon: Users, label: 'Employees', href: '/employees' },
          { icon: Users, label: 'HR Attendance', href: '/hr/attendance' },
          { icon: Wallet, label: 'Payroll', href: '/hr/payroll' },
          { icon: CalendarDays, label: 'Holiday Calendar', href: '/hr/holiday-calendar' },
          { icon: Wallet, label: 'Payroll Settings', href: '/hr/payroll-settings' },
        ]
      : []),
    { icon: Settings, label: 'Settings', href: '/settings' },
  ];

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
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = location === item.href;

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
              </Button>
            );
          })}
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
