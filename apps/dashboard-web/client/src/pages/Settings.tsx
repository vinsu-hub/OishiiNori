import React, { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useAuth } from '@/contexts/AuthContext';
import { DashboardLayout } from '@/components/DashboardLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Textarea } from '@/components/ui/textarea';
import { fetchBusinessSettings, updateBusinessSettings } from '@/lib/api';

const WEEKDAY_LABELS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

export default function Settings() {
  const { user, logout } = useAuth();

  return (
    <DashboardLayout title="Settings">
      <div className="p-6 space-y-4">
        <Card className="max-w-xl">
          <CardHeader>
            <CardTitle className="font-corp-display">Account</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <p className="text-sm">
              <span className="text-muted-foreground">Name:</span> {user?.name}
            </p>
            <p className="text-sm">
              <span className="text-muted-foreground">Email:</span> {user?.email}
            </p>
            <p className="text-sm capitalize">
              <span className="text-muted-foreground">Role:</span> {user?.role}
            </p>
            <p className="text-sm">
              <span className="text-muted-foreground">Employee Number:</span>{' '}
              {user?.employeeNumber || '-- ask a manager to set this up'}
            </p>
            <p className="text-xs text-muted-foreground">
              Your Employee Number (shown above) plus your kiosk PIN are what Owner's Request, reservation
              overrides, and Start/End Business Day ask for -- not your login password. A manager/executive can
              look up or reset your PIN from the Employees page.
            </p>
            <Button variant="destructive" onClick={logout} className="mt-2">
              Log out
            </Button>
          </CardContent>
        </Card>

        {(user?.role === 'manager' || user?.role === 'executive') && <ReceiptDetailsCard />}

        {user?.role === 'executive' && (
          <>
            <BusinessSettingsCard />
            <BusinessHoursCard />
          </>
        )}
      </div>
    </DashboardLayout>
  );
}

const RECEIPT_FIELDS = [
  { key: 'name', label: 'Business name', placeholder: 'Oishii Nori' },
  { key: 'address', label: 'Address', placeholder: 'Street, barangay, city', multiline: true },
  { key: 'phone', label: 'Phone', placeholder: '0917 123 4567' },
  { key: 'tin', label: 'TIN', placeholder: '000-000-000-000' },
  { key: 'footer', label: 'Footer message', placeholder: 'Thank you! Please come again.' },
] as const;

type ReceiptDetails = Record<(typeof RECEIPT_FIELDS)[number]['key'], string>;

