import React from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useLocation } from 'wouter';
import { Header } from '@/components/Header';
import { Sidebar } from '@/components/Sidebar';

interface DashboardLayoutProps {
  children: React.ReactNode;
  title?: string;
  headerExtra?: React.ReactNode;
}

export function DashboardLayout({ children, title, headerExtra }: DashboardLayoutProps) {
  const { isAuthenticated, loading } = useAuth();
  const [, navigate] = useLocation();
  const [mobileNavOpen, setMobileNavOpen] = React.useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = React.useState(
    () => typeof window !== 'undefined' && localStorage.getItem('sidebarCollapsed') === 'true'
  );

  React.useEffect(() => {
    if (!loading && !isAuthenticated) {
      navigate('/login');
    }
  }, [isAuthenticated, loading, navigate]);

  const toggleSidebarCollapsed = () => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem('sidebarCollapsed', String(next));
      return next;
    });
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-center">
          <div className="w-12 h-12 border-4 border-border-regular border-t-primary rounded-full animate-spin mx-auto mb-4" />
          <p className="text-muted-foreground font-corp-body">Loading...</p>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return null;
  }

  return (
    <div className="flex h-screen bg-background">
      <Sidebar
        collapsed={sidebarCollapsed}
        onToggleCollapse={toggleSidebarCollapsed}
        mobileOpen={mobileNavOpen}
        onCloseMobile={() => setMobileNavOpen(false)}
      />
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        <Header title={title} onMenuClick={() => setMobileNavOpen(true)} extra={headerExtra} />
        <main className="flex-1 overflow-auto">{children}</main>
      </div>
    </div>
  );
}
