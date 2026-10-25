import React, { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { DashboardLayout } from '@/components/DashboardLayout';
import { useAuth } from '@/contexts/AuthContext';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Loader2, Star } from 'lucide-react';
import { ApiReview, approveReview, fetchReviews, rejectReview, setReviewOnWebsite } from '@/lib/api';
import { formatDateTime12h } from '@/lib/utils';

function StarRating({ rating }: { rating: number }) {
  return (
    <span className="inline-flex items-center gap-0.5">
      {Array.from({ length: 5 }, (_, i) => (
        <Star
          key={i}
          className={`w-3.5 h-3.5 ${i < rating ? 'fill-amber-400 text-amber-400' : 'text-muted-foreground/30'}`}
        />
      ))}
    </span>
  );
}

// Public submission on Landing Page (`POST /public/reviews`) -> this
// moderation queue. Approved reviews switched to "Show on website" appear
// in the carousel on the Landing Page's Reviews page.
export default function Reviews() {
  const { user } = useAuth();
  const [reviews, setReviews] = useState<ApiReview[]>([]);
  const [loading, setLoading] = useState(true);
  const [actingId, setActingId] = useState<string | null>(null);
  const [rejectTarget, setRejectTarget] = useState<ApiReview | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    fetchReviews()
      .then(setReviews)
      .catch((e) => toast.error(e instanceof Error ? e.message : 'Failed to load reviews'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleApprove(id: string) {
    setActingId(id);
    try {
      await approveReview(id);
      toast.success('Review approved');
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to approve review');
    } finally {
      setActingId(null);
    }
  }

  async function handleWebsiteToggle(review: ApiReview, show: boolean) {
    const flip = (value: boolean) =>
      setReviews((rows) => rows.map((r) => (r.id === review.id ? { ...r, show_on_website: value } : r)));
    flip(show);
    try {
      await setReviewOnWebsite(review.id, show);
      toast.success(show ? 'Now showing on the website' : 'Hidden from the website');
    } catch (e) {
      flip(!show);
      toast.error(e instanceof Error ? e.message : 'Failed to update the website');
    }
  }

  async function handleReject() {
    if (!rejectTarget) return;
    if (!rejectReason.trim()) {
      toast.error('A reason is required');
      return;
    }
    setActingId(rejectTarget.id);
    try {
      await rejectReview(rejectTarget.id, rejectReason.trim());
      toast.success('Review rejected');
      setRejectTarget(null);
      setRejectReason('');
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to reject review');
    } finally {
      setActingId(null);
    }
  }

  if (user && user.role === 'employee' && !user.extraPages.includes('reviews')) {
    return (
      <DashboardLayout title="Customer Reviews">
        <div className="p-6">
          <p className="text-sm text-muted-foreground">You don't have access to this page.</p>
        </div>
      </DashboardLayout>
    );
  }

  const pending = reviews.filter((r) => r.status === 'pending');
  const decided = reviews.filter((r) => r.status !== 'pending');
  const onWebsite = decided.filter((r) => r.status === 'approved' && r.show_on_website).length;

  return (
    <DashboardLayout title="Customer Reviews">
      <div className="p-6 space-y-4">
        <Card>
          <CardHeader>
            <CardTitle className="font-corp-display text-base">
              {loading ? 'Loading...' : `${pending.length} pending review${pending.length === 1 ? '' : 's'}`}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="flex items-center justify-center py-8 text-muted-foreground">
                <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                Loading...
              </div>
            ) : pending.length === 0 ? (
              <p className="text-sm text-muted-foreground py-8 text-center">No pending reviews.</p>
            ) : (
              <div className="space-y-2">
                {pending.map((r) => (
                  <div key={r.id} className="border rounded-md p-3 flex items-start justify-between gap-3">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <StarRating rating={r.rating} />
                        <span className="text-sm font-medium">
                          {r.is_anonymous ? 'Anonymous' : r.customer_name}
                        </span>
                      </div>
                      <p className="text-sm">{r.body}</p>
                      {r.photo_url && (
                        <a href={r.photo_url} target="_blank" rel="noreferrer">
                          <img
                            src={r.photo_url}
                            alt="Review photo"
                            className="h-16 w-16 rounded object-cover border"
                          />
                        </a>
                      )}
                      <p className="text-xs text-muted-foreground">submitted {formatDateTime12h(r.created_at)}</p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={actingId === r.id}
                        onClick={() => {
                          setRejectTarget(r);
                          setRejectReason('');
                        }}
                      >
                        Reject
                      </Button>
                      <Button size="sm" disabled={actingId === r.id} onClick={() => handleApprove(r.id)}>
                        {actingId === r.id ? 'Working...' : 'Approve'}
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {decided.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="font-corp-display text-base">History</CardTitle>
              <p className="text-xs text-muted-foreground">
                {onWebsite} shown on the website's Reviews page. Switch on the approved reviews you want customers to see.
              </p>
            </CardHeader>
            <CardContent className="space-y-2">
              {decided.map((r) => (
                <div key={r.id} className="flex items-start justify-between gap-3 text-sm border-b pb-2">
                  <div className="space-y-0.5">
                    <div className="flex items-center gap-2">
                      <StarRating rating={r.rating} />
                      <span className="font-medium">{r.is_anonymous ? 'Anonymous' : r.customer_name}</span>
                    </div>
                    <p className="text-muted-foreground">{r.body}</p>
                    {r.photo_url && (
                      <a href={r.photo_url} target="_blank" rel="noreferrer">
                        <img src={r.photo_url} alt="Review photo" className="h-12 w-12 rounded object-cover border" />
                      </a>
                    )}
                    {r.status === 'rejected' && r.rejected_reason && (
                      <p className="text-xs text-muted-foreground">Reason: {r.rejected_reason}</p>
                    )}
                    {r.decided_at && (
                      <p className="text-xs text-muted-foreground">decided {formatDateTime12h(r.decided_at)}</p>
                    )}
                  </div>
                  <div className="flex flex-col items-end gap-2 shrink-0">
                    <Badge variant={r.status === 'approved' ? 'default' : 'secondary'}>{r.status}</Badge>
                    {r.status === 'approved' && (
                      <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
                        Show on website
                        <Switch
                          checked={r.show_on_website}
                          onCheckedChange={(checked) => handleWebsiteToggle(r, checked)}
                        />
                      </label>
                    )}
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        )}
      </div>

      <Dialog open={!!rejectTarget} onOpenChange={(open) => !open && setRejectTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject this review?</DialogTitle>
          </DialogHeader>
          <Input
            placeholder="Reason for rejecting"
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
          />
          <DialogFooter>
            <Button variant="destructive" disabled={actingId === rejectTarget?.id} onClick={handleReject}>
              {actingId === rejectTarget?.id ? 'Rejecting...' : 'Reject review'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
}
