import { useEffect, useRef, useState, type FormEvent } from 'react';
import { submitApplicant, uploadApplicantPhoto } from '@/lib/api';

const PHOTO_ERROR = 'Choose a JPG or PNG image of your resume. PDF and other file types are not accepted.';
const validPhoto = (file: File) => ['image/jpeg', 'image/png'].includes(file.type);

export default function CareersForm() {
  const [state, setState] = useState<'idle' | 'submitting' | 'success' | 'warning' | 'error'>('idle');
  const [error, setError] = useState('');
  const [photoError, setPhotoError] = useState('');
  const resultRef = useRef<HTMLDivElement>(null);
  const received = state === 'success' || state === 'warning';
  useEffect(() => {
    if (state === 'success' || state === 'warning' || state === 'error') {
      (document.activeElement as HTMLElement)?.blur();
      resultRef.current?.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    }
  }, [state]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state === 'submitting' || received) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const value = (key: string) => String(data.get(key) ?? '').trim();
    const selected = data.get('photo');
    const photo = selected instanceof File && selected.size > 0 ? selected : null;
    if (photo && !validPhoto(photo)) { setPhotoError(PHOTO_ERROR); return; }
    setState('submitting'); setError(''); setPhotoError('');
    let applicant;
    try {
      applicant = await submitApplicant({ full_name: value('full_name'), phone: value('phone'), email: value('email'), position_interest: value('position_interest'), message: value('message'), website: value('website') });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Your application could not be sent. Please try again.');
      setState('error'); return;
    }
    // The application already exists; a photo error must never invite a duplicate submission.
    if (photo) {
      try { await uploadApplicantPhoto(applicant.id, photo); }
      catch { form.reset(); setState('warning'); return; }
    }
    form.reset(); setState('success');
  }

  return <form className="on-form on-careers-form" onSubmit={submit} aria-label="Crew application" aria-busy={state === 'submitting'}>
    {!received && <fieldset disabled={state === 'submitting'}>
      <label>Full name<input name="full_name" type="text" inputMode="text" autoComplete="name" enterKeyHint="next" required maxLength={200} /></label>
      <div className="on-form-pair">
        <label>Phone<input name="phone" type="tel" inputMode="tel" autoComplete="tel" enterKeyHint="next" required maxLength={50} /></label>
        <label>Email<input name="email" type="email" inputMode="email" autoComplete="email" enterKeyHint="next" required maxLength={254} /></label>
      </div>
      <label>Position you’re interested in <span>(optional)</span><input name="position_interest" type="text" autoComplete="off" enterKeyHint="next" maxLength={200} /></label>
      <label>Short message <span>(optional)</span><textarea name="message" rows={3} maxLength={2000} /></label>
      <label>Upload a photo of your resume (JPG or PNG only — no PDF) <span>(optional)</span><input name="photo" type="file" accept="image/jpeg,image/png" aria-invalid={!!photoError} aria-describedby={photoError ? 'careers-photo-error' : undefined} onChange={event => {
        const file = event.currentTarget.files?.[0];
        const invalid = !!file && !validPhoto(file);
        event.currentTarget.setCustomValidity(invalid ? PHOTO_ERROR : '');
        setPhotoError(invalid ? PHOTO_ERROR : '');
      }} /></label>
      {photoError && <p id="careers-photo-error" className="on-status" role="alert">{photoError}</p>}
      <input type="hidden" name="website" defaultValue="" tabIndex={-1} aria-hidden="true" />
      <button className="on-button" type="submit" disabled={state === 'submitting'}>{state === 'submitting' ? 'Sending…' : 'Send application ↗'}</button>
    </fieldset>}
    <div ref={resultRef} aria-live="polite" aria-atomic="true">
      {state === 'success' && <p className="on-status">Thank you! Your application has been received by Oishii Nori.</p>}
      {state === 'warning' && <p className="on-status on-careers-warning">Your application was received, but the photo didn’t upload. You do not need to submit your application again.</p>}
      {state === 'error' && <p className="on-status" role="alert">{error}</p>}
    </div>
  </form>;
}
