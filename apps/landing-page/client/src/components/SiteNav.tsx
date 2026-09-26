import { useEffect, useState } from 'react';
import { useLocation } from 'wouter';
import { Menu, X } from 'lucide-react';
export default function SiteNav({ home = false }: { home?: boolean }) {
  const [location] = useLocation();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [open]);
  const anchor = (id: string) => `${home ? '' : '/'}#${id}`;
  const links = [['HOME', '/'], ['MENU', '/our-menu'], ['ABOUT', '/about'], ['REVIEWS', '/review'], ['BRANCHES', anchor('find-us')], ['CATERING', '/catering']];
  return <header className="on-header"><a className="on-skip" href="#main-content">Skip to content</a><div className="on-nav">
    <button className="on-toggle" aria-label={open ? 'Close navigation' : 'Open navigation'} aria-expanded={open} aria-controls="site-navigation" onClick={() => setOpen(!open)}>{open ? <X /> : <Menu />}</button>
    <nav id="site-navigation" className={`on-links ${open ? 'is-open' : ''}`} aria-label="Main navigation">{links.map(([label, href]) => <a key={label} className={location === href ? 'is-active' : undefined} aria-current={location === href ? 'page' : undefined} href={href} onClick={event => { setOpen(false); if (home && label === 'HOME') { event.preventDefault(); window.scrollTo({ top: 0, behavior: 'smooth' }); } }}>{label}</a>)}</nav>
    <a className="on-logo" href="/" aria-label="Oishii Nori home" onClick={event => { if (home) { event.preventDefault(); window.scrollTo({ top: 0, behavior: 'smooth' }); } }}><img src="/logo-badge.png" alt="Oishii Nori" width="104" height="57" /></a>
    <div className="on-nav-actions"><a className="on-button" href="/menu">Order now →</a><a className="on-button on-outline" href="/menu?reserve=1">Reserve →</a></div>
  </div></header>;
}
