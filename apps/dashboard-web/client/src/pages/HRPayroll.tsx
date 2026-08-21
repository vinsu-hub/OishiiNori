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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  ApiPayrollAuditLogEntry,
  ApiPayrollRecord,
  ApiPayrollSummary,
  approvePayrollOverride,
  fetchAttendanceSummary,
  fetchPayrollAuditLog,
  fetchPayrollRecords,
  generatePayroll,
} from '@/lib/api';

function startOfMonthIso() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

interface PendingOverride {
  id: string;
  reason: string | null;
  newValue: unknown;
  createdAt: string;
}

export default function HRPayroll() {
  const { user } = useAuth();
  const [periodStart, setPeriodStart] = useState(startOfMonthIso());
  const [periodEnd, setPeriodEnd] = useState(todayIso());
  const [summary, setSummary] = useState<ApiPayrollSummary | null>(null);
  const [loadingSummary, setLoadingSummary] = useState(false);
  const [generating, setGenerating] = useState(false);

  const [records, setRecords] = useState<ApiPayrollRecord[]>([]);
  const [loadingRecords, setLoadingRecords] = useState(true);

  const [auditLog, setAuditLog] = useState<ApiPayrollAuditLogEntry[]>([]);
  const [loadingAudit, setLoadingAudit] = useState(true);
  const [approving, setApproving] = useState<string | null>(null);

  const loadPreview = useCallback(() => {
    setLoadingSummary(true);
    fetchAttendanceSummary({ date_from: periodStart, date_to: periodEnd })
      .then(setSummary)
      .catch((e) => toast.error(`Failed to load payroll preview: ${e.message}`))
      .finally(() => setLoadingSummary(false));
  }, [periodStart, periodEnd]);

  const loadRecords = useCallback(() => {
    fetchPayrollRecords(50)
      .then(setRecords)
      .catch((e) => toast.error(`Failed to load payroll history: ${e.message}`))
      .finally(() => setLoadingRecords(false));
  }, []);

  const loadAudit = useCallback(() => {
    fetchPayrollAuditLog({ entity_type: 'payroll_override', limit: 200 })
      .then(setAuditLog)
      .catch((e) => toast.error(`Failed to load audit log: ${e.message}`))
      .finally(() => setLoadingAudit(false));
  }, []);

  useEffect(() => {
    loadPreview();
    loadRecords();
    loadAudit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (user && user.role === 'employee') {
    return (
      <DashboardLayout title="Payroll">
        <div className="p-6">
          <p className="text-sm text-muted-foreground">You don't have access to this page.</p>
        </div>
      </DashboardLayout>
    );
  }

  async function handleGenerate() {
    setGenerating(true);
    try {
      const record = await generatePayroll({ period_start: periodStart, period_end: periodEnd });
      toast.success(`Payroll generated -- ${record.employee_count} employees, total ${record.total_pay.toFixed(2)}`);
      loadRecords();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to generate payroll');
    } finally {
      setGenerating(false);
    }
  }

  // Payroll overrides have no dedicated list endpoint -- derive "pending" by
  // pairing each create event's entity_id against any later approve event
  // for the same id, both recorded in the audit log.
  const pendingOverrides: PendingOverride[] = useMemo(() => {
    const approvedIds = new Set(auditLog.filter((a) => a.action === 'approve').map((a) => a.entity_id));
    return auditLog
      .filter((a) => a.action === 'create' && a.entity_id && !approvedIds.has(a.entity_id))
      .map((a) => ({ id: a.entity_id as string, reason: a.reason, newValue: a.new_value, createdAt: a.created_at }));
  }, [auditLog]);

  async function handleApprove(overrideId: string) {
    setApproving(overrideId);
    try {
      await approvePayrollOverride(overrideId);
      toast.success('Override approved');
      loadAudit();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to approve override');
    } finally {
      setApproving(null);
    }
  }

  return (
    <DashboardLayout title="Payroll">
      <div className="p-6">
        <Tabs defaultValue="preview">
          <TabsList>
            <TabsTrigger value="preview">Preview &amp; Generate</TabsTrigger>
            <TabsTrigger value="history">History</TabsTrigger>
            <TabsTrigger value="overrides">Overrides &amp; Audit</TabsTrigger>
          </TabsList>

          <TabsContent value="preview" className="space-y-4 pt-4">
            <Card>
              <CardContent className="pt-6 flex items-end gap-3">
                <div className="space-y-1">
                  <Label>Period start</Label>
                  <Input type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label>Period end</Label>
                  <Input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} />
                </div>
                <Button variant="outline" onClick={loadPreview} disabled={loadingSummary}>
                  {loadingSummary ? 'Loading...' : 'Load preview'}
                </Button>
                {user?.role === 'executive' || user?.role === 'manager' ? (
                  <Button onClick={handleGenerate} disabled={generating || !summary}>
                    {generating ? 'Generating...' : 'Generate payroll'}
                  </Button>
                ) : null}
              </CardContent>
            </Card>

            {summary && (
              <>
                <div className="flex gap-2">
                  <Badge variant={summary.validation.attendance_complete ? 'default' : 'destructive'}>
                    {summary.validation.attendance_complete ? 'Attendance complete' : 'Attendance incomplete'}
                  </Badge>
                  <Badge variant={summary.validation.holiday_configured ? 'default' : 'destructive'}>
                    {summary.validation.holiday_configured ? 'Holidays configured' : 'Holidays missing'}
                  </Badge>
                  {summary.validation.pending_overrides > 0 && (
                    <Badge variant="secondary">{summary.validation.pending_overrides} pending override(s)</Badge>
                  )}
                </div>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Employee</TableHead>
                      <TableHead>Position</TableHead>
                      <TableHead>Hours</TableHead>
                      <TableHead>Regular</TableHead>
                      <TableHead>Overtime</TableHead>
                      <TableHead>Night Diff</TableHead>
                      <TableHead>Holiday</TableHead>
                      <TableHead>Total Pay</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {summary.rows.map((row) => (
                      <TableRow key={row.employee_id}>
                        <TableCell className="font-medium">{row.employee_name}</TableCell>
                        <TableCell className="text-muted-foreground">{row.position || '--'}</TableCell>
                        <TableCell>{row.hours_worked.toFixed(2)}</TableCell>
                        <TableCell>{row.regular_pay?.toFixed(2) ?? '--'}</TableCell>
                        <TableCell>{row.overtime_pay?.toFixed(2) ?? '--'}</TableCell>
                        <TableCell>{row.night_diff_pay?.toFixed(2) ?? '--'}</TableCell>
                        <TableCell>{row.holiday_pay?.toFixed(2) ?? '--'}</TableCell>
                        <TableCell className="font-semibold">{row.total_pay.toFixed(2)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <p className="text-sm text-muted-foreground">
                  {summary.employee_count} employee(s) -- {summary.total_hours.toFixed(2)} total hours -- total pay{' '}
                  {summary.total_pay.toFixed(2)}
                </p>
              </>
            )}
          </TabsContent>

          <TabsContent value="history" className="pt-4">
            {loadingRecords && <p className="text-sm text-muted-foreground">Loading payroll history...</p>}
            {!loadingRecords && (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Period</TableHead>
                    <TableHead>Employees</TableHead>
                    <TableHead>Total Hours</TableHead>
                    <TableHead>Total Pay</TableHead>
                    <TableHead>Generated</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {records.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell>
                        {r.period_start} -- {r.period_end}
                      </TableCell>
                      <TableCell>{r.employee_count}</TableCell>
                      <TableCell>{r.total_hours.toFixed(2)}</TableCell>
                      <TableCell className="font-semibold">{r.total_pay.toFixed(2)}</TableCell>
                      <TableCell className="text-muted-foreground">{new Date(r.created_at).toLocaleString()}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </TabsContent>

          <TabsContent value="overrides" className="space-y-6 pt-4">
            <div>
              <h3 className="text-sm font-semibold mb-2">Pending overrides</h3>
              {loadingAudit && <p className="text-sm text-muted-foreground">Loading...</p>}
              {!loadingAudit && pendingOverrides.length === 0 && (
                <p className="text-sm text-muted-foreground">No pending overrides.</p>
              )}
              {!loadingAudit && pendingOverrides.length > 0 && (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Requested</TableHead>
                      <TableHead>New value</TableHead>
                      <TableHead>Reason</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pendingOverrides.map((o) => (
                      <TableRow key={o.id}>
                        <TableCell className="text-muted-foreground">{new Date(o.createdAt).toLocaleString()}</TableCell>
                        <TableCell className="font-mono text-xs">{JSON.stringify(o.newValue)}</TableCell>
                        <TableCell>{o.reason || '--'}</TableCell>
                        <TableCell>
                          {user?.role === 'executive' && (
                            <Button size="sm" disabled={approving === o.id} onClick={() => handleApprove(o.id)}>
                              {approving === o.id ? 'Approving...' : 'Approve'}
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </div>

            <div>
              <h3 className="text-sm font-semibold mb-2">Audit log</h3>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Action</TableHead>
                    <TableHead>Reason</TableHead>
                    <TableHead>When</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {auditLog.map((a) => (
                    <TableRow key={a.id}>
                      <TableCell className="capitalize">{a.action}</TableCell>
                      <TableCell>{a.reason || '--'}</TableCell>
                      <TableCell className="text-muted-foreground">{new Date(a.created_at).toLocaleString()}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </DashboardLayout>
  );
}
