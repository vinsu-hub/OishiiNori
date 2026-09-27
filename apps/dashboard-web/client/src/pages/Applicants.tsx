import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useAuth } from '@/contexts/AuthContext';
import { ApiApplicant, fetchApplicants, updateApplicant } from '@/lib/api';
import { formatDateTime12h } from '@/lib/utils';

type ApplicantStatus = ApiApplicant['status'];
const statuses: ApplicantStatus[] = ['new', 'reviewed', 'contacted', 'rejected', 'hired'];
const labels: Record<ApplicantStatus, string> = {
  new: 'New', reviewed: 'Reviewed', contacted: 'Contacted', rejected: 'Rejected', hired: 'Hired',
};
const colors: Record<ApplicantStatus, string> = {
  new: 'border-blue-300 bg-blue-50 text-blue-800',
  reviewed: 'border-amber-300 bg-amber-50 text-amber-800',
  contacted: 'border-purple-300 bg-purple-50 text-purple-800',
  rejected: 'border-red-300 bg-red-50 text-red-800',
  hired: 'border-green-300 bg-green-50 text-green-800',
};

export default function Applicants() {
  const { user } = useAuth();
  const hasAccess = !user || user.role !== 'employee' || user.extraPages.includes('applicants');
  const [applicants, setApplicants] = useState<ApiApplicant[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [reload, setReload] = useState(0);
  const [status, setStatus] = useState<ApplicantStatus | 'all'>('all');
  const [actingIds, setActingIds] = useState<Set<string>>(new Set());
  const actingRef = useRef(new Set<string>());

  useEffect(() => {
    if (!hasAccess) return;
    let cancelled = false;
    setLoading(true);
    setLoadFailed(false);
    fetchApplicants()
      .then((rows) => { if (!cancelled) setApplicants(rows); })
      .catch((error) => {
        if (cancelled) return;
        setLoadFailed(true);
        toast.error(error instanceof Error ? error.message : 'Failed to load applicants');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [hasAccess, reload]);

  const visible = useMemo(() => applicants
    .filter((applicant) => status === 'all' || applicant.status === status)
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()),
  [applicants, status]);
  const newCount = applicants.filter((applicant) => applicant.status === 'new').length;

  async function changeStatus(applicant: ApiApplicant, nextStatus: ApplicantStatus) {
    if (applicant.status === nextStatus || actingRef.current.has(applicant.id)) return;
    actingRef.current.add(applicant.id);
    setActingIds(new Set(actingRef.current));
    try {
      const updated = await updateApplicant(applicant.id, nextStatus);
      setApplicants((rows) => rows.map((row) => row.id === updated.id ? updated : row));
      toast.success(`Application marked ${labels[nextStatus].toLowerCase()}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to update applicant');
    } finally {
      actingRef.current.delete(applicant.id);
      setActingIds(new Set(actingRef.current));
    }
  }

  return (
    <DashboardLayout title="Applicants">
      {!hasAccess ? (
        <p className="p-6 text-sm text-muted-foreground">You don't have access to this page.</p>
      ) : (
        <div className="space-y-4 p-4 sm:p-6">
          <Card>
            <CardHeader className="space-y-4">
              <div className="flex flex-wrap items-center gap-3">
                <CardTitle className="font-corp-display text-lg">Applicants</CardTitle>
                <Badge variant="secondary">{loading ? 'Loading…' : loadFailed ? 'Unavailable' : `${newCount} new`}</Badge>
              </div>
              <div role="group" aria-label="Filter by status" className="flex flex-wrap gap-1">
                {(['all', ...statuses] as const).map((value) => (
                  <Button key={value} size="sm" variant={status === value ? 'default' : 'outline'}
                    aria-pressed={status === value} onClick={() => setStatus(value)}>
                    {value === 'all' ? 'All' : labels[value]}
                  </Button>
                ))}
              </div>
            </CardHeader>
            <CardContent>
              {loading ? (
                <div role="status" className="flex items-center justify-center gap-2 py-8 text-muted-foreground">
                  <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" /> Loading applicants…
                </div>
              ) : loadFailed ? (
                <div className="space-y-3 py-8 text-center">
                  <p className="text-sm text-muted-foreground">Unable to load applicants.</p>
                  <Button variant="outline" onClick={() => setReload((value) => value + 1)}>Try again</Button>
                </div>
              ) : visible.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  {applicants.length === 0 ? 'No applications yet' : 'No applications match this filter'}
                </p>
              ) : (
                <div className="space-y-3">
                  {visible.map((applicant) => (
                    <Card key={applicant.id}>
                      <CardContent className="min-w-0 space-y-3 p-4">
                        <Badge variant="outline" className={colors[applicant.status]}>{labels[applicant.status]}</Badge>
                        <div className="min-w-0 space-y-1">
                          <h2 className="break-words font-medium [overflow-wrap:anywhere]">{applicant.full_name}</h2>
                          <a className="block break-words text-sm text-primary underline [overflow-wrap:anywhere]"
                            href={`mailto:${applicant.email}`}>{applicant.email}</a>
                          <a className="block break-words text-sm text-primary underline [overflow-wrap:anywhere]"
                            href={`tel:${applicant.phone}`}>{applicant.phone}</a>
                          {applicant.position_interest && (
                            <p className="break-words text-sm [overflow-wrap:anywhere]">Position: {applicant.position_interest}</p>
                          )}
                          <p className="text-xs text-muted-foreground">Submitted {formatDateTime12h(applicant.created_at)}</p>
                        </div>
                        {applicant.message && (
                          <p className="whitespace-pre-wrap break-words text-sm [overflow-wrap:anywhere]">{applicant.message}</p>
                        )}
                        {applicant.resume_photo_url ? (
                          <a href={applicant.resume_photo_url} target="_blank" rel="noopener noreferrer"
                            className="inline-block rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
                            aria-label={`Open resume photo for ${applicant.full_name} in a new tab`}>
                            <img src={applicant.resume_photo_url} alt={`Resume photo for ${applicant.full_name}`}
                              loading="lazy" className="h-24 w-24 rounded border object-cover" />
                            <span className="mt-1 block text-xs text-primary underline">View full photo</span>
                          </a>
                        ) : (
                          <p className="text-xs text-muted-foreground">No photo attached</p>
                        )}
                        <div className="flex flex-wrap items-center gap-2">
                          <Select value={applicant.status} disabled={actingIds.has(applicant.id)}
                            onValueChange={(value) => {
                              if (statuses.includes(value as ApplicantStatus)) {
                                void changeStatus(applicant, value as ApplicantStatus);
                              }
                            }}>
                            <SelectTrigger className="w-full sm:w-44" aria-label={`Change status for ${applicant.full_name}`}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {statuses.map((value) => (
                                <SelectItem key={value} value={value}>{labels[value]}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          {actingIds.has(applicant.id) && (
                            <span role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
                              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Saving…
                            </span>
                          )}
                        </div>
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
