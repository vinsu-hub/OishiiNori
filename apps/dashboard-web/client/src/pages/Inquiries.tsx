import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/contexts/AuthContext';
import { ApiInquiry, InquiryKind, InquiryStatus, fetchInquiries, updateInquiry } from '@/lib/api';
import { formatDateTime12h } from '@/lib/utils';

function formatEventDate(value: string) {
  // Date-only submissions represent a local calendar day, not a UTC instant.
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00` : value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric',
  });
}

export default function Inquiries() {
  const { user } = useAuth();
  const hasAccess = !user || user.role !== 'employee' || user.extraPages.includes('inquiries');
  const [inquiries, setInquiries] = useState<ApiInquiry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [reload, setReload] = useState(0);
  const [status, setStatus] = useState<InquiryStatus | 'all'>('all');
  const [kind, setKind] = useState<InquiryKind | 'all'>('all');
  const [actingIds, setActingIds] = useState<Set<string>>(new Set());
  const actingRef = useRef(new Set<string>());

  useEffect(() => {
    if (!hasAccess) return;
    let cancelled = false;
    setLoading(true);
    setLoadFailed(false);
    fetchInquiries({})
      .then((rows) => { if (!cancelled) setInquiries(rows); })
      .catch((error) => {
        if (cancelled) return;
        setLoadFailed(true);
        toast.error(error instanceof Error ? error.message : 'Failed to load inquiries');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [hasAccess, reload]);

  const visible = useMemo(() => inquiries
    .filter((inquiry) => (status === 'all' || inquiry.status === status)
      && (kind === 'all' || inquiry.kind === kind))
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()),
  [inquiries, status, kind]);
  const newCount = inquiries.filter((inquiry) => inquiry.status === 'new').length;

  async function changeStatus(inquiry: ApiInquiry) {
    if (actingRef.current.has(inquiry.id)) return;
    actingRef.current.add(inquiry.id);
    setActingIds(new Set(actingRef.current));
    const nextStatus = inquiry.status === 'new' ? 'handled' : 'new';
    try {
      // Keep the existing row until the server confirms the update, so failures
      // cannot leave the inbox or its filtered counts in an optimistic state.
      const updated = await updateInquiry(inquiry.id, nextStatus);
      setInquiries((rows) => rows.map((row) => row.id === updated.id ? updated : row));
      toast.success(nextStatus === 'handled' ? 'Inquiry marked handled' : 'Inquiry reopened');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to update inquiry');
    } finally {
      actingRef.current.delete(inquiry.id);
      setActingIds(new Set(actingRef.current));
    }
  }

  return (
    <DashboardLayout title="Inquiries">
      {!hasAccess ? (
        <p className="p-6 text-sm text-muted-foreground">You don't have access to this page.</p>
      ) : (
        <div className="space-y-4 p-4 sm:p-6">
          <Card>
            <CardHeader className="space-y-4">
              <div className="flex flex-wrap items-center gap-3">
                <CardTitle className="font-corp-display text-lg">Inquiries</CardTitle>
                <Badge variant="secondary">{loading ? 'Loading…' : `${newCount} new`}</Badge>
              </div>
              <div className="flex flex-col gap-3 sm:flex-row sm:justify-between">
                <div role="group" aria-label="Filter by status" className="flex flex-wrap gap-1">
                  {(['all', 'new', 'handled'] as const).map((value) => (
                    <Button key={value} size="sm" variant={status === value ? 'default' : 'outline'}
                      aria-pressed={status === value} onClick={() => setStatus(value)}>
                      {value === 'all' ? 'All' : value === 'new' ? 'New' : 'Handled'}
                    </Button>
                  ))}
                </div>
                <div role="group" aria-label="Filter by kind" className="flex flex-wrap gap-1">
                  {(['all', 'catering', 'contact'] as const).map((value) => (
                    <Button key={value} size="sm" variant={kind === value ? 'default' : 'outline'}
                      aria-pressed={kind === value} onClick={() => setKind(value)}>
                      {value === 'all' ? 'All' : value === 'catering' ? 'Catering' : 'Contact'}
                    </Button>
                  ))}
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {loading ? (
                <div role="status" className="flex items-center justify-center gap-2 py-8 text-muted-foreground">
                  <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" /> Loading inquiries…
                </div>
              ) : loadFailed ? (
                <div className="space-y-3 py-8 text-center">
                  <p className="text-sm text-muted-foreground">Unable to load inquiries.</p>
                  <Button variant="outline" onClick={() => setReload((value) => value + 1)}>Try again</Button>
                </div>
              ) : visible.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  {inquiries.length === 0 ? 'No inquiries yet' : 'No inquiries match these filters'}
                </p>
              ) : (
                <div className="space-y-3">
                  {visible.map((inquiry) => (
                    <Card key={inquiry.id}>
                      <CardContent className="space-y-3 p-4">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant="outline" className={inquiry.kind === 'catering'
                            ? 'border-amber-300 bg-amber-50 text-amber-800'
                            : 'border-blue-300 bg-blue-50 text-blue-800'}>
                            {inquiry.kind === 'catering' ? 'Catering' : 'Contact'}
                          </Badge>
                          <Badge variant={inquiry.status === 'new' ? 'default' : 'secondary'}>
                            {inquiry.status === 'new' ? 'New' : 'Handled'}
                          </Badge>
                        </div>
                        <div className="min-w-0 space-y-1">
                          <h2 className="break-words font-medium [overflow-wrap:anywhere]">{inquiry.name}</h2>
                          <a className="block break-words text-sm text-primary underline [overflow-wrap:anywhere]"
                            href={`mailto:${inquiry.email}`}>{inquiry.email}</a>
                          {inquiry.phone && (
                            <a className="block break-words text-sm text-primary underline [overflow-wrap:anywhere]"
                              href={`tel:${inquiry.phone}`}>{inquiry.phone}</a>
                          )}
                          <p className="text-xs text-muted-foreground">Submitted {formatDateTime12h(inquiry.created_at)}</p>
                        </div>
                        {inquiry.kind === 'catering' && (
                          <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
                            <span>Event date: {inquiry.event_date ? formatEventDate(inquiry.event_date) : 'Not provided'}</span>
                            <span>Guests: {inquiry.guest_count ?? 'Not provided'}</span>
                          </div>
                        )}
                        <p className="whitespace-pre-wrap break-words text-sm [overflow-wrap:anywhere]">{inquiry.message}</p>
                        <Button size="sm" variant={inquiry.status === 'new' ? 'default' : 'outline'}
                          disabled={actingIds.has(inquiry.id)} onClick={() => changeStatus(inquiry)}>
                          {actingIds.has(inquiry.id) && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
                          {inquiry.status === 'new' ? 'Mark handled' : 'Reopen'}
                        </Button>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </DashboardLayout>
  );
}
