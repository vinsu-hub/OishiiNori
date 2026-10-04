import React from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useLocation } from 'wouter';
import { Header } from '@/components/Header';
import { Sidebar } from '@/components/Sidebar';
import { ChangePasswordScreen } from '@/components/ChangePasswordScreen';

interface DashboardLayoutProps {
  children: React.ReactNode;
  title?: string;
  headerExtra?: React.ReactNode;
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = React.useState(
    () => typeof window !== 'undefined' && window.matchMedia(query).matches
  );
  React.useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

export function DashboardLayout({ children, title, headerExtra }: DashboardLayoutProps) {
  const { isAuthenticated, loading, user } = useAuth();
  const [, navigate] = useLocation();
  const [mobileNavOpen, setMobileNavOpen] = React.useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = React.useState(
    () => typeof window !== 'undefined' && localStorage.getItem('sidebarCollapsed') === 'true'
  );
  // Tablet widths (the Xiaomi POS/kitchen tablets, especially in portrait):
  // a full 256px sidebar squeezes POS's menu grid and the floor plan to a
  // sliver, so start collapsed to icons there. Tapping the toggle still
  // expands it for this session; the saved desktop preference is untouched.
  const narrow = useMediaQuery('(max-width: 1199px)');
  const [narrowExpanded, setNarrowExpanded] = React.useState(false);
  const effectiveCollapsed = narrow ? !narrowExpanded : sidebarCollapsed;

  React.useEffect(() => {
    if (!loading && !isAuthenticated) {
      navigate('/login');
    }
  }, [isAuthenticated, loading, navigate]);

  const toggleSidebarCollapsed = () => {
    if (narrow) {
      setNarrowExpanded((prev) => !prev);
      return;
    }
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

  // Still on a one-time temporary password: nothing else until it's replaced.
  if (user?.mustChangePassword) {
    return <ChangePasswordScreen />;
  }

  return (
    <div className="flex h-screen bg-background">
      <Sidebar
        collapsed={effectiveCollapsed}
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
