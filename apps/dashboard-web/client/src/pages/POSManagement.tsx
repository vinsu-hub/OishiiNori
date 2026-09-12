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
import {
  ApiDiscountType,
  ApiOnlinePaymentMethod,
  createDiscountType,
  createPaymentMethod,
  deletePaymentMethod,
  fetchAllPaymentMethods,
  fetchDiscountTypes,
  updateDiscountType,
  updatePaymentMethod,
  uploadPaymentMethodQrCode,
} from '@/lib/api';

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

  const isExecutive = user?.role === 'executive';

  const [paymentMethods, setPaymentMethods] = useState<ApiOnlinePaymentMethod[]>([]);
  const [paymentMethodsLoading, setPaymentMethodsLoading] = useState(true);
  const [pmFormOpen, setPmFormOpen] = useState(false);
  const [pmEditing, setPmEditing] = useState<ApiOnlinePaymentMethod | null>(null);
  const [pmName, setPmName] = useState('');
  const [pmAccountName, setPmAccountName] = useState('');
  const [pmAccountNumber, setPmAccountNumber] = useState('');
  const [pmSubmitting, setPmSubmitting] = useState(false);
  const [pmQrTarget, setPmQrTarget] = useState<ApiOnlinePaymentMethod | null>(null);
  const [pmQrFile, setPmQrFile] = useState<File | null>(null);
  const [pmQrUploading, setPmQrUploading] = useState(false);
  const [pmDeleteTarget, setPmDeleteTarget] = useState<ApiOnlinePaymentMethod | null>(null);
  const [pmDeleting, setPmDeleting] = useState(false);

  const load = useCallback(() => {
    fetchDiscountTypes(false)
      .then((data) => setDiscountTypes([...data].sort((a, b) => a.name.localeCompare(b.name))))
      .catch((e) => toast.error(`Failed to load discount types: ${e.message}`))
      .finally(() => setLoading(false));
  }, []);

  const loadPaymentMethods = useCallback(() => {
    fetchAllPaymentMethods()
      .then(setPaymentMethods)
      .catch((e) => toast.error(`Failed to load payment methods: ${e.message}`))
      .finally(() => setPaymentMethodsLoading(false));
  }, []);

  useEffect(() => {
    load();
    loadPaymentMethods();
  }, [load, loadPaymentMethods]);

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

  function openPmCreate() {
    setPmEditing(null);
    setPmName('');
    setPmAccountName('');
    setPmAccountNumber('');
    setPmFormOpen(true);
  }

  function openPmEdit(m: ApiOnlinePaymentMethod) {
    setPmEditing(m);
    setPmName(m.name);
    setPmAccountName(m.account_name);
    setPmAccountNumber(m.account_number);
    setPmFormOpen(true);
  }

  async function handlePmSubmit() {
    if (!pmName.trim() || !pmAccountName.trim() || !pmAccountNumber.trim()) {
      toast.error('Name, account name, and account number are all required');
      return;
    }
    setPmSubmitting(true);
    try {
      if (pmEditing) {
        await updatePaymentMethod(pmEditing.id, {
          name: pmName.trim(),
          account_name: pmAccountName.trim(),
          account_number: pmAccountNumber.trim(),
        });
        toast.success(`${pmName.trim()} updated`);
      } else {
        await createPaymentMethod({
          name: pmName.trim(),
          account_name: pmAccountName.trim(),
          account_number: pmAccountNumber.trim(),
        });
        toast.success(`${pmName.trim()} created`);
      }
      setPmFormOpen(false);
      loadPaymentMethods();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save payment method');
    } finally {
      setPmSubmitting(false);
    }
  }

  async function togglePmActive(m: ApiOnlinePaymentMethod) {
    try {
      await updatePaymentMethod(m.id, { active: !m.active });
      loadPaymentMethods();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to update payment method');
    }
  }

  async function handlePmQrUpload() {
    if (!pmQrTarget || !pmQrFile) return;
    setPmQrUploading(true);
    try {
      await uploadPaymentMethodQrCode(pmQrTarget.id, pmQrFile);
      toast.success('QR code updated');
      setPmQrTarget(null);
      setPmQrFile(null);
      loadPaymentMethods();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to upload QR code');
    } finally {
      setPmQrUploading(false);
    }
  }

  async function handlePmDelete() {
    if (!pmDeleteTarget) return;
    setPmDeleting(true);
    try {
      await deletePaymentMethod(pmDeleteTarget.id);
      toast.success(`${pmDeleteTarget.name} deleted`);
      setPmDeleteTarget(null);
      loadPaymentMethods();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to delete payment method');
    } finally {
      setPmDeleting(false);
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

        <div className="flex items-center justify-between pt-4">
          <p className="text-sm text-muted-foreground">
            Online payment methods (GCash, Maya, Maribank, ...) offered at Customer Menu delivery/pickup checkout.
          </p>
          {isExecutive && <Button onClick={openPmCreate}>Add payment method</Button>}
        </div>

        {paymentMethodsLoading && <p className="text-sm text-muted-foreground">Loading payment methods...</p>}
        {!paymentMethodsLoading && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Account name</TableHead>
                <TableHead>Account number</TableHead>
                <TableHead>QR code</TableHead>
                <TableHead>Active</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {paymentMethods.map((m) => (
                <TableRow key={m.id}>
                  <TableCell className="font-medium">{m.name}</TableCell>
                  <TableCell>{m.account_name}</TableCell>
                  <TableCell className="font-mono text-xs">{m.account_number}</TableCell>
                  <TableCell>
                    {m.qr_code_url ? (
                      <img src={m.qr_code_url} alt={`${m.name} QR`} className="h-10 w-10 rounded object-cover" />
                    ) : (
                      <span className="text-xs text-muted-foreground">None</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Switch
                      checked={m.active}
                      disabled={!isExecutive}
                      onCheckedChange={() => togglePmActive(m)}
                    />
                  </TableCell>
                  <TableCell className="space-x-2 whitespace-nowrap">
                    {isExecutive && (
                      <>
                        <Button size="sm" variant="outline" onClick={() => openPmEdit(m)}>
                          Edit
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => setPmQrTarget(m)}>
                          QR code
                        </Button>
                        <Button size="sm" variant="destructive" onClick={() => setPmDeleteTarget(m)}>
                          Delete
                        </Button>
                      </>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {paymentMethods.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-sm text-muted-foreground">
                    No payment methods yet.
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

      <Dialog open={pmFormOpen} onOpenChange={setPmFormOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{pmEditing ? `Edit ${pmEditing.name}` : 'Add payment method'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>Name (shown to customers, e.g. "GCash")</Label>
              <Input value={pmName} onChange={(e) => setPmName(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>Account name</Label>
              <Input value={pmAccountName} onChange={(e) => setPmAccountName(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>Account number</Label>
              <Input value={pmAccountNumber} onChange={(e) => setPmAccountNumber(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button disabled={pmSubmitting} onClick={handlePmSubmit}>
              {pmSubmitting ? 'Saving...' : pmEditing ? 'Save changes' : 'Create payment method'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!pmQrTarget}
        onOpenChange={(open) => {
          if (!open) {
            setPmQrTarget(null);
            setPmQrFile(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>QR code for {pmQrTarget?.name}</DialogTitle>
          </DialogHeader>
          {pmQrTarget?.qr_code_url && (
            <img src={pmQrTarget.qr_code_url} alt="Current QR code" className="mx-auto h-40 w-40 rounded object-cover" />
          )}
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            onChange={(e) => setPmQrFile(e.target.files?.[0] ?? null)}
          />
          <DialogFooter>
            <Button disabled={!pmQrFile || pmQrUploading} onClick={handlePmQrUpload}>
              {pmQrUploading ? 'Uploading...' : 'Upload'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!pmDeleteTarget} onOpenChange={(open) => !open && setPmDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {pmDeleteTarget?.name}?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            This removes it from the Customer Menu checkout. Past orders that used this method keep their own
            record of it (the name is saved on the order, not linked live), so nothing historical is affected.
          </p>
          <DialogFooter>
            <Button variant="destructive" disabled={pmDeleting} onClick={handlePmDelete}>
              {pmDeleting ? 'Deleting...' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
}
