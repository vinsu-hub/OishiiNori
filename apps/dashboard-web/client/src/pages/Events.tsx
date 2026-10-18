import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { CalendarDays, ImagePlus, MapPin, Pencil, Plus, Trash2, Users } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardLayout';
import { useAuth } from '@/contexts/AuthContext';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  type ApiEvent,
  type ApiEventSignup,
  type EventPayload,
  type EventSignupStatus,
  apiErrorDetail,
  createEvent,
  deleteEvent,
  fetchEventSignups,
  fetchEvents,
  updateEvent,
  updateEventSignupStatus,
  uploadEventImage,
} from '@/lib/api';
import { phInputTime, phLocalToIso } from '@/lib/advanceOrders';

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

function eventWhen(event: ApiEvent): string {
  const format = (iso: string) =>
    new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
  return event.ends_at ? `${format(event.starts_at)} – ${format(event.ends_at)}` : format(event.starts_at);
}

type ToggleKey = 'listed' | 'signups_open' | 'slots_full';

interface FormState {
  title: string;
  description: string;
  location: string;
  startsAt: string;
  endsAt: string;
  priceLabel: string;
  image: File | null;
}

const EMPTY_FORM: FormState = { title: '', description: '', location: '', startsAt: '', endsAt: '', priceLabel: '', image: null };

