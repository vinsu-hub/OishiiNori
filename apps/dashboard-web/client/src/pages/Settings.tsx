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
import { apiErrorDetail, changeOwnPassword, fetchBusinessSettings, fetchOverrideKeyStatus, setOverrideKey, updateBusinessSettings } from '@/lib/api';

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

        <ChangePasswordCard />

        {(user?.role === 'manager' || user?.role === 'executive') && <ReceiptDetailsCard />}

        {user?.role === 'executive' && (
          <>
            <OverrideKeyCard />
            <FirstOrderPromoCard />
            <BusinessSettingsCard />
            <BusinessHoursCard />
          </>
        )}
      </div>
    </DashboardLayout>
  );
}

const MIN_PASSWORD_LENGTH = 8;

/** Every account can change its own login password here. The server checks
 * the current password, so a signed-in tablet left unattended can't be used
 * to take the account over. */
function ChangePasswordCard() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [saving, setSaving] = useState(false);

  const tooShort = next.length > 0 && next.length < MIN_PASSWORD_LENGTH;
  const mismatch = confirm.length > 0 && confirm !== next;
  const canSave = current.length > 0 && next.length >= MIN_PASSWORD_LENGTH && confirm === next && !saving;

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!canSave) return;
    setSaving(true);
    try {
      await changeOwnPassword(next, current);
      toast.success('Password changed -- use it the next time you sign in.');
      setCurrent('');
      setNext('');
      setConfirm('');
    } catch (err) {
      toast.error(apiErrorDetail(err, 'Could not change your password'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="max-w-xl">
      <CardHeader>
        <CardTitle className="font-corp-display">Change password</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSave} className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="current-password">Current password</Label>
            <Input
              id="current-password"
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="settings-new-password">New password</Label>
            <Input
              id="settings-new-password"
              type="password"
              autoComplete="new-password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              aria-invalid={tooShort}
            />
            <p className={`text-xs ${tooShort ? 'text-destructive' : 'text-muted-foreground'}`}>
              At least {MIN_PASSWORD_LENGTH} characters. Don't share it with anyone.
            </p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="settings-confirm-password">Confirm new password</Label>
            <Input
              id="settings-confirm-password"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              aria-invalid={mismatch}
            />
            {mismatch && <p className="text-xs text-destructive">Passwords don't match.</p>}
          </div>
          <Button type="submit" disabled={!canSave}>
            {saving ? 'Saving...' : 'Change password'}
          </Button>
        </form>
      </CardContent>
    </Card>
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
            {/* Address and footer are kept in settings but no longer printed on the slip. */}
            {RECEIPT_FIELDS.filter((field) => field.key !== 'address' && field.key !== 'footer').map((field) => {
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

/** Executives' own override key: authorizes permanently erasing an order (Deliveries). */
function OverrideKeyCard() {
  const [isSet, setIsSet] = useState<boolean | null>(null);
  const [employeeNumber, setEmployeeNumber] = useState('');
  const [pin, setPin] = useState('');
  const [newKey, setNewKey] = useState('');
  const [confirmKey, setConfirmKey] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetchOverrideKeyStatus().then((r) => setIsSet(r.is_set)).catch(() => setIsSet(false));
  }, []);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (newKey.trim().length < 6) { toast.error('Use at least 6 characters for the override key'); return; }
    if (newKey !== confirmKey) { toast.error('The two keys don’t match'); return; }
    setSaving(true);
    try {
      await setOverrideKey({ employee_number: employeeNumber, pin, new_key: newKey });
      setIsSet(true);
      setPin(''); setNewKey(''); setConfirmKey('');
      toast.success('Override key saved');
    } catch (error) {
      toast.error(apiErrorDetail(error, 'Could not save the override key'));
    } finally { setSaving(false); }
  }

  return (
    <Card className="max-w-xl">
      <CardHeader>
        <CardTitle className="font-corp-display">Override key</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Your personal key for permanently deleting an order on the Deliveries page. Keep it private; nobody else can see it.
        </p>
        <p className="text-sm font-medium">{isSet === null ? 'Checking…' : isSet ? 'Key set ✓' : 'No key yet'}</p>
        <form onSubmit={save} className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1"><Label htmlFor="ok-emp">Your employee number</Label><Input id="ok-emp" value={employeeNumber} onChange={(e) => setEmployeeNumber(e.target.value)} autoComplete="off" /></div>
          <div className="space-y-1"><Label htmlFor="ok-pin">Your kiosk PIN</Label><Input id="ok-pin" type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value)} autoComplete="off" /></div>
          <div className="space-y-1"><Label htmlFor="ok-new">{isSet ? 'New override key' : 'Override key'}</Label><Input id="ok-new" type="password" value={newKey} onChange={(e) => setNewKey(e.target.value)} autoComplete="new-password" /></div>
          <div className="space-y-1"><Label htmlFor="ok-confirm">Type it again</Label><Input id="ok-confirm" type="password" value={confirmKey} onChange={(e) => setConfirmKey(e.target.value)} autoComplete="new-password" /></div>
          <div className="sm:col-span-2"><Button type="submit" disabled={saving || !employeeNumber || !pin}>{saving ? 'Saving…' : isSet ? 'Change override key' : 'Set override key'}</Button></div>
        </form>
      </CardContent>
    </Card>
  );
}

/** First online order of the day gets a free 4 pcs Torikatsu Maki (on/off). */
function FirstOrderPromoCard() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetchBusinessSettings()
      .then((settings) => setEnabled(!!settings.first_order_promo_size_id))
      .catch(() => setEnabled(null));
  }, []);

  async function toggle(next: boolean) {
    setSaving(true);
    const previous = enabled;
    setEnabled(next);
    try {
      const settings = await updateBusinessSettings({ first_order_promo_enabled: next });
      setEnabled(!!settings.first_order_promo_size_id);
      toast.success(next ? 'First-order promo turned on' : 'First-order promo turned off');
    } catch (error) {
      setEnabled(previous);
      toast.error(apiErrorDetail(error, 'Could not update the promo'));
    } finally { setSaving(false); }
  }

  return (
    <Card className="max-w-xl">
      <CardHeader>
        <CardTitle className="font-corp-display">Online order promo</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex items-start gap-3">
          <Checkbox
            id="first-order-promo"
            checked={!!enabled}
            disabled={enabled === null || saving}
            onCheckedChange={(value) => { void toggle(value === true); }}
          />
          <Label htmlFor="first-order-promo" className="leading-snug">
            Free 4 pcs Torikatsu Maki for the first online order each day
          </Label>
        </div>
        <p className="text-xs text-muted-foreground">
          The first delivery or pickup order from the website each day gets it free, and the customer sees a pop-up. If that order is declined, the next customer gets it.
        </p>
      </CardContent>
    </Card>
  );
}
