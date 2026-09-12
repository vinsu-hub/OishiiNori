import React, { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { DashboardLayout } from '@/components/DashboardLayout';
import { useAuth } from '@/contexts/AuthContext';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ApiPayRule, fetchPayRules, updatePayRule } from '@/lib/api';

const SCENARIO_LABEL: Record<string, string> = {
  regular_day: 'Regular Day',
  regular_holiday: 'Regular Holiday',
  regular_holiday_rest_day: 'Regular Holiday + Rest Day',
  special_non_working: 'Special Non-Working',
  special_non_working_rest_day: 'Special Non-Working + Rest Day',
  special_working: 'Special Working',
  rest_day: 'Rest Day',
};

interface EditState {
  not_worked_pct: string;
  first_8hr_pct: string;
  ot_addon_pct: string;
  night_diff_addon_pct: string;
}

export default function PayrollSettings() {
  const { user } = useAuth();
  const isExecutive = user?.role === 'executive';
  const [rules, setRules] = useState<ApiPayRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [edit, setEdit] = useState<EditState>({ not_worked_pct: '', first_8hr_pct: '', ot_addon_pct: '', night_diff_addon_pct: '' });
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    fetchPayRules()
      .then(setRules)
      .catch((e) => toast.error(`Failed to load pay rules: ${e.message}`))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (user && user.role === 'employee' && !user.extraPages.includes('hr-payroll-settings')) {
    return (
      <DashboardLayout title="Payroll Settings">
        <div className="p-6">
          <p className="text-sm text-muted-foreground">You don't have access to this page.</p>
        </div>
      </DashboardLayout>
    );
  }

  function startEdit(rule: ApiPayRule) {
    setEditingKey(rule.scenario_key);
    setEdit({
      not_worked_pct: String(rule.not_worked_pct),
      first_8hr_pct: String(rule.first_8hr_pct),
      ot_addon_pct: String(rule.ot_addon_pct),
      night_diff_addon_pct: String(rule.night_diff_addon_pct),
    });
  }

  async function handleSave(scenarioKey: string) {
    setSaving(true);
    try {
      await updatePayRule(scenarioKey as ApiPayRule['scenario_key'], {
        not_worked_pct: Number(edit.not_worked_pct),
        first_8hr_pct: Number(edit.first_8hr_pct),
        ot_addon_pct: Number(edit.ot_addon_pct),
        night_diff_addon_pct: Number(edit.night_diff_addon_pct),
      });
      toast.success('Pay rule updated');
      setEditingKey(null);
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to update pay rule');
    } finally {
      setSaving(false);
    }
  }

  return (
    <DashboardLayout title="Payroll Settings">
      <div className="p-6 space-y-4">
        <p className="text-sm text-muted-foreground">
          DOLE-style pay multiplier rules per day scenario. Percentages apply to the employee's base hourly rate.
        </p>
        {loading && <p className="text-sm text-muted-foreground">Loading pay rules...</p>}
        {!loading && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Scenario</TableHead>
                <TableHead>Not Worked %</TableHead>
                <TableHead>First 8hr %</TableHead>
                <TableHead>OT Add-on %</TableHead>
                <TableHead>Night Diff Add-on %</TableHead>
                {isExecutive && <TableHead />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rules.map((rule) => {
                const isEditing = editingKey === rule.scenario_key;
                return (
                  <TableRow key={rule.scenario_key}>
                    <TableCell className="font-medium">{SCENARIO_LABEL[rule.scenario_key] || rule.scenario_key}</TableCell>
                    {isEditing ? (
                      <>
                        <TableCell>
                          <Input
                            type="number"
                            className="w-24"
                            value={edit.not_worked_pct}
                            onChange={(e) => setEdit({ ...edit, not_worked_pct: e.target.value })}
                          />
                        </TableCell>
                        <TableCell>
                          <Input
                            type="number"
                            className="w-24"
                            value={edit.first_8hr_pct}
                            onChange={(e) => setEdit({ ...edit, first_8hr_pct: e.target.value })}
                          />
                        </TableCell>
                        <TableCell>
                          <Input
                            type="number"
                            className="w-24"
                            value={edit.ot_addon_pct}
                            onChange={(e) => setEdit({ ...edit, ot_addon_pct: e.target.value })}
                          />
                        </TableCell>
                        <TableCell>
                          <Input
                            type="number"
                            className="w-24"
                            value={edit.night_diff_addon_pct}
                            onChange={(e) => setEdit({ ...edit, night_diff_addon_pct: e.target.value })}
                          />
                        </TableCell>
                        <TableCell className="flex gap-2">
                          <Button size="sm" disabled={saving} onClick={() => handleSave(rule.scenario_key)}>
                            {saving ? 'Saving...' : 'Save'}
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => setEditingKey(null)}>
                            Cancel
                          </Button>
                        </TableCell>
                      </>
                    ) : (
                      <>
                        <TableCell>{rule.not_worked_pct}</TableCell>
                        <TableCell>{rule.first_8hr_pct}</TableCell>
                        <TableCell>{rule.ot_addon_pct}</TableCell>
                        <TableCell>{rule.night_diff_addon_pct}</TableCell>
                        {isExecutive && (
                          <TableCell>
                            <Button size="sm" variant="outline" onClick={() => startEdit(rule)}>
                              Edit
                            </Button>
                          </TableCell>
                        )}
                      </>
                    )}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>
    </DashboardLayout>
  );
}
