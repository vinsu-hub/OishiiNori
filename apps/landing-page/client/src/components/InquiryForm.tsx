import { useState, useEffect, useRef, type FormEvent } from 'react';
import { submitInquiry } from '@/lib/api';
export default function InquiryForm({ kind }: { kind: 'contact' | 'catering' }) {
  const [state, setState] = useState<'idle' | 'submitting' | 'success' | 'error'>('idle');
  const [error, setError] = useState('');
  const resultRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (state === 'success' || state === 'error') { (document.activeElement as HTMLElement)?.blur(); resultRef.current?.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); } }, [state]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state === 'submitting') return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const value = (key: string) => String(data.get(key) ?? '').trim();
    setState('submitting'); setError('');
    try {
      const result = await submitInquiry({ kind, name: value('name'), email: value('email'), message: value('message'), website: value('website'), ...(kind === 'catering' ? { ...(value('phone') ? { phone: value('phone') } : {}), ...(value('event_date') ? { event_date: value('event_date') } : {}), ...(value('guest_count') ? { guest_count: Number(value('guest_count')) } : {}) } : {}) });
      if (!result.ok) throw new Error('Your inquiry could not be sent. Please try again.');
      form.reset(); setState('success');
    } catch (err) { setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.'); setState('error'); }
  }
  return <form className="on-form" onSubmit={submit} aria-busy={state === 'submitting'}><label>Name<input name="name" enterKeyHint="next" autoComplete="name" required maxLength={200} /></label><label>Email<input name="email" type="email" inputMode="email" enterKeyHint="next" autoComplete="email" required maxLength={254} /></label>{kind === 'catering' && <><label>Phone <span>(optional)</span><input name="phone" type="tel" inputMode="tel" enterKeyHint="next" autoComplete="tel" /></label><div className="on-form-pair"><label>Event date <span>(optional)</span><input name="event_date" type="date" enterKeyHint="next" autoComplete="off" /></label><label>Guest count <span>(optional)</span><input name="guest_count" type="number" autoComplete="off" inputMode="numeric" enterKeyHint="next" min="1" step="1" /></label></div></>}<label>Message<textarea name="message" rows={4} required maxLength={10000} /></label><input type="hidden" tabIndex={-1} aria-hidden="true" name="website" defaultValue="" /><button className="on-button" type="submit" disabled={state === 'submitting'}>{state === 'submitting' ? 'Sending…' : 'Send inquiry ↗'}</button><div ref={resultRef} aria-live="polite">{state === 'success' && <p className="on-status">Thank you! Your inquiry has been sent to the kitchen.</p>}{state === 'error' && <p className="on-status" role="alert">{error}</p>}</div></form>;
}
