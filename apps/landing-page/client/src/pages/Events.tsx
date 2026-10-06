import { useReveal } from '@/lib/useReveal';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Pause, Play, X } from 'lucide-react';
import SiteNav from '@/components/SiteNav';
import SiteFooter from '@/components/SiteFooter';
import FoodPhoto from '@/components/FoodPhoto';

const DIR = '/events/sushi-kids';
// [file number, thumb width, thumb height, alt]
const PHOTOS: [string, number, number, string][] = [
  ['01', 640, 480, 'The Oishii Nori crew and the young sushi makers posing together after class'],
  ['02', 640, 604, 'Kids in red Oishii Nori headbands lined up at the demo counter'],
  ['03', 640, 583, 'An Oishii Nori chef demonstrating how to roll maki for the class'],
  ['04', 591, 640, 'Excited kids raising their hands during the sushi-making class'],
  ['05', 480, 640, 'A young sushi maker waving while spreading rice on her nori'],
  ['06', 480, 640, 'A girl carefully laying fillings on her nori sheet'],
  ['07', 480, 640, 'Pressing sushi rice onto nori on a bamboo mat'],
  ['08', 480, 640, 'Close-up of small hands rolling a maki with a bamboo mat'],
  ['09', 480, 640, 'A student rolling a crab-topped maki'],
  ['10', 544, 640, 'A boy slicing his finished maki roll'],
  ['11', 531, 640, 'Adding sauce to freshly sliced sushi'],
  ['12', 480, 640, 'A proud young chef showing off her box of homemade sushi'],
  ['13', 640, 623, 'Kids in aprons striking a pose after making their sushi'],
  ['14', 602, 640, 'An Oishii Nori sushi boat decorated with flowers'],
  ['15', 480, 640, 'A tiered Oishii Nori sushi display framed with flowers'],
  ['16', 640, 429, 'Class group photo with the Oishii Nori crew at the counter'],
];
const STEPS = [
  ['Meet the crew', 'Our chefs showed how a maki roll comes together, one step at a time.'],
  ['Rice, nori, roll', 'Every kid got a bamboo mat, gloves, and their own red Oishii Nori headband.'],
  ['Slice & share', 'They sliced, sauced, and proudly packed their very own sushi to take home.'],
];

function Lightbox({ index, onClose, onMove }: { index: number; onClose: () => void; onMove: (delta: number) => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const touchX = useRef<number | null>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'ArrowRight') onMove(1);
      if (event.key === 'ArrowLeft') onMove(-1);
    };
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('keydown', key); document.body.style.overflow = overflow; previous?.focus(); };
  }, [onClose, onMove]);
  const [file, , , alt] = PHOTOS[index];
  return <div className="on-lightbox" role="dialog" aria-modal="true" aria-label="Photo viewer" onClick={event => { if (event.target === event.currentTarget) onClose(); }}
    onTouchStart={event => { touchX.current = event.touches[0].clientX; }}
    onTouchEnd={event => { if (touchX.current === null) return; const dx = event.changedTouches[0].clientX - touchX.current; if (Math.abs(dx) > 40) onMove(dx < 0 ? 1 : -1); touchX.current = null; }}>
    <button ref={closeRef} className="on-lightbox-close" type="button" aria-label="Close photo" onClick={onClose}><X /></button>
    <button type="button" aria-label="Previous photo" onClick={() => onMove(-1)}><ChevronLeft /></button>
    <img src={`${DIR}/${file}.jpg`} alt={alt} />
    <button type="button" aria-label="Next photo" onClick={() => onMove(1)}><ChevronRight /></button>
    <p aria-live="polite">{index + 1} / {PHOTOS.length} · {alt}</p>
  </div>;
}

