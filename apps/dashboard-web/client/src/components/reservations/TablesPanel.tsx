import React, { useCallback, useEffect, useState } from 'react';
import { useLocation } from 'wouter';
import { toast } from 'sonner';
import { useAuth } from '@/contexts/AuthContext';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ApiTable, createTable, fetchTables, updateTable } from '@/lib/api';

export function TablesPanel() {
  const { user } = useAuth();
  const canManage = user?.role === 'manager' || user?.role === 'executive';
  const [, navigate] = useLocation();

  const [tables, setTables] = useState<ApiTable[]>([]);
  const [loading, setLoading] = useState(true);
  const [editTarget, setEditTarget] = useState<ApiTable | 'new' | null>(null);
  const [label, setLabel] = useState('');
  const [capacity, setCapacity] = useState('');
  const [posTableNumber, setPosTableNumber] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    fetchTables()
      .then(setTables)
      .catch((e) => toast.error(`Failed to load tables: ${e instanceof Error ? e.message : 'Unknown error'}`))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function openNew() {
    setLabel('');
    setCapacity('');
    setPosTableNumber('');
    setEditTarget('new');
  }

  function openEdit(table: ApiTable) {
    setLabel(table.label);
    setCapacity(String(table.capacity));
    setPosTableNumber(table.pos_table_number == null ? '' : String(table.pos_table_number));
    setEditTarget(table);
  }

  async function handleSave() {
    const cap = Number(capacity);
    if (!label.trim() || !Number.isFinite(cap) || cap <= 0) {
      toast.error('A label and a capacity greater than 0 are required');
      return;
    }
    const trimmedPos = posTableNumber.trim();
    const posNum = trimmedPos === '' ? null : Number(trimmedPos);
    if (posNum !== null && (!Number.isInteger(posNum) || posNum <= 0)) {
      toast.error('POS table number must be a positive whole number');
      return;
    }
    setSaving(true);
    try {
      if (editTarget === 'new') {
        await createTable({ label: label.trim(), capacity: cap, pos_table_number: posNum });
        toast.success('Table added');
      } else if (editTarget) {
        await updateTable(editTarget.id, { label: label.trim(), capacity: cap, pos_table_number: posNum });
        toast.success('Table updated');
      }
      setEditTarget(null);
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save table');
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(table: ApiTable, active: boolean) {
    try {
      await updateTable(table.id, { active });
      setTables((prev) => prev.map((t) => (t.id === table.id ? { ...t, active } : t)));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to update table');
    }
  }

  return (
    <div className="space-y-3">
      {canManage && (
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={openNew}>
            Add table
          </Button>
          <Button size="sm" variant="outline" onClick={() => navigate('/reservations?tab=floor-plan')}>
            Edit Layout
          </Button>
        </div>
      )}

      <Card>
        <CardContent className="pt-6">
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading tables...</p>
          ) : tables.length === 0 ? (
            <p className="text-sm text-muted-foreground">No tables set up yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Label</TableHead>
                  <TableHead>Capacity</TableHead>
                  <TableHead>POS #</TableHead>
                  <TableHead>Active</TableHead>
                  {canManage && <TableHead />}
                </TableRow>
              </TableHeader>
              <TableBody>
                {tables.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell className="font-medium">{t.label}</TableCell>
                    <TableCell>
                      {t.capacity_min != null &&
                      t.capacity_max != null &&
                      t.capacity_min !== t.capacity_max
                        ? `${t.capacity_min}–${t.capacity_max}`
                        : t.capacity}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {t.pos_table_number ?? '--'}
                    </TableCell>
                    <TableCell>
                      {canManage ? (
                        <Switch checked={t.active} onCheckedChange={(checked) => toggleActive(t, checked)} />
                      ) : (
                        <span className="text-sm text-muted-foreground">{t.active ? 'Yes' : 'No'}</span>
                      )}
                    </TableCell>
                    {canManage && (
                      <TableCell>
                        <Button size="sm" variant="outline" onClick={() => openEdit(t)}>
                          Edit
                        </Button>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!editTarget} onOpenChange={(open) => !open && setEditTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editTarget === 'new' ? 'Add table' : 'Edit table'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>Label</Label>
              <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Table 5" />
            </div>
            <div className="space-y-1">
              <Label>Capacity</Label>
              <Input
                type="number"
                min={1}
                value={capacity}
                onChange={(e) => setCapacity(e.target.value)}
                className="max-w-[120px]"
              />
            </div>
            <div className="space-y-1">
              <Label>POS table number</Label>
              <Input
                type="number"
                min={1}
                value={posTableNumber}
                onChange={(e) => setPosTableNumber(e.target.value)}
                className="max-w-[120px]"
                placeholder="e.g. 3"
              />
              <p className="text-xs text-muted-foreground">
                The number cashiers type on the POS. Leave blank if this table isn't seated from the POS.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button disabled={saving} onClick={handleSave}>
              {saving ? 'Saving...' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
