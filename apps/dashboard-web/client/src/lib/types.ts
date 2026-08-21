/**
 * Oishii Nori Command Suite -- Shared frontend types.
 *
 * Single physical location, two departments (kitchen, cafe) -- no branch
 * concept anywhere (locked Phase 0 scope decision). Where the SMFC
 * reference this app is ported from used a per-branch theme, this app
 * uses a per-department theme instead.
 */

export type Department = 'kitchen' | 'cafe';
export type Role = 'employee' | 'manager' | 'executive';

export interface User {
  id: string;
  name: string;
  email: string;
  department: Department | null;
  role: Role;
  avatar?: string;
}

export const DEPARTMENT_CONFIG: Record<Department, { name: string; color: string }> = {
  kitchen: { name: 'Kitchen', color: '#5C0F10' },
  cafe: { name: 'Cafe', color: '#FFC93C' },
};

export interface SyncStatus {
  status: 'synced' | 'syncing' | 'offline-queued';
  lastSyncTime?: Date;
  pendingChanges: number;
}

export const LOSS_REASONS = [
  { value: 'spoilage', label: 'Spoilage' },
  { value: 'breakage', label: 'Breakage' },
  { value: 'comp', label: 'Complimentary' },
  { value: 'prep_error', label: 'Prep Error' },
  { value: 'shrinkage', label: 'Shrinkage' },
];
