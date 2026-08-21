import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { DashboardLayout } from '@/components/DashboardLayout';
import { useAuth } from '@/contexts/AuthContext';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  ApiAttendanceLog,
  ApiEmployee,
  PayrollOverrideField,
  createPayrollOverride,
  fetchAttendance,
  fetchEmployees,
} from '@/lib/api';

const OVERRIDE_FIELDS: { value: PayrollOverrideField; label: string }[] = [
  { value: 'regular_hours', label: 'Regular hours' },
  { value: 'overtime_hours', label: 'Overtime hours' },
  { value: 'night_diff_hours', label: 'Night differential hours' },
  { value: 'day_scenario', label: 'Day scenario' },
];

function startOfWeekIso() {
  const now = new Date();
  const day = now.getDay();
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((day + 6) % 7));
  return monday.toISOString().slice(0, 10);
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

export default function HRAttendance() {
  const { user } = useAuth();
  const [logs, setLogs] = useState<ApiAttendanceLog[]>([]);
  const [employees, setEmployees] = useState<ApiEmployee[]>([]);
  const [loading, setLoading] = useState(true);
  const [dateFrom, setDateFrom] = useState(startOfWeekIso());
  const [dateTo, setDateTo] = useState(todayIso());

  const [overrideTarget, setOverrideTarget] = useState<ApiAttendanceLog | null>(null);
  const [overrideField, setOverrideField] = useState<PayrollOverrideField>('regular_hours');
  const [overrideValue, setOverrideValue] = useState('');
  const [overrideReason, setOverrideReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(() => {
    Promise.all([fetchAttendance({ date_from: dateFrom, date_to: dateTo }), fetchEmployees()])
      .then(([logsData, employeesData]) => {
        setLogs(logsData);
        setEmployees(employeesData);
      })
      .catch((e) => toast.error(`Failed to load attendance: ${e.message}`))
      .finally(() => setLoading(false));
  }, [dateFrom, dateTo]);

  useEffect(() => {
    load();
  }, [load]);

  const employeesById = useMemo(() => {
    const map = new Map<string, ApiEmployee>();
    for (const e of employees) map.set(e.id, e);
    return map;
  }, [employees]);

  if (user && user.role === 'employee') {
    return (
      <DashboardLayout title="HR Attendance">
        <div className="p-6">
          <p className="text-sm text-muted-foreground">You don't have access to this page.</p>
        </div>
      </DashboardLayout>
    );
  }

  function openOverride(log: ApiAttendanceLog) {
    setOverrideTarget(log);
    setOverrideField('regular_hours');
    setOverrideValue('');
    setOverrideReason('');
  }

  async function handleSubmitOverride() {
    if (!overrideTarget) return;
    if (!overrideValue.trim() || !overrideReason.trim()) {
      toast.error('Provide a new value and a reason');
      return;
    }
    setSubmitting(true);
    try {
      await createPayrollOverride({
        attendance_log_id: overrideTarget.id,
        field: overrideField,
        new_value: overrideValue.trim(),
        reason: overrideReason.trim(),
      });
      toast.success('Override submitted for approval');
      setOverrideTarget(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to submit override');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <DashboardLayout title="HR Attendance">
      <div className="p-6 space-y-4">
        <Card>
          <CardContent className="pt-6 flex items-end gap-3">
            <div className="space-y-1">
              <Label>From</Label>
              <Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>To</Label>
              <Input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
            </div>
            <Button variant="outline" onClick={load}>
              Refresh
            </Button>
          </CardContent>
        </Card>

        {loading && <p className="text-sm text-muted-foreground">Loading attendance...</p>}
        {!loading && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Employee</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Clock In</TableHead>
                <TableHead>Clock Out</TableHead>
                <TableHead>Hours</TableHead>
                <TableHead>Scenario</TableHead>
                <TableHead>Status</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {logs.map((log) => (
                <TableRow key={log.id}>
                  <TableCell className="font-medium">{employeesById.get(log.employee_id)?.full_name || log.employee_id.slice(0, 8)}</TableCell>
                  <TableCell>{log.date}</TableCell>
                  <TableCell>{new Date(log.clock_in).toLocaleTimeString()}</TableCell>
                  <TableCell>{log.clock_out ? new Date(log.clock_out).toLocaleTimeString() : '--'}</TableCell>
                  <TableCell>{log.hours_worked != null ? log.hours_worked.toFixed(2) : '--'}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{log.day_scenario?.replace(/_/g, ' ') || '--'}</TableCell>
                  <TableCell>
                    <Badge variant={log.status === 'completed' ? 'default' : 'secondary'}>{log.status}</Badge>
                    {log.auto_closed && <Badge variant="outline" className="ml-1">auto-closed</Badge>}
                  </TableCell>
                  <TableCell>
                    <Button size="sm" variant="outline" onClick={() => openOverride(log)}>
                      Request override
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      <Dialog open={!!overrideTarget} onOpenChange={(open) => !open && setOverrideTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Request override -- {overrideTarget && (employeesById.get(overrideTarget.employee_id)?.full_name || overrideTarget.employee_id.slice(0, 8))} ({overrideTarget?.date})
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>Field</Label>
              <Select value={overrideField} onValueChange={(v) => setOverrideField(v as PayrollOverrideField)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {OVERRIDE_FIELDS.map((f) => (
                    <SelectItem key={f.value} value={f.value}>
                      {f.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>New value</Label>
              <Input value={overrideValue} onChange={(e) => setOverrideValue(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>Reason</Label>
              <Textarea value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button disabled={submitting} onClick={handleSubmitOverride}>
              {submitting ? 'Submitting...' : 'Submit for approval'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
}
