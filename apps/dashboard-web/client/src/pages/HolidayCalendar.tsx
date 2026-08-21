import React, { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { DashboardLayout } from '@/components/DashboardLayout';
import { useAuth } from '@/contexts/AuthContext';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ApiHoliday, HolidayType, createHoliday, deleteHoliday, fetchHolidays, updateHoliday } from '@/lib/api';

const HOLIDAY_TYPES: { value: HolidayType; label: string }[] = [
  { value: 'regular_holiday', label: 'Regular Holiday' },
  { value: 'special_non_working', label: 'Special Non-Working' },
  { value: 'special_working', label: 'Special Working' },
];

export default function HolidayCalendar() {
  const { user } = useAuth();
  const isExecutive = user?.role === 'executive';
  const [year, setYear] = useState(new Date().getFullYear());
  const [holidays, setHolidays] = useState<ApiHoliday[]>([]);
  const [loading, setLoading] = useState(true);

  const [editTarget, setEditTarget] = useState<ApiHoliday | 'new' | null>(null);
  const [holidayDate, setHolidayDate] = useState('');
  const [name, setName] = useState('');
  const [holidayType, setHolidayType] = useState<HolidayType>('regular_holiday');
  const [isRecurring, setIsRecurring] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(() => {
    fetchHolidays(year)
      .then(setHolidays)
      .catch((e) => toast.error(`Failed to load holidays: ${e.message}`))
      .finally(() => setLoading(false));
  }, [year]);

  useEffect(() => {
    load();
  }, [load]);

  if (user && user.role === 'employee') {
    return (
      <DashboardLayout title="Holiday Calendar">
        <div className="p-6">
          <p className="text-sm text-muted-foreground">You don't have access to this page.</p>
        </div>
      </DashboardLayout>
    );
  }

  function openNew() {
    setEditTarget('new');
    setHolidayDate('');
    setName('');
    setHolidayType('regular_holiday');
    setIsRecurring(false);
  }

  function openEdit(h: ApiHoliday) {
    setEditTarget(h);
    setHolidayDate(h.holiday_date);
    setName(h.name);
    setHolidayType(h.holiday_type);
    setIsRecurring(h.is_recurring);
  }

  async function handleSave() {
    if (!holidayDate || !name.trim()) {
      toast.error('Date and name are required');
      return;
    }
    setSubmitting(true);
    try {
      if (editTarget === 'new') {
        await createHoliday({ holiday_date: holidayDate, name: name.trim(), holiday_type: holidayType, is_recurring: isRecurring });
        toast.success('Holiday added');
      } else if (editTarget) {
        await updateHoliday(editTarget.id, { holiday_date: holidayDate, name: name.trim(), holiday_type: holidayType, is_recurring: isRecurring });
        toast.success('Holiday updated');
      }
      setEditTarget(null);
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save holiday');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(h: ApiHoliday) {
    try {
      await deleteHoliday(h.id);
      toast.success('Holiday deleted');
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to delete holiday');
    }
  }

  return (
    <DashboardLayout title="Holiday Calendar">
      <div className="p-6 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Label>Year</Label>
            <Input
              type="number"
              value={year}
              onChange={(e) => setYear(Number(e.target.value))}
              className="w-28"
            />
          </div>
          {isExecutive && <Button onClick={openNew}>Add holiday</Button>}
        </div>

        {loading && <p className="text-sm text-muted-foreground">Loading holidays...</p>}
        {!loading && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Recurring</TableHead>
                {isExecutive && <TableHead />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {holidays.map((h) => (
                <TableRow key={h.id}>
                  <TableCell>{h.holiday_date}</TableCell>
                  <TableCell className="font-medium">{h.name}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{HOLIDAY_TYPES.find((t) => t.value === h.holiday_type)?.label || h.holiday_type}</Badge>
                  </TableCell>
                  <TableCell>{h.is_recurring ? 'Yes' : 'No'}</TableCell>
                  {isExecutive && (
                    <TableCell className="flex gap-2">
                      <Button size="sm" variant="outline" onClick={() => openEdit(h)}>
                        Edit
                      </Button>
                      <Button size="sm" variant="destructive" onClick={() => handleDelete(h)}>
                        Delete
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      <Dialog open={!!editTarget} onOpenChange={(open) => !open && setEditTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editTarget === 'new' ? 'Add holiday' : 'Edit holiday'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>Date</Label>
              <Input type="date" value={holidayDate} onChange={(e) => setHolidayDate(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>Name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>Type</Label>
              <Select value={holidayType} onValueChange={(v) => setHolidayType(v as HolidayType)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {HOLIDAY_TYPES.map((t) => (
                    <SelectItem key={t.value} value={t.value}>
                      {t.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox id="recurring" checked={isRecurring} onCheckedChange={(c) => setIsRecurring(c === true)} />
              <Label htmlFor="recurring" className="text-sm font-normal">
                Recurs every year
              </Label>
            </div>
          </div>
          <DialogFooter>
            <Button disabled={submitting} onClick={handleSave}>
              {submitting ? 'Saving...' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
}
