import React, { createContext, useContext, useState, useEffect } from 'react';
import { SyncStatus } from '@/lib/types';

interface SyncContextType {
  syncStatus: SyncStatus;
  setSyncStatus: (status: SyncStatus) => void;
}

const SyncContext = createContext<SyncContextType | undefined>(undefined);

export function SyncProvider({ children }: { children: React.ReactNode }) {
  const [syncStatus, setSyncStatus] = useState<SyncStatus>({
    status: 'synced',
    lastSyncTime: new Date(),
    pendingChanges: 0,
  });

  // Simulate periodic sync checks
  useEffect(() => {
    const interval = setInterval(() => {
      setSyncStatus((prev) => ({
        ...prev,
        lastSyncTime: new Date(),
      }));
    }, 30000); // Sync every 30 seconds

    return () => clearInterval(interval);
  }, []);

  return (
    <SyncContext.Provider value={{ syncStatus, setSyncStatus }}>
      {children}
    </SyncContext.Provider>
  );
}

export function useSync() {
  const context = useContext(SyncContext);
  if (context === undefined) {
    throw new Error('useSync must be used within a SyncProvider');
  }
  return context;
}
