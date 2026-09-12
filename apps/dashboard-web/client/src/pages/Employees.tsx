import React, { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { DashboardLayout } from '@/components/DashboardLayout';
import { useAuth } from '@/contexts/AuthContext';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  ApiEmployee,
  ApiEmployeeCreated,
  Department,
  UserRole,
  createEmployee,
  deleteEmployee,
  fetchEmployees,
  setEmployeeActive,
  setEmployeePin,
} from '@/lib/api';

export default function Employees() {
  const { user } = useAuth();
  const [employees, setEmployees] = useState<ApiEmployee[]>([]);
  const [loading, setLoading] = useState(true);

  const [addOpen, setAddOpen] = useState(false);
  const [fullName, setFullName] = useState('');
  const [role, setRole] = useState<UserRole>('employee');
  const [department, setDepartment] = useState<Department | 'none'>('none');
  const [position, setPosition] = useState('');
  const [payRate, setPayRate] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [created, setCreated] = useState<ApiEmployeeCreated | null>(null);

  const [pinTarget, setPinTarget] = useState<ApiEmployee | null>(null);
  const [pin, setPin] = useState('');
  const [settingPin, setSettingPin] = useState(false);

  const [activeToggleTarget, setActiveToggleTarget] = useState<ApiEmployee | null>(null);
  const [togglingActive, setTogglingActive] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<ApiEmployee | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(() => {
    fetchEmployees()
      .then((data) => setEmployees([...data].sort((a, b) => (a.full_name || '').localeCompare(b.full_name || ''))))
      .catch((e) => toast.error(`Failed to load employees: ${e.message}`))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (user && user.role === 'employee') {
    return (
      <DashboardLayout title="Employees">
        <div className="p-6">
          <p className="text-sm text-muted-foreground">You don't have access to this page.</p>
        </div>
      </DashboardLayout>
    );
  }

  function resetAddForm() {
    setFullName('');
    setRole('employee');
    setDepartment('none');
    setPosition('');
    setPayRate('');
  }

  async function handleCreate() {
    if (!fullName.trim()) {
      toast.error('Full name is required');
      return;
    }
    setSubmitting(true);
    try {
      const result = await createEmployee({
        full_name: fullName.trim(),
        role,
        department: department === 'none' ? undefined : department,
        position: position.trim() || undefined,
        pay_rate: payRate.trim() ? Number(payRate) : undefined,
      });
      setAddOpen(false);
      resetAddForm();
      setCreated(result);
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to create employee');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSetPin() {
    if (!pinTarget) return;
    if (!/^\d{4,8}$/.test(pin)) {
      toast.error('PIN must be 4-8 digits');
      return;
    }
    setSettingPin(true);
    try {
      await setEmployeePin(pinTarget.id, pin);
      toast.success(`PIN updated for ${pinTarget.full_name}`);
      setPinTarget(null);
      setPin('');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to set PIN');
    } finally {
      setSettingPin(false);
    }
  }

  async function handleToggleActive() {
    if (!activeToggleTarget) return;
    const nextActive = !activeToggleTarget.active;
    setTogglingActive(true);
    try {
      await setEmployeeActive(activeToggleTarget.id, nextActive);
      toast.success(`${activeToggleTarget.full_name} ${nextActive ? 'reactivated' : 'deactivated'}`);
      setActiveToggleTarget(null);
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to update employee status');
    } finally {
      setTogglingActive(false);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deleteEmployee(deleteTarget.id);
      toast.success(`${deleteTarget.full_name} deleted`);
      setDeleteTarget(null);
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to delete employee');
    } finally {
      setDeleting(false);
    }
  }

  return (
    <DashboardLayout title="Employees">
      <div className="p-6 space-y-4">
        <div className="flex justify-end">
          <Button onClick={() => setAddOpen(true)}>Add employee</Button>
        </div>

        {loading && <p className="text-sm text-muted-foreground">Loading employees...</p>}
        {!loading && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Department</TableHead>
                <TableHead>Position</TableHead>
                <TableHead>Pay Rate</TableHead>
                <TableHead>Employee #</TableHead>
                <TableHead>Status</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {employees.map((e) => (
                <TableRow key={e.id} className={e.active ? '' : 'opacity-60'}>
                  <TableCell className="font-medium">{e.full_name || '--'}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className="capitalize">
                      {e.role}
                    </Badge>
                  </TableCell>
                  <TableCell className="capitalize">{e.department || '--'}</TableCell>
                  <TableCell>{e.position || '--'}</TableCell>
                  <TableCell>{e.pay_rate.toFixed(2)}</TableCell>
                  <TableCell className="font-mono text-xs">{e.employee_number || '--'}</TableCell>
                  <TableCell>
                    <Badge variant={e.active ? 'outline' : 'destructive'}>
                      {e.active ? 'Active' : 'Inactive'}
                    </Badge>
                  </TableCell>
                  <TableCell className="space-x-2 whitespace-nowrap">
                    <Button size="sm" variant="outline" onClick={() => setPinTarget(e)}>
                      Set PIN
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setActiveToggleTarget(e)}>
                      {e.active ? 'Deactivate' : 'Reactivate'}
                    </Button>
                    {user?.role === 'executive' && (
                      <Button size="sm" variant="destructive" onClick={() => setDeleteTarget(e)}>
                        Delete
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      {/* Add employee */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add employee</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>Full name</Label>
              <Input value={fullName} onChange={(e) => setFullName(e.target.value)} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>Role</Label>
                <Select value={role} onValueChange={(v) => setRole(v as UserRole)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="employee">Employee</SelectItem>
                    <SelectItem value="manager">Manager</SelectItem>
                    <SelectItem value="executive">Executive</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>Department</Label>
                <Select value={department} onValueChange={(v) => setDepartment(v as Department | 'none')}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">None</SelectItem>
                    <SelectItem value="kitchen">Kitchen</SelectItem>
                    <SelectItem value="cafe">Cafe</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>Position</Label>
                <Input value={position} onChange={(e) => setPosition(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label>Pay rate (per hour)</Label>
                <Input type="number" min={0} step="0.01" value={payRate} onChange={(e) => setPayRate(e.target.value)} />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button disabled={submitting} onClick={handleCreate}>
              {submitting ? 'Creating...' : 'Create employee'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* One-time credentials */}
      <Dialog open={!!created} onOpenChange={(open) => !open && setCreated(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Employee created</DialogTitle>
            <DialogDescription>
              These credentials are shown once and cannot be retrieved again -- share them with {created?.full_name} now.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1 text-sm font-mono bg-muted rounded-md p-3">
            <p>Email: {created?.email}</p>
            <p>Password: {created?.default_password}</p>
            <p>Kiosk PIN: {created?.default_pin}</p>
            <p>Employee #: {created?.employee_number}</p>
          </div>
          <DialogFooter>
            <Button onClick={() => setCreated(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Set PIN */}
      <Dialog open={!!pinTarget} onOpenChange={(open) => !open && setPinTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Set PIN for {pinTarget?.full_name}</DialogTitle>
          </DialogHeader>
          <Input
            placeholder="4-8 digit PIN"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
          />
          <DialogFooter>
            <Button disabled={settingPin} onClick={handleSetPin}>
              {settingPin ? 'Saving...' : 'Save PIN'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Deactivate / Reactivate confirm */}
      <Dialog open={!!activeToggleTarget} onOpenChange={(open) => !open && setActiveToggleTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {activeToggleTarget?.active ? 'Deactivate' : 'Reactivate'} {activeToggleTarget?.full_name}?
            </DialogTitle>
            <DialogDescription>
              {activeToggleTarget?.active
                ? "This blocks their dashboard login and kiosk PIN immediately. Their sales, attendance, and other history stays intact -- this can be undone any time."
                : 'This restores their dashboard login and kiosk PIN.'}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button disabled={togglingActive} onClick={handleToggleActive}>
              {togglingActive ? 'Saving...' : activeToggleTarget?.active ? 'Deactivate' : 'Reactivate'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <Dialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {deleteTarget?.full_name}?</DialogTitle>
            <DialogDescription>
              This permanently removes the account. It only succeeds if this employee has no real history (sales,
              attendance, inventory movements, etc.) attached -- if they do, you'll get an error explaining what's
              blocking it, and you should Deactivate instead.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="destructive" disabled={deleting} onClick={handleDelete}>
              {deleting ? 'Deleting...' : 'Delete permanently'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
}
