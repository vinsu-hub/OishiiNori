import React, { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { DashboardLayout } from '@/components/DashboardLayout';
import { useAuth } from '@/contexts/AuthContext';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ApiDiscountType, createDiscountType, fetchDiscountTypes, updateDiscountType } from '@/lib/api';

export default function POSManagement() {
  const { user } = useAuth();
  const [discountTypes, setDiscountTypes] = useState<ApiDiscountType[]>([]);
  const [loading, setLoading] = useState(true);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ApiDiscountType | null>(null);
  const [name, setName] = useState('');
  const [percentage, setPercentage] = useState('');
  const [vatExempt, setVatExempt] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(() => {
    fetchDiscountTypes(false)
      .then((data) => setDiscountTypes([...data].sort((a, b) => a.name.localeCompare(b.name))))
      .catch((e) => toast.error(`Failed to load discount types: ${e.message}`))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (user && user.role === 'employee') {
    return (
      <DashboardLayout title="POS Management">
        <div className="p-6">
          <p className="text-sm text-muted-foreground">You don't have access to this page.</p>
        </div>
      </DashboardLayout>
    );
  }

  function openCreate() {
    setEditing(null);
    setName('');
    setPercentage('');
    setVatExempt(false);
    setFormOpen(true);
  }

  function openEdit(d: ApiDiscountType) {
    setEditing(d);
    setName(d.name);
    setPercentage(String(d.percentage));
    setVatExempt(d.vat_exempt);
    setFormOpen(true);
  }

  async function handleSubmit() {
    if (!name.trim()) {
      toast.error('Name is required');
      return;
    }
    const pct = Number(percentage);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      toast.error('Percentage must be between 0 and 100');
      return;
    }
    setSubmitting(true);
    try {
      if (editing) {
        await updateDiscountType(editing.id, { name: name.trim(), percentage: pct, vat_exempt: vatExempt });
        toast.success(`${name.trim()} updated`);
      } else {
        await createDiscountType({ name: name.trim(), percentage: pct, vat_exempt: vatExempt });
        toast.success(`${name.trim()} created`);
      }
      setFormOpen(false);
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save discount type');
    } finally {
      setSubmitting(false);
    }
  }

  async function toggleActive(d: ApiDiscountType) {
    try {
      await updateDiscountType(d.id, { active: !d.active });
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to update discount type');
    }
  }

  return (
    <DashboardLayout title="POS Management">
      <div className="p-6 space-y-4">
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            Discount types available on the POS Terminal checkout screen.
          </p>
          <Button onClick={openCreate}>Add discount type</Button>
        </div>

        {loading && <p className="text-sm text-muted-foreground">Loading discount types...</p>}
        {!loading && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Percentage</TableHead>
                <TableHead>VAT exempt</TableHead>
                <TableHead>Active</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {discountTypes.map((d) => (
                <TableRow key={d.id}>
                  <TableCell className="font-medium">{d.name}</TableCell>
                  <TableCell>{d.percentage}%</TableCell>
                  <TableCell>
                    <Badge variant="outline">{d.vat_exempt ? 'Yes' : 'No'}</Badge>
                  </TableCell>
                  <TableCell>
                    <Switch checked={d.active} onCheckedChange={() => toggleActive(d)} />
                  </TableCell>
                  <TableCell>
                    <Button size="sm" variant="outline" onClick={() => openEdit(d)}>
                      Edit
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {discountTypes.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-sm text-muted-foreground">
                    No discount types yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        )}
      </div>

      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? `Edit ${editing.name}` : 'Add discount type'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>Name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>Percentage</Label>
              <Input type="number" min={0} max={100} step="0.01" value={percentage} onChange={(e) => setPercentage(e.target.value)} />
            </div>
            <div className="flex items-center justify-between">
              <Label>VAT exempt</Label>
              <Switch checked={vatExempt} onCheckedChange={setVatExempt} />
            </div>
          </div>
          <DialogFooter>
            <Button disabled={submitting} onClick={handleSubmit}>
              {submitting ? 'Saving...' : editing ? 'Save changes' : 'Create discount type'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
}
