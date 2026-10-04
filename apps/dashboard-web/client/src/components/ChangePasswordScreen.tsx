import React, { useState } from 'react';
import { toast } from 'sonner';
import { KeyRound, Loader2 } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { apiErrorDetail, changeOwnPassword } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

const MIN_LENGTH = 8;

/** Shown instead of every dashboard page while the signed-in account is
 * still on its one-time temporary password (profiles.must_change_password). */
export function ChangePasswordScreen() {
  const { user, logout, markPasswordChanged } = useAuth();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [saving, setSaving] = useState(false);

  const tooShort = password.length > 0 && password.length < MIN_LENGTH;
  const mismatch = confirm.length > 0 && confirm !== password;
  const canSubmit = password.length >= MIN_LENGTH && confirm === password && !saving;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSaving(true);
    try {
      await changeOwnPassword(password);
      toast.success('Password updated -- use it next time you sign in.');
      markPasswordChanged();
    } catch (err) {
      toast.error(apiErrorDetail(err, 'Could not update your password'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm shadow-l2-raised">
        <CardHeader>
          <KeyRound className="mx-auto mb-2 h-10 w-10 text-primary" aria-hidden="true" />
          <CardTitle className="font-corp-display text-2xl text-center">
            Welcome{user?.name ? `, ${user.name.split(' ')[0]}` : ''}
          </CardTitle>
          <CardDescription className="text-center">
            You signed in with a temporary password. Set your own password to continue.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="new-password">New password</Label>
              <Input
                id="new-password"
                type="password"
                autoComplete="new-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                aria-invalid={tooShort}
              />
              <p className={`text-xs ${tooShort ? 'text-destructive' : 'text-muted-foreground'}`}>
                At least {MIN_LENGTH} characters. Don't reuse the temporary password.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirm-password">Confirm new password</Label>
              <Input
                id="confirm-password"
                type="password"
                autoComplete="new-password"
                required
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                aria-invalid={mismatch}
              />
              {mismatch && <p className="text-xs text-destructive">Passwords don't match.</p>}
            </div>
            <Button type="submit" className="w-full" disabled={!canSubmit}>
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              Save and continue
            </Button>
            <Button type="button" variant="ghost" className="w-full" onClick={logout}>
              Sign out
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
