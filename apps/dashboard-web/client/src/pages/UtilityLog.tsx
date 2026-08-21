import React, { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { DashboardLayout } from '@/components/DashboardLayout';
import { useAuth } from '@/contexts/AuthContext';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ApiUtilityLog, UtilityType, createUtilityLog, fetchUtilityLogs } from '@/lib/api';

const POLL_INTERVAL_MS = 20_000;

const UTILITY_TYPES: { value: UtilityType; label: string }[] = [
  { value: 'electricity', label: 'Electricity' },
  { value: 'water', label: 'Water' },
  { value: 'gas', label: 'Gas' },
];

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function consumptionAndCost(log: ApiUtilityLog): { consumption: number | null; cost: number | null } {
  const consumption =
    log.reading_end != null && log.reading_start != null
      ? log.reading_end - log.reading_start
      : log.quantity != null
        ? log.quantity
        : null;
  return { consumption, cost: consumption != null ? consumption * log.unit_cost : null };
}

export default function UtilityLog() {
  const { user } = useAuth();
  const [logs, setLogs] = useState<ApiUtilityLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const [utilityType, setUtilityType] = useState<UtilityType>('electricity');
  const [businessDate, setBusinessDate] = useState(todayIso());
  const [readingStart, setReadingStart] = useState('');
  const [readingEnd, setReadingEnd] = useState('');
  const [quantity, setQuantity] = useState('');
  const [unitLabel, setUnitLabel] = useState('');
  const [daysCovered, setDaysCovered] = useState('1');
  const [unitCost, setUnitCost] = useState('');

  const load = useCallback(() => {
    fetchUtilityLogs(50)
      .then(setLogs)
      .catch((e) => toast.error(`Failed to load utility log: ${e.message}`))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [load]);

  function resetForm() {
    setUtilityType('electricity');
    setBusinessDate(todayIso());
    setReadingStart('');
    setReadingEnd('');
    setQuantity('');
    setUnitLabel('');
    setDaysCovered('1');
    setUnitCost('');
  }

  async function handleSubmit() {
    if (!user) return;
    const cost = Number(unitCost);
    if (!unitCost.trim() || Number.isNaN(cost) || cost < 0) {
      toast.error('Enter a valid unit cost');
      return;
    }
    if (utilityType === 'gas' && !quantity.trim()) {
      toast.error('Enter the gas quantity consumed');
      return;
    }
    if (utilityType !== 'gas' && (!readingStart.trim() || !readingEnd.trim())) {
      toast.error('Enter both meter readings');
      return;
    }
    setSubmitting(true);
    try {
      await createUtilityLog({
        utility_type: utilityType,
        business_date: businessDate,
        reading_start: utilityType !== 'gas' && readingStart.trim() ? Number(readingStart) : undefined,
        reading_end: utilityType !== 'gas' && readingEnd.trim() ? Number(readingEnd) : undefined,
        quantity: utilityType === 'gas' && quantity.trim() ? Number(quantity) : undefined,
        unit_label: utilityType === 'gas' && unitLabel.trim() ? unitLabel.trim() : undefined,
        days_covered: utilityType === 'gas' ? Number(daysCovered) : undefined,
        unit_cost: cost,
        recorded_by: user.id,
      });
      toast.success('Utility reading logged');
      resetForm();
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to log reading');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <DashboardLayout title="Utility Log">
      <div className="p-6 space-y-6">
        <Card>
          <CardContent className="pt-6 space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>Utility</Label>
                <Select value={utilityType} onValueChange={(v) => setUtilityType(v as UtilityType)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {UTILITY_TYPES.map((t) => (
                      <SelectItem key={t.value} value={t.value}>
                        {t.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>Business date</Label>
                <Input type="date" value={businessDate} onChange={(e) => setBusinessDate(e.target.value)} />
              </div>

              {utilityType !== 'gas' ? (
                <>
                  <div className="space-y-1">
                    <Label>Reading start</Label>
                    <Input type="number" value={readingStart} onChange={(e) => setReadingStart(e.target.value)} />
                  </div>
                  <div className="space-y-1">
                    <Label>Reading end</Label>
                    <Input type="number" value={readingEnd} onChange={(e) => setReadingEnd(e.target.value)} />
                  </div>
                </>
              ) : (
                <>
                  <div className="space-y-1">
                    <Label>Quantity consumed</Label>
                    <Input type="number" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
                  </div>
                  <div className="space-y-1">
                    <Label>Unit label (e.g. canister)</Label>
                    <Input value={unitLabel} onChange={(e) => setUnitLabel(e.target.value)} />
                  </div>
                  <div className="space-y-1">
                    <Label>Days covered (1-7)</Label>
                    <Input
                      type="number"
                      min={1}
                      max={7}
                      value={daysCovered}
                      onChange={(e) => setDaysCovered(e.target.value)}
                    />
                  </div>
                </>
              )}

              <div className="space-y-1">
                <Label>Unit cost</Label>
                <Input type="number" min={0} step="0.01" value={unitCost} onChange={(e) => setUnitCost(e.target.value)} />
              </div>
            </div>

            <Button disabled={submitting} onClick={handleSubmit}>
              {submitting ? 'Logging...' : 'Log reading'}
            </Button>
          </CardContent>
        </Card>

        {loading && <p className="text-sm text-muted-foreground">Loading utility log...</p>}
        {!loading && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Utility</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Consumption</TableHead>
                <TableHead>Unit Cost</TableHead>
                <TableHead>Total Cost</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {logs.map((log) => {
                const { consumption, cost } = consumptionAndCost(log);
                return (
                  <TableRow key={log.id}>
                    <TableCell>
                      <Badge variant="outline" className="capitalize">
                        {log.utility_type}
                      </Badge>
                    </TableCell>
                    <TableCell>{log.business_date}</TableCell>
                    <TableCell>
                      {consumption != null ? consumption.toFixed(2) : '--'}
                      {log.unit_label ? ` ${log.unit_label}` : ''}
                    </TableCell>
                    <TableCell>{log.unit_cost.toFixed(2)}</TableCell>
                    <TableCell>{cost != null ? cost.toFixed(2) : '--'}</TableCell>
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
