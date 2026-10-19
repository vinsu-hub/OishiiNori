import { useEffect, useState } from 'react';
import { Link } from 'wouter';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { apiErrorDetail, fetchOverrideKeyStatus } from '@/lib/api';

export interface EraseOrderTarget {
  title: string;
  description: string;
}

/** Executive-only permanent delete, confirmed with a reason and the
 * executive's own override key (Settings). Shared by Deliveries and
 * Online Orders. */
export function EraseOrderDialog({
  target,
  onClose,
  onConfirm,
}: {
  target: EraseOrderTarget | null;
  onClose: () => void;
  /** Does the delete; throw to keep the dialog open with the error shown. */
  onConfirm: (body: { override_key: string; reason: string }) => Promise<void>;
}) {
  const [reason, setReason] = useState('');
  const [key, setKey] = useState('');
  const [erasing, setErasing] = useState(false);
  const [hasOverrideKey, setHasOverrideKey] = useState<boolean | null>(null);

  useEffect(() => {
    if (!target) return;
    setReason('');
    setKey('');
    fetchOverrideKeyStatus().then((r) => setHasOverrideKey(r.is_set)).catch(() => setHasOverrideKey(null));
  }, [target]);

  async function confirm() {
    setErasing(true);
    try {
      await onConfirm({ override_key: key, reason: reason.trim() });
      onClose();
    } catch (e) {
      toast.error(apiErrorDetail(e, 'Could not delete the order'));
    } finally {
      setErasing(false);
    }
  }

  return (
    <Dialog open={!!target} onOpenChange={(open) => !open && !erasing && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{target?.title}</DialogTitle>
          <DialogDescription>{target?.description}</DialogDescription>
        </DialogHeader>
        {hasOverrideKey === false ? (
          <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-950">
            You haven’t set an override key yet. <Link href="/settings" className="font-semibold underline">Set it in Settings</Link>, then come back.
          </p>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="erase-reason">Reason</Label>
              <Input id="erase-reason" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. test order, duplicate" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="erase-key">Your override key</Label>
              <Input id="erase-key" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} />
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={erasing}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={confirm} disabled={erasing || hasOverrideKey === false || !reason.trim() || !key}>
            {erasing ? 'Deleting…' : 'Delete permanently'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
