import { useReveal } from '@/lib/useReveal';
import { useEffect, useState } from 'react';
import SiteNav from '@/components/SiteNav';
import SiteFooter from '@/components/SiteFooter';
import FoodPhoto from '@/components/FoodPhoto';
import { fetchBusinessHours, type BusinessHours } from '@/lib/api';
import { formatTime12h } from '@/lib/utils';

export default function About() {
  const revealRef = useReveal();
  const [hours, setHours] = useState<BusinessHours | null>(null);
  useEffect(() => {
    document.title = 'About | Oishii Nori';
    let active = true;
    fetchBusinessHours().then(data => { if (active) setHours(data); }).catch(() => {});
    return () => { active = false; };
  }, []);
  const hoursLabel = hours ? `${formatTime12h(hours.open_time.slice(0, 5))} – ${formatTime12h(hours.close_time.slice(0, 5))}` : '11:00 AM – 10:00 PM';
  return <div className="on-site"><SiteNav /><main tabIndex={-1} id="main-content" ref={revealRef}>
    <section className="on-catering-hero on-container on-about-hero"><p className="on-label">OISHII NORI / OUR STORY</p><h1>MADE FOR<br /><span>GOOD CRAVINGS.</span></h1><p lang="ja" className="on-intro-japanese">おいしいのり</p><p>At Oishii Nori, we serve more than just sushi. We serve good vibes, fresh ingredients, and bold flavors — all in a space made for great food and even better company.</p><div className="on-actions"><a className="on-button" href="/menu">Order now <span className="on-arrow" aria-hidden="true">↗</span></a><a className="on-button on-outline" href="/menu?reserve=1">Reserve <span className="on-arrow" aria-hidden="true">↗</span></a></div></section>
    <section className="on-serve-strip"><div className="on-container"><p className="on-eyebrow">WHAT WE SERVE</p><div>{['Sushi', 'Ramen', 'Katsu', 'Sushi Boats'].map(name => <span key={name}>{name}</span>)}</div><a href="/our-menu">Explore our menu <span className="on-arrow" aria-hidden="true">↗</span></a></div></section>
    <section className="on-gallery"><div className="on-container"><h2>GOOD FOOD.<br />EVEN BETTER COMPANY.</h2><div className="on-gallery-grid"><FoodPhoto src="/hero/sushi-boats.jpg" alt="Real Oishii Nori wooden sushi boats filled with assorted maki" /></div></div></section>
    <section className="on-about-find on-container"><div><p className="on-eyebrow">FIND US</p><h2>YOUR TABLE<br />IS WAITING.</h2><p>Pedro Guevara Ave., Santa Cruz, Laguna 4009</p><p className="on-hours">Kitchen hours · {hoursLabel}</p><a className="on-map-link" href="https://maps.app.goo.gl/9oACBZo6tUdzyabK7" target="_blank" rel="noreferrer">Open in Maps <span className="on-arrow" aria-hidden="true">↗</span></a></div><div className="on-about-gather"><p lang="ja">みんなで</p><h2>BRING YOUR<br />GOOD COMPANY.</h2><p>Explore catering for your next gathering.</p><a className="on-button on-light" href="/catering">Catering <span className="on-arrow" aria-hidden="true">↗</span></a></div></section>
  </main><SiteFooter home={false} hours={hoursLabel} /></div>;
}
