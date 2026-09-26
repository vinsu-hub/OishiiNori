import { useEffect, useState, useRef } from 'react';
import { useLocation } from 'wouter';
import { Menu, X } from 'lucide-react';
export default function SiteNav({ home = false }: { home?: boolean }) {
  const [location] = useLocation();
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const update = () => setScrolled(window.scrollY > 40);
    update();
    window.addEventListener('scroll', update, { passive: true });
    return () => window.removeEventListener('scroll', update);
  }, []);
  const [open, setOpen] = useState(false);
  const header = useRef<HTMLElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const [formFocused, setFormFocused] = useState(false);
  useEffect(() => {
    const update = () => setFormFocused(!!document.activeElement?.closest('form') && document.activeElement?.matches('input, textarea, select') === true);
    document.addEventListener('focusin', update); document.addEventListener('focusout', update);
    return () => { document.removeEventListener('focusin', update); document.removeEventListener('focusout', update); };
  }, []);
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const outside = (event: PointerEvent) => { if (!header.current?.contains(event.target as Node)) setOpen(false); };
    const resize = () => { if (window.innerWidth > 1100) setOpen(false); };
    document.addEventListener('pointerdown', outside); window.addEventListener('resize', resize);
    return () => { document.body.style.overflow = previous; document.removeEventListener('pointerdown', outside); window.removeEventListener('resize', resize); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setOpen(false); toggle.current?.focus(); }
      if (event.key === 'Tab') {
        const targets = Array.from(header.current?.querySelectorAll<HTMLElement>('.on-toggle, .on-links a') ?? []);
        const first = targets[0], last = targets[targets.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [open]);
  const anchor = (id: string) => `${home ? '' : '/'}#${id}`;
  const links = [['HOME', '/'], ['MENU', '/our-menu'], ['ABOUT', '/about'], ['REVIEWS', '/review'], ['BRANCHES', anchor('find-us')], ['CATERING', '/catering']];
  return <><header ref={header} className={`on-header ${scrolled ? 'on-scrolled' : ''}`}><a className="on-skip" href="#main-content">Skip to content</a><div className="on-nav">
    <button ref={toggle} className="on-toggle" aria-label={open ? 'Close navigation' : 'Open navigation'} aria-expanded={open} aria-controls="site-navigation" onClick={() => setOpen(!open)}>{open ? <X /> : <Menu />}</button>
    <nav id="site-navigation" className={`on-links ${open ? 'is-open' : ''}`} aria-label="Main navigation">{links.map(([label, href]) => <a key={label} className={location === href ? 'is-active' : undefined} aria-current={location === href ? 'page' : undefined} href={href} onClick={event => { setOpen(false); if (home && label === 'HOME') { event.preventDefault(); window.scrollTo({ top: 0, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); } }}>{label}</a>)}</nav>
    <a className="on-logo" href="/" aria-label="Oishii Nori home" onClick={event => { if (home) { event.preventDefault(); window.scrollTo({ top: 0, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); } }}><img src="/logo-badge.png" alt="Oishii Nori" width="104" height="57" /></a>
    <div className="on-nav-actions"><a className="on-button" href="/menu">Order now <span className="on-arrow" aria-hidden="true">→</span></a><a className="on-button on-outline" href="/menu?reserve=1">Reserve <span className="on-arrow" aria-hidden="true">→</span></a></div>
  </div></header>{['/', '/about', '/our-menu', '/catering'].includes(location.split('?')[0]) && <nav className="on-mobile-actions" aria-label="Quick ordering" hidden={open || formFocused}><a className="on-button" href="/menu">Order now →</a><a className="on-button on-outline" href="/menu?reserve=1">Reserve →</a></nav>}</>;
}
