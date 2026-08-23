import React, { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useAuth } from '@/contexts/AuthContext';
import { DashboardLayout } from '@/components/DashboardLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { fetchBusinessSettings, updateBusinessSettings } from '@/lib/api';

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
            <Button variant="destructive" onClick={logout} className="mt-2">
              Log out
            </Button>
          </CardContent>
        </Card>

        {user?.role === 'executive' && <BusinessSettingsCard />}
      </div>
    </DashboardLayout>
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