export default function Events() {
  const revealRef = useReveal();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(true);
  const [open, setOpen] = useState<number | null>(null);
  useEffect(() => { document.title = 'Events | Oishii Nori — Your Sushi Story'; }, []);
  useEffect(() => {
    // Respect reduced motion: start paused, the visitor can press play.
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { videoRef.current?.pause(); setPlaying(false); }
  }, []);
  const toggleVideo = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) { video.play().catch(() => {}); setPlaying(true); } else { video.pause(); setPlaying(false); }
  };
  const close = useCallback(() => setOpen(null), []);
  const move = useCallback((delta: number) => setOpen(current => current === null ? null : (current + delta + PHOTOS.length) % PHOTOS.length), []);

  return <div className="on-site"><SiteNav /><main tabIndex={-1} id="main-content" ref={revealRef}>
    <section className="on-events-hero on-container">
      <div>
        <p className="on-label">OISHII NORI / EVENTS</p>
        <h1>YOUR <span>SUSHI</span><br />STORY.</h1>
        <p className="on-events-sub">Little hands, big rolls — our Sushi Making Class for Kids.</p>
        <p className="on-events-meta">SANTA CRUZ, LAGUNA · OCTOBER 2026</p>
        <div className="on-actions"><a className="on-button" href="#gallery">See the photos <span className="on-arrow" aria-hidden="true">↓</span></a><a className="on-button on-outline" href="/catering#catering-inquiry">Book a class <span className="on-arrow" aria-hidden="true">↗</span></a></div>
      </div>
      <figure className="on-events-video">
        <video ref={videoRef} src={`${DIR}/loop.mp4`} poster={`${DIR}/loop-poster.jpg`} autoPlay muted loop playsInline preload="metadata" aria-label="Video of an Oishii Nori sushi display decorated with flowers" />
        <figcaption>THE OISHII NORI SPREAD</figcaption>
        <button type="button" onClick={toggleVideo} aria-label={playing ? 'Pause video' : 'Play video'}>{playing ? <Pause size={18} /> : <Play size={18} />}</button>
      </figure>
    </section>

    <section className="on-events-story"><div className="on-container">
      <FoodPhoto src={`${DIR}/03.jpg`} alt={PHOTOS[2][3]} />
      <div>
        <p className="on-eyebrow" style={{ color: 'var(--on-gold)' }}>SUSHI MAKING FOR KIDS</p>
        <h2>EVERY ROLL<br />TELLS A <span>STORY.</span></h2>
        <p>We opened our kitchen to a class of young chefs for a morning of rice, nori, and a lot of giggles. Every kid rolled, sliced, and took home sushi they made themselves — their very first sushi story.</p>
        <ul>{STEPS.map(([title, copy], index) => <li key={title}><b>{String(index + 1).padStart(2, '0')}</b><span><strong>{title}.</strong> {copy}</span></li>)}</ul>
      </div>
    </div></section>

    <section id="gallery" className="on-container">
      <div className="on-events-gallery-head"><div><p className="on-eyebrow">FROM THE CLASS</p><h2>LITTLE CHEFS.<br /><span>BIG ROLLS.</span></h2></div><p>Tap any photo to see it larger.</p></div>
      <div className="on-events-grid">{PHOTOS.map(([file, w, h, alt], index) => <button type="button" key={file} onClick={() => setOpen(index)} aria-label={`Open photo: ${alt}`}><img src={`${DIR}/${file}-sm.jpg`} alt={alt} width={w} height={h} loading={index < 3 ? 'eager' : 'lazy'} decoding="async" /></button>)}</div>
    </section>

    <section className="on-events-cta"><div className="on-container">
      <span lang="ja" aria-hidden="true">みんなで</span>
      <h2>START <span>YOUR</span> SUSHI STORY.</h2>
      <p>Want a sushi-making class for your school, birthday party, or team? Tell us your date and group size and we’ll plan it with you.</p>
      <div className="on-actions"><a className="on-button" href="/catering#catering-inquiry">Ask about a class <span className="on-arrow" aria-hidden="true">↗</span></a><a className="on-button on-outline" href="/menu?reserve=1">Reserve a table <span className="on-arrow" aria-hidden="true">→</span></a></div>
    </div></section>
  </main><SiteFooter home={false} />{open !== null && <Lightbox index={open} onClose={close} onMove={move} />}</div>;
}