/** Events shown on the website's Events tab, with sign-ups (executives / `events` grant). */
export default function Events() {
  const { user } = useAuth();
  const allowed = !!user && (user.role === 'executive' || user.extraPages.includes('events'));
  const [events, setEvents] = useState<ApiEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<ApiEvent | 'new' | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ApiEvent | null>(null);
  const [signupsFor, setSignupsFor] = useState<ApiEvent | null>(null);
  const [signups, setSignups] = useState<ApiEventSignup[]>([]);

  const load = useCallback(() => {
    fetchEvents()
      .then(setEvents)
      .catch((e) => toast.error(apiErrorDetail(e, 'Could not load events')))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    if (allowed) load();
  }, [allowed, load]);

  function openEditor(target: ApiEvent | 'new') {
    setForm(target === 'new' ? EMPTY_FORM : {
      title: target.title,
      description: target.description,
      location: target.location,
      startsAt: phInputTime(new Date(target.starts_at)),
      endsAt: target.ends_at ? phInputTime(new Date(target.ends_at)) : '',
      priceLabel: target.price_label ?? '',
      image: null,
    });
    setEditing(target);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!form.title.trim()) { toast.error('Add a title'); return; }
    if (form.image && (!IMAGE_TYPES.includes(form.image.type) || form.image.size > MAX_IMAGE_BYTES)) {
      toast.error('Use a JPEG, PNG or WEBP image of 5 MB or less');
      return;
    }
    let body: EventPayload;
    try {
      body = {
        title: form.title.trim(),
        description: form.description.trim(),
        location: form.location.trim(),
        starts_at: phLocalToIso(form.startsAt),
        ends_at: form.endsAt ? phLocalToIso(form.endsAt) : null,
        price_label: form.priceLabel.trim() || null,
      };
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Choose a date and time');
      return;
    }
    setSaving(true);
    try {
      const saved = editing === 'new' ? await createEvent(body) : await updateEvent((editing as ApiEvent).id, body);
      if (form.image) await uploadEventImage(saved.id, form.image);
      toast.success(editing === 'new' ? 'Event created — it shows on the website' : 'Event saved');
      setEditing(null);
      load();
    } catch (e) {
      toast.error(apiErrorDetail(e, 'Could not save the event'));
    } finally {
      setSaving(false);
    }
  }

  async function toggle(event: ApiEvent, key: ToggleKey, value: boolean) {
    setEvents((rows) => rows.map((row) => (row.id === event.id ? { ...row, [key]: value } : row)));
    try {
      await updateEvent(event.id, { [key]: value });
    } catch (e) {
      setEvents((rows) => rows.map((row) => (row.id === event.id ? { ...row, [key]: event[key] } : row)));
      toast.error(apiErrorDetail(e, 'Could not update the event'));
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    try {
      await deleteEvent(deleteTarget.id);
      toast.success('Event deleted');
      setDeleteTarget(null);
      load();
    } catch (e) {
      toast.error(apiErrorDetail(e, 'Could not delete the event'));
    }
  }

  async function openSignups(event: ApiEvent) {
    setSignupsFor(event);
    setSignups([]);
    try {
      setSignups(await fetchEventSignups(event.id));
    } catch (e) {
      toast.error(apiErrorDetail(e, 'Could not load sign-ups'));
    }
  }

  async function setSignupStatus(signup: ApiEventSignup, status: EventSignupStatus) {
    setSignups((rows) => rows.map((row) => (row.id === signup.id ? { ...row, status } : row)));
    try {
      await updateEventSignupStatus(signup.id, status);
      load();
    } catch (e) {
      setSignups((rows) => rows.map((row) => (row.id === signup.id ? signup : row)));
      toast.error(apiErrorDetail(e, 'Could not update the sign-up'));
    }
  }

  if (user && !allowed) {
    return (
      <DashboardLayout title="Events">
        <div className="p-6"><p className="text-sm text-muted-foreground">You don't have access to this page.</p></div>
      </DashboardLayout>
    );
  }

  const activeSignups = signups.filter((s) => s.status !== 'cancelled');

  return (
    <DashboardLayout title="Events">
      <div className="space-y-4 p-4 sm:p-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">Website events</h2>
            <p className="text-sm text-muted-foreground">
              Listed events appear on the website's Events tab. Customers sign up there; you confirm them by phone.
            </p>
          </div>
          <Button className="min-h-11 gap-2" onClick={() => openEditor('new')}>
            <Plus className="h-4 w-4" aria-hidden /> New event
          </Button>
        </div>

        {loading ? (
          <p className="text-sm text-muted-foreground">Loading events…</p>
        ) : events.length === 0 ? (
          <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">No events yet.</p>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
            {events.map((event) => (
              <Card key={event.id} className="overflow-hidden">
                {event.image_url ? (
                  <img src={event.image_url} alt={event.title} className="aspect-[4/3] w-full object-cover" loading="lazy" />
                ) : (
                  <div className="flex aspect-[4/3] items-center justify-center bg-muted text-sm text-muted-foreground">No image yet</div>
                )}
                <CardContent className="space-y-3 pt-4">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-semibold">{event.title}</h3>
                      {event.new_signups > 0 && <Badge className="bg-amber-500 text-white hover:bg-amber-500">{event.new_signups} new</Badge>}
                    </div>
                    <p className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground">
                      <CalendarDays className="h-4 w-4 shrink-0" aria-hidden /> {eventWhen(event)}
                    </p>
                    {event.location && (
                      <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
                        <MapPin className="h-4 w-4 shrink-0" aria-hidden /> {event.location}
                      </p>
                    )}
                    {event.price_label && <p className="text-sm font-medium">{event.price_label}</p>}
                  </div>
                  <div className="space-y-2 rounded-md bg-muted/50 p-3">
                    {([
                      ['listed', 'Listed on website'],
                      ['signups_open', 'Sign-ups open'],
                      ['slots_full', 'Slots full'],
                    ] as [ToggleKey, string][]).map(([key, label]) => (
                      <div key={key} className="flex items-center justify-between gap-3">
                        <Label htmlFor={`${event.id}-${key}`} className="text-sm">{label}</Label>
                        <Switch
                          id={`${event.id}-${key}`}
                          checked={event[key]}
                          onCheckedChange={(value) => { void toggle(event, key, value); }}
                        />
                      </div>
                    ))}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="outline" className="min-h-10 gap-2" onClick={() => openSignups(event)}>
                      <Users className="h-4 w-4" aria-hidden /> Sign-ups ({event.signup_count} · {event.slots_taken} slots)
                    </Button>
                    <Button variant="outline" className="min-h-10 gap-2" onClick={() => openEditor(event)}>
                      <Pencil className="h-4 w-4" aria-hidden /> Edit
                    </Button>
                    <Button variant="ghost" className="min-h-10 gap-2 text-red-700" onClick={() => setDeleteTarget(event)}>
                      <Trash2 className="h-4 w-4" aria-hidden /> Delete
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing === 'new' ? 'New event' : 'Edit event'}</DialogTitle>
            <DialogDescription>Times are Philippine time.</DialogDescription>
          </DialogHeader>
          <form onSubmit={save} className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="ev-title">Title</Label>
              <Input id="ev-title" maxLength={160} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="ev-description">Description</Label>
              <Textarea id="ev-description" rows={5} maxLength={4000} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="ev-location">Location</Label>
              <Input id="ev-location" maxLength={300} value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="ev-start">Starts</Label>
                <Input id="ev-start" type="datetime-local" value={form.startsAt} onChange={(e) => setForm({ ...form, startsAt: e.target.value })} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="ev-end">Ends (optional)</Label>
                <Input id="ev-end" type="datetime-local" value={form.endsAt} onChange={(e) => setForm({ ...form, endsAt: e.target.value })} />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="ev-price">Price (optional)</Label>
              <Input id="ev-price" maxLength={120} placeholder="e.g. ₱799 per child · Ages 5–12" value={form.priceLabel} onChange={(e) => setForm({ ...form, priceLabel: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="ev-image" className="flex items-center gap-1.5"><ImagePlus className="h-4 w-4" aria-hidden /> Poster image</Label>
              <Input id="ev-image" type="file" accept={IMAGE_TYPES.join(',')} onChange={(e) => setForm({ ...form, image: e.target.files?.[0] ?? null })} />
              <p className="text-xs text-muted-foreground">JPEG, PNG or WEBP, up to 5 MB.{editing !== 'new' && editing?.image_url ? ' Leave empty to keep the current image.' : ''}</p>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setEditing(null)}>Cancel</Button>
              <Button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save event'}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete “{deleteTarget?.title}”?</DialogTitle>
            <DialogDescription>It disappears from the website, and its sign-ups are deleted too. To just hide it, turn off “Listed on website”.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button variant="destructive" onClick={confirmDelete}>Delete event</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={signupsFor !== null} onOpenChange={(open) => !open && setSignupsFor(null)}>
        <DialogContent className="max-h-[calc(100vh-2rem)] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Sign-ups · {signupsFor?.title}</DialogTitle>
            <DialogDescription>
              {activeSignups.length} sign-up{activeSignups.length === 1 ? '' : 's'} · {activeSignups.reduce((sum, s) => sum + s.slots, 0)} slots (cancelled not counted)
            </DialogDescription>
          </DialogHeader>
          {signups.length === 0 ? (
            <p className="text-sm text-muted-foreground">No sign-ups yet.</p>
          ) : (
            <div className="divide-y rounded-md border">
              {signups.map((signup) => (
                <div key={signup.id} className="grid gap-2 p-3 text-sm sm:grid-cols-[1fr_auto]">
                  <div>
                    <p className="font-medium">{signup.name} · {signup.slots} slot{signup.slots === 1 ? '' : 's'}</p>
                    <p>
                      <a className="text-primary underline-offset-2 hover:underline" href={`tel:${signup.phone}`}>{signup.phone}</a>
                      {signup.email && <> · <a className="text-primary underline-offset-2 hover:underline" href={`mailto:${signup.email}`}>{signup.email}</a></>}
                    </p>
                    {signup.notes && <p className="text-muted-foreground">{signup.notes}</p>}
                    <p className="text-xs text-muted-foreground">
                      {new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(signup.created_at))}
                    </p>
                  </div>
                  <select
                    aria-label={`Status for ${signup.name}`}
                    className="h-10 self-start rounded-md border bg-background px-2"
                    value={signup.status}
                    onChange={(e) => setSignupStatus(signup, e.target.value as EventSignupStatus)}
                  >
                    <option value="new">New</option>
                    <option value="confirmed">Confirmed</option>
                    <option value="cancelled">Cancelled</option>
                  </select>
                </div>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
}