/** Header/footer printed on every customer order slip (manager+). */
function ReceiptDetailsCard() {
  const [details, setDetails] = useState<ReceiptDetails>({ name: '', address: '', phone: '', tin: '', footer: '' });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    fetchBusinessSettings()
      .then((settings) =>
        setDetails({
          name: settings.receipt_business_name ?? '',
          address: settings.receipt_address ?? '',
          phone: settings.receipt_phone ?? '',
          tin: settings.receipt_tin ?? '',
          footer: settings.receipt_footer ?? '',
        })
      )
      .catch((e) => toast.error(`Failed to load receipt details: ${e instanceof Error ? e.message : 'Unknown error'}`))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleSave() {
    setSaving(true);
    try {
      await updateBusinessSettings({
        receipt_business_name: details.name,
        receipt_address: details.address,
        receipt_phone: details.phone,
        receipt_tin: details.tin,
        receipt_footer: details.footer,
      });
      toast.success('Receipt details saved');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save receipt details');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="max-w-xl">
      <CardHeader>
        <CardTitle className="font-corp-display">Receipt details</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : (
          <>
            {RECEIPT_FIELDS.map((field) => {
              const id = `receipt-${field.key}`;
              const onChange = (value: string) => setDetails((d) => ({ ...d, [field.key]: value }));
              return (
                <div key={field.key} className="space-y-1">
                  <Label htmlFor={id}>{field.label}</Label>
                  {'multiline' in field ? (
                    <Textarea
                      id={id}
                      rows={2}
                      placeholder={field.placeholder}
                      value={details[field.key]}
                      onChange={(e) => onChange(e.target.value)}
                    />
                  ) : (
                    <Input
                      id={id}
                      placeholder={field.placeholder}
                      value={details[field.key]}
                      onChange={(e) => onChange(e.target.value)}
                    />
                  )}
                </div>
              );
            })}
            <p className="text-xs text-muted-foreground">
              Printed on every customer order slip. Leave blank to hide a line.
            </p>
            <Button disabled={saving} onClick={handleSave}>
              {saving ? 'Saving...' : 'Save changes'}
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function BusinessSettingsCard() {
  const [vatRatePct, setVatRatePct] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    fetchBusinessSettings()
      .then((s) => setVatRatePct(String(s.vat_rate * 100)))
      .catch((e) => toast.error(`Failed to load business settings: ${e.message}`))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleSave() {
    const pct = Number(vatRatePct);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      toast.error('VAT rate must be between 0 and 100');
      return;
    }
    setSaving(true);
    try {
      await updateBusinessSettings({ vat_rate: pct / 100 });
      toast.success('Business settings saved');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save business settings');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="max-w-xl">
      <CardHeader>
        <CardTitle className="font-corp-display">Business Settings</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : (
          <>
            <div className="space-y-1">
              <Label>VAT rate (%)</Label>
              <Input
                type="number"
                min={0}
                max={100}
                step="0.01"
                value={vatRatePct}
                onChange={(e) => setVatRatePct(e.target.value)}
                className="max-w-[160px]"
              />
              <p className="text-xs text-muted-foreground">
                Applied to every non-exempt sale (POS and digital menu orders). Changing this takes effect
                immediately on new transactions.
              </p>
            </div>
            <Button disabled={saving} onClick={handleSave}>
              {saving ? 'Saving...' : 'Save changes'}
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function BusinessHoursCard() {
  const [openTime, setOpenTime] = useState('');
  const [closeTime, setCloseTime] = useState('');
  const [closedWeekdays, setClosedWeekdays] = useState<number[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    fetchBusinessSettings()
      .then((s) => {
        setOpenTime(s.open_time.slice(0, 5));
        setCloseTime(s.close_time.slice(0, 5));
        setClosedWeekdays(s.closed_weekdays);
      })
      .catch((e) => toast.error(`Failed to load business hours: ${e.message}`))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function toggleWeekday(day: number, checked: boolean) {
    setClosedWeekdays((prev) => (checked ? [...prev, day] : prev.filter((d) => d !== day)));
  }

  async function handleSave() {
    if (!openTime || !closeTime || openTime >= closeTime) {
      toast.error('Open time must be before close time');
      return;
    }
    setSaving(true);
    try {
      await updateBusinessSettings({
        open_time: `${openTime}:00`,
        close_time: `${closeTime}:00`,
        closed_weekdays: closedWeekdays,
      });
      toast.success('Business hours saved');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save business hours');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="max-w-xl">
      <CardHeader>
        <CardTitle className="font-corp-display">Business Hours</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : (
          <>
            <div className="flex items-end gap-3">
              <div className="space-y-1">
                <Label>Open</Label>
                <Input type="time" value={openTime} onChange={(e) => setOpenTime(e.target.value)} className="max-w-[140px]" />
              </div>
              <div className="space-y-1">
                <Label>Close</Label>
                <Input type="time" value={closeTime} onChange={(e) => setCloseTime(e.target.value)} className="max-w-[140px]" />
              </div>
            </div>
            <div className="space-y-1">
              <Label>Closed days</Label>
              <div className="flex flex-wrap gap-3 pt-1">
                {WEEKDAY_LABELS.map((label, day) => (
                  <label key={day} className="flex items-center gap-1.5 text-sm">
                    <Checkbox checked={closedWeekdays.includes(day)} onCheckedChange={(c) => toggleWeekday(day, !!c)} />
                    {label}
                  </label>
                ))}
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Reservation requests outside these hours or on closed days are rejected automatically.
            </p>
            <Button disabled={saving} onClick={handleSave}>
              {saving ? 'Saving...' : 'Save changes'}
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}
