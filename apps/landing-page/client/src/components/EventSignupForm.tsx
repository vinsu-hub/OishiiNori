import { useState, type FormEvent } from 'react';
import { submitEventSignup } from '@/lib/api';

/** Sign-up form for one event. Payment is arranged with the shop afterwards. */
export default function EventSignupForm({ eventId, title }: { eventId: string; title: string }) {
  const [state, setState] = useState<'idle' | 'submitting' | 'success' | 'error'>('idle');
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state === 'submitting') return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const value = (key: string) => String(data.get(key) ?? '').trim();
    setState('submitting'); setError('');
    try {
      await submitEventSignup(eventId, {
        name: value('name'), phone: value('phone'), slots: Number(value('slots')) || 1,
        ...(value('email') ? { email: value('email') } : {}),
        ...(value('notes') ? { notes: value('notes') } : {}),
        ...(value('website') ? { website: value('website') } : {}),
      });
      form.reset(); setState('success');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
      setState('error');
    }
  }
  const id = (name: string) => `${name}-${eventId}`;
  return <form className="on-form on-event-form" onSubmit={submit} aria-busy={state === 'submitting'} aria-label={`Sign up for ${title}`}>
    <div className="on-form-pair">
      <label htmlFor={id('name')}>Name<input id={id('name')} name="name" autoComplete="name" required maxLength={120} /></label>
      <label htmlFor={id('phone')}>Mobile number<input id={id('phone')} name="phone" type="tel" inputMode="tel" autoComplete="tel" required maxLength={40} placeholder="09XX XXX XXXX" /></label>
    </div>
    <div className="on-form-pair">
      <label htmlFor={id('email')}>Email <span>(optional)</span><input id={id('email')} name="email" type="email" inputMode="email" autoComplete="email" maxLength={160} /></label>
      <label htmlFor={id('slots')}>Slots<input id={id('slots')} name="slots" type="number" inputMode="numeric" min="1" max="20" step="1" defaultValue="1" required /></label>
    </div>
    <label htmlFor={id('notes')}>Notes <span>(optional, e.g. kids’ names and ages)</span><textarea id={id('notes')} name="notes" rows={3} maxLength={600} /></label>
    <input type="text" name="website" tabIndex={-1} aria-hidden="true" autoComplete="off" defaultValue="" className="on-honeypot" />
    <button className="on-button" type="submit" disabled={state === 'submitting'}>{state === 'submitting' ? 'Sending…' : 'Sign up ↗'}</button>
    <div aria-live="polite">
      {state === 'success' && <p className="on-status">You’re signed up! We’ll text or call you to confirm your slot and payment.</p>}
      {state === 'error' && <p className="on-status" role="alert">{error}</p>}
    </div>
  </form>;
}
