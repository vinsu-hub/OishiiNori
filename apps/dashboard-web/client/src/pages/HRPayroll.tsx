import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { DashboardLayout } from '@/components/DashboardLayout';
import { useAuth } from '@/contexts/AuthContext';
import { useLocation } from 'wouter';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import {
  Wallet, Loader2, Printer, Download, AlertTriangle, CheckCircle, CalendarDays, Settings2,
} from 'lucide-react';
import { formatCurrency, formatDateTime12h } from '@/lib/utils';
import {
  ApiPayrollAuditLogEntry,
  ApiPayrollRecord,
  ApiPayrollRow,
  ApiPayrollSummary,
  approvePayrollOverride,
  fetchAttendanceSummary,
  fetchPayrollAuditLog,
  fetchPayrollRecord,
  fetchPayrollRecords,
  fetchPayrollReceiptPdf,
  fetchPayrollReceiptsZip,
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

interface PayrollRecordItem {
  id: string;
  employee_name: string;
  hours_worked: number;
  total_pay: number;
}

export default function HRPayroll() {
  const { user } = useAuth();
  const [, navigate] = useLocation();
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

  if (user && user.role === 'employee' && !user.extraPages.includes('hr-payroll')) {
    return (
      <DashboardLayout title="Payroll">
        <div className="p-6">
          <p className="text-sm text-muted-foreground">You don't have access to this page.</p>
        </div>
      </DashboardLayout>
    );
  }

  async function handleGenerate() {
    if (summary && summary.employee_count === 0) {
      if (
        !confirm(
          `No attendance found for ${periodStart} to ${periodEnd} -- this would generate an empty ₱0 payroll record. Generate anyway?`
        )
      ) {
        return;
      }
    } else if (
      !confirm(`Generate and save a payroll run for ${periodStart} to ${periodEnd}? This persists a record in payroll history.`)
    ) {
      return;
    }
    setGenerating(true);
    try {
      const record = await generatePayroll({ period_start: periodStart, period_end: periodEnd });
      toast.success(`Payroll generated -- ${record.employee_count} employees, total ${formatCurrency(record.total_pay)}`);
      loadPreview();
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

  const [receiptLoading, setReceiptLoading] = useState<string | null>(null);
  const [bulkReceiptLoading, setBulkReceiptLoading] = useState(false);

  const handlePrintReceipt = async (row: ApiPayrollRow) => {
    setReceiptLoading(row.employee_id);
    try {
      const blob = await fetchPayrollReceiptPdf(row.employee_id, periodStart, periodEnd);
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to generate payslip');
    } finally {
      setReceiptLoading(null);
    }
  };

  const handlePrintAllReceipts = async () => {
    if (!summary || summary.rows.length === 0) return;
    setBulkReceiptLoading(true);
    try {
      const blob = await fetchPayrollReceiptsZip(periodStart, periodEnd);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `payroll_receipts_${periodStart}_${periodEnd}.zip`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to generate payroll receipts');
    } finally {
      setBulkReceiptLoading(false);
    }
  };

  const [printRecord, setPrintRecord] = useState<ApiPayrollRecord | null>(null);
  const handleViewRecord = async (id: string) => {
    try {
      setPrintRecord(await fetchPayrollRecord(id));
    } catch {
      toast.error('Failed to load payroll run detail');
    }
  };

  const [drawerRow, setDrawerRow] = useState<ApiPayrollRow | null>(null);

  const totalOvertime = summary?.rows.reduce((sum, r) => sum + (r.overtime_pay ?? 0), 0) ?? 0;
  const totalNightDiff = summary?.rows.reduce((sum, r) => sum + (r.night_diff_pay ?? 0), 0) ?? 0;
  const totalHoliday = summary?.rows.reduce((sum, r) => sum + (r.holiday_pay ?? 0), 0) ?? 0;

  return (
    <DashboardLayout title="Payroll">
      <div className="p-6 space-y-6">
        <Card className="sticky top-0 z-10">
          <CardContent className="pt-6 flex flex-wrap items-end gap-3">
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
            {user?.role === 'executive' || user?.role === 'manager' || user?.extraPages.includes('hr-payroll') ? (
              <Button onClick={handleGenerate} disabled={generating} className="gap-2">
                {generating && <Loader2 className="w-4 h-4 animate-spin" />}
                Generate payroll
              </Button>
            ) : null}
            <Button variant="outline" onClick={() => navigate('/hr/holiday-calendar')} className="gap-2">
              <CalendarDays className="w-4 h-4" />
              Holiday Calendar
            </Button>
            <Button variant="outline" onClick={() => navigate('/hr/payroll-settings')} className="gap-2">
              <Settings2 className="w-4 h-4" />
              Settings
            </Button>
          </CardContent>
        </Card>

        <Tabs defaultValue="preview">
          <TabsList>
            <TabsTrigger value="preview">Preview &amp; Generate</TabsTrigger>
            <TabsTrigger value="history">History</TabsTrigger>
            <TabsTrigger value="overrides">Overrides &amp; Audit</TabsTrigger>
          </TabsList>

          <TabsContent value="preview" className="space-y-4 pt-4">
            {summary && summary.rows.length > 0 && (
              <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
                <Card>
                  <CardContent className="p-4 text-center">
                    <p className="text-sm text-muted-foreground">Total Payroll</p>
                    <p className="text-2xl font-bold text-success">{formatCurrency(summary.total_pay)}</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-4 text-center">
                    <p className="text-sm text-muted-foreground">Overtime</p>
                    <p className="text-2xl font-bold">{formatCurrency(totalOvertime)}</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-4 text-center">
                    <p className="text-sm text-muted-foreground">Night Differential</p>
                    <p className="text-2xl font-bold">{formatCurrency(totalNightDiff)}</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-4 text-center">
                    <p className="text-sm text-muted-foreground">Holiday Premium</p>
                    <p className="text-2xl font-bold">{formatCurrency(totalHoliday)}</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-4 text-center">
                    <p className="text-sm text-muted-foreground">Employees</p>
                    <p className="text-2xl font-bold">{summary.employee_count}</p>
                  </CardContent>
                </Card>
              </div>
            )}

            {summary && (
              <div className="flex gap-2">
                <Badge variant={summary.validation.attendance_complete ? 'default' : 'destructive'}>
                  {summary.validation.attendance_complete ? <CheckCircle className="w-3 h-3 mr-1" /> : <AlertTriangle className="w-3 h-3 mr-1" />}
                  {summary.validation.attendance_complete ? 'Attendance complete' : 'Attendance incomplete'}
                </Badge>
                <Badge variant={summary.validation.holiday_configured ? 'default' : 'destructive'}>
                  {summary.validation.holiday_configured ? 'Holidays configured' : 'Holidays missing'}
                </Badge>
                <Badge variant={summary.validation.pending_overrides > 0 ? 'secondary' : 'default'}>
                  {summary.validation.pending_overrides} pending override(s)
                </Badge>
              </div>
            )}

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Wallet className="w-5 h-5" />
                  Payroll Preview
                </CardTitle>
              </CardHeader>
              <CardContent>
                {!summary ? (
                  <p className="text-sm text-muted-foreground">Load a preview to see attendance for this period.</p>
                ) : summary.rows.length === 0 ? (
                  <div className="text-center py-8">
                    <AlertTriangle className="w-10 h-10 mx-auto text-muted-foreground/30 mb-3" />
                    <p className="text-muted-foreground mb-1">No payroll data for this period</p>
                    <p className="text-sm text-muted-foreground">Adjust the period and click Load preview</p>
                  </div>
                ) : (
                  <>
                    <div className="overflow-x-auto">
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
                            <TableHead className="w-32">Receipt</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {summary.rows.map((row) => (
                            <TableRow key={row.employee_id} className="cursor-pointer hover:bg-muted/50" onClick={() => setDrawerRow(row)}>
                              <TableCell className="font-medium">{row.employee_name}</TableCell>
                              <TableCell className="text-muted-foreground">{row.position || '--'}</TableCell>
                              <TableCell>{row.hours_worked.toFixed(2)}</TableCell>
                              <TableCell>{row.regular_pay?.toFixed(2) ?? '--'}</TableCell>
                              <TableCell>{row.overtime_pay?.toFixed(2) ?? '--'}</TableCell>
                              <TableCell>{row.night_diff_pay?.toFixed(2) ?? '--'}</TableCell>
                              <TableCell>{row.holiday_pay?.toFixed(2) ?? '--'}</TableCell>
                              <TableCell className="font-semibold">{row.total_pay.toFixed(2)}</TableCell>
                              <TableCell onClick={(e) => e.stopPropagation()}>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => handlePrintReceipt(row)}
                                  disabled={receiptLoading === row.employee_id}
                                  className="gap-1"
                                >
                                  {receiptLoading === row.employee_id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Printer className="w-3 h-3" />}
                                  Receipt
                                </Button>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                    <p className="text-sm text-muted-foreground mt-3">
                      {summary.employee_count} employee(s) -- {summary.total_hours.toFixed(2)} total hours -- total pay{' '}
                      {summary.total_pay.toFixed(2)}
                    </p>
                    <div className="flex justify-end mt-3">
                      <Button variant="outline" onClick={handlePrintAllReceipts} disabled={bulkReceiptLoading} className="gap-2">
                        {bulkReceiptLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                        Download All Receipts (ZIP)
                      </Button>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
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
                    <TableHead className="w-20">Actions</TableHead>
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
                      <TableCell className="text-muted-foreground">{formatDateTime12h(r.created_at)}</TableCell>
                      <TableCell>
                        <Button size="sm" variant="outline" onClick={() => handleViewRecord(r.id)}>
                          View
                        </Button>
                      </TableCell>
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
                        <TableCell className="text-muted-foreground">{formatDateTime12h(o.createdAt)}</TableCell>
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
                      <TableCell className="text-muted-foreground">{formatDateTime12h(a.created_at)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </TabsContent>
        </Tabs>
      </div>

      {/* Employee drawer */}
      <Sheet open={!!drawerRow} onOpenChange={(open) => !open && setDrawerRow(null)}>
        <SheetContent className="sm:max-w-xl w-full overflow-y-auto">
          {drawerRow && (
            <>
              <SheetHeader>
                <SheetTitle>{drawerRow.employee_name}</SheetTitle>
                <SheetDescription>
                  {drawerRow.position || 'No position set'} · {periodStart} -- {periodEnd}
                </SheetDescription>
              </SheetHeader>
              <div className="px-4 pb-4">
                <Tabs defaultValue="overview">
                  <TabsList className="grid w-full grid-cols-3 mb-4">
                    <TabsTrigger value="overview" className="text-xs">Overview</TabsTrigger>
                    <TabsTrigger value="breakdown" className="text-xs">Breakdown</TabsTrigger>
                    <TabsTrigger value="payslip" className="text-xs">Payslip</TabsTrigger>
                  </TabsList>
                  <TabsContent value="overview" className="space-y-3 text-sm">
                    <div className="flex justify-between"><span className="text-muted-foreground">Hours Worked</span><span>{drawerRow.hours_worked.toFixed(2)}h</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">Pay Rate</span><span>{formatCurrency(drawerRow.pay_rate)}/hr</span></div>
                    <div className="flex justify-between font-bold"><span>Total Pay</span><span className="text-success">{formatCurrency(drawerRow.total_pay)}</span></div>
                  </TabsContent>
                  <TabsContent value="breakdown" className="space-y-3 text-sm">
                    <div className="flex justify-between"><span className="text-muted-foreground">Regular Hours</span><span>{(drawerRow.regular_hours ?? drawerRow.hours_worked).toFixed(2)}h</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">Overtime Hours</span><span>{(drawerRow.overtime_hours ?? 0).toFixed(2)}h</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">Night Differential Hours</span><span>{(drawerRow.night_diff_hours ?? 0).toFixed(2)}h</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">Overtime Pay</span><span>{formatCurrency(drawerRow.overtime_pay ?? 0)}</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">Night Differential Pay</span><span>{formatCurrency(drawerRow.night_diff_pay ?? 0)}</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">Holiday Premium</span><span>{formatCurrency(drawerRow.holiday_pay ?? 0)}</span></div>
                  </TabsContent>
                  <TabsContent value="payslip">
                    <Button
                      onClick={() => handlePrintReceipt(drawerRow)}
                      disabled={receiptLoading === drawerRow.employee_id}
                      className="w-full gap-2"
                    >
                      {receiptLoading === drawerRow.employee_id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Printer className="w-4 h-4" />}
                      View / Print Payslip
                    </Button>
                  </TabsContent>
                </Tabs>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>

      {/* Payroll run detail (History "View") */}
      <Sheet open={!!printRecord} onOpenChange={(open) => !open && setPrintRecord(null)}>
        <SheetContent className="sm:max-w-xl w-full overflow-y-auto">
          {printRecord && (
            <>
              <SheetHeader>
                <SheetTitle>
                  Payroll Run -- {printRecord.period_start} to {printRecord.period_end}
                </SheetTitle>
                <SheetDescription>
                  {printRecord.employee_count} employees · {formatCurrency(printRecord.total_pay)} total
                </SheetDescription>
              </SheetHeader>
              <div className="px-4 pb-4">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Employee</TableHead>
                      <TableHead className="text-right">Hours</TableHead>
                      <TableHead className="text-right">Pay</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(printRecord.items as PayrollRecordItem[]).map((item) => (
                      <TableRow key={item.id}>
                        <TableCell>{item.employee_name}</TableCell>
                        <TableCell className="text-right">{item.hours_worked.toFixed(1)}h</TableCell>
                        <TableCell className="text-right">{formatCurrency(item.total_pay)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </DashboardLayout>
  );
}
