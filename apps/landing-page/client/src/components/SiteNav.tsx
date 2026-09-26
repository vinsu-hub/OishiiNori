import { useEffect, useState } from 'react';
import { Menu, X } from 'lucide-react';
export default function SiteNav({ home = false }: { home?: boolean }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [open]);
  const anchor = (id: string) => `${home ? '' : '/'}#${id}`;
  const links = [['HOME', anchor('home')], ['MENU', anchor('menu')], ['ABOUT', anchor('about')], ['REVIEWS', '/review'], ['BRANCHES', anchor('find-us')], ['CATERING', '/catering']];
  return <header className="on-header"><a className="on-skip" href="#main-content">Skip to content</a><div className="on-nav">
    <button className="on-toggle" aria-label={open ? 'Close navigation' : 'Open navigation'} aria-expanded={open} aria-controls="site-navigation" onClick={() => setOpen(!open)}>{open ? <X /> : <Menu />}</button>
    <nav id="site-navigation" className={`on-links ${open ? 'is-open' : ''}`} aria-label="Main navigation">{links.map(([label, href]) => <a key={label} className={(home && label === 'HOME') || (!home && label === 'CATERING') ? 'is-active' : undefined} aria-current={(home && label === 'HOME') || (!home && label === 'CATERING') ? 'page' : undefined} href={href} onClick={() => setOpen(false)}>{label}</a>)}</nav>
    <a className="on-logo" href={anchor('home')} aria-label="Oishii Nori home"><img src="/logo.jpg" alt="Oishii Nori" width="100" height="70" /></a>
    <div className="on-nav-actions"><a className="on-button" href="/menu">Order now →</a><a className="on-button on-outline" href="/menu/?reserve=1">Reserve →</a></div>
  </div></header>;
}
