import React from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useSync } from '@/contexts/SyncContext';
import { DEPARTMENT_CONFIG } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { LogOut, Menu, Settings } from 'lucide-react';
import { useLocation } from 'wouter';

interface HeaderProps {
  title?: string;
  onMenuClick?: () => void;
}

export function Header({ title, onMenuClick }: HeaderProps) {
  const { user, logout } = useAuth();
  const { syncStatus } = useSync();
  const [, navigate] = useLocation();

  if (!user) return null;

  const deptConfig = user.department ? DEPARTMENT_CONFIG[user.department] : { name: 'Oishii Nori', color: '#14524B' };

  const getSyncDotColor = () => {
    switch (syncStatus.status) {
      case 'synced':
        return 'bg-success';
      case 'syncing':
        return 'bg-warning animate-pulse';
      case 'offline-queued':
        return 'bg-destructive';
      default:
        return 'bg-muted-foreground';
    }
  };

  return (
    <header className="sticky top-0 z-50 w-full border-b border-border bg-card shadow-none">
      <div className="flex items-center justify-between px-4 py-3 md:px-6">
        <div className="flex items-center gap-3 min-w-0">
          {onMenuClick && (
            <Button
              variant="ghost"
              size="icon-sm"
              className="md:hidden shrink-0"
              onClick={onMenuClick}
              aria-label="Open menu"
            >
              <Menu className="w-5 h-5" />
            </Button>
          )}
          <div
            className="w-8 h-8 rounded-full overflow-hidden flex items-center justify-center shadow-l2-raised"
            style={{ backgroundColor: deptConfig.color }}
          >
            <img src="/logo.jpg" alt="Oishii Nori" className="w-full h-full rounded-full object-cover" />
          </div>
          <div className="min-w-0">
            <h1 className="text-lg font-corp-display font-semibold text-foreground truncate">
              {title || 'Oishii Nori'}
            </h1>
            <p className="text-xs text-muted-foreground capitalize truncate">
              {user.role} &middot; {deptConfig.name}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <div className={`sync-dot ${getSyncDotColor()}`} />
            <span className="text-xs text-muted-foreground hidden sm:inline">
              {syncStatus.status === 'synced' && 'Synced'}
              {syncStatus.status === 'syncing' && 'Syncing...'}
              {syncStatus.status === 'offline-queued' && 'Offline'}
            </span>
          </div>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="gap-2">
                <img src={user.avatar} alt={user.name} className="w-6 h-6 rounded-full" />
                <span className="hidden sm:inline text-sm font-medium">{user.name}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem disabled>
                <span className="text-xs text-muted-foreground">{user.email}</span>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => navigate('/settings')}>
                <Settings className="w-4 h-4 mr-2" />
                Settings
              </DropdownMenuItem>
              <DropdownMenuItem onClick={logout} className="text-destructive">
                <LogOut className="w-4 h-4 mr-2" />
                Logout
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </header>
  );
}
