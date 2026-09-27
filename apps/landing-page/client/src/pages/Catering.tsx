import { useReveal } from '@/lib/useReveal';
import { useEffect, useState } from 'react';
import SiteNav from '@/components/SiteNav';
import SiteFooter from '@/components/SiteFooter';
import InquiryForm from '@/components/InquiryForm';
import FoodPhoto from '@/components/FoodPhoto';
const CATERING_PHOTOS = Array.from({ length: 43 }, (_, index) => `/catering/gallery/catering-${String(index + 1).padStart(2, '0')}.jpg`);
// catering-33..43: real photos from the client's own "catering set up" shoot
// (as opposed to catering-01..32, sourced from birthday-event photos) --
// highlighted separately, up front, before the full gallery below.
const HIGHLIGHT_PHOTOS = CATERING_PHOTOS.slice(32);
const BIG_ORDER_PHOTOS = Array.from({ length: 4 }, (_, index) => `/gallery/big-orders/order-${String(index + 1).padStart(2, '0')}.jpg`);
const GROUP_PHOTOS = Array.from({ length: 10 }, (_, index) => `/gallery/group/group-${String(index + 1).padStart(2, '0')}.jpg`);
const OCCASIONS = [
  ['Events', 'Bring Japanese favorites with a Filipino twist to your next occasion.'],
  ['Parties', 'Celebrate with the people you love and food made for sharing.'],
  ['Corporate', 'Ask us about group orders for meetings and team gatherings.'],
  ['Sushi Boats', 'Make sushi part of the gathering. Tell us what you have in mind.'],
  ['Group Orders', 'Feeding a crowd? Let’s talk about your group and their cravings.'],
  ['Packages', 'Ask about available options for your event, guest count, and budget.'],
];
export default function Catering() {
  const revealRef = useReveal();
  const [visiblePhotos, setVisiblePhotos] = useState(12);
  useEffect(() => { document.title = 'Catering | Oishii Nori'; }, []);
  return <div className="on-site"><SiteNav /><main tabIndex={-1} id="main-content" ref={revealRef}><section className="on-catering-hero on-container"><p className="on-label">OISHII NORI / CATERING</p><h1>YOUR PEOPLE.<br /><span>OUR KITCHEN.</span></h1><p>Bring a little Oishii to your next gathering.<br />Tell us the occasion. We’ll talk food.</p><a className="on-button" href="#catering-inquiry">Plan your gathering <span className="on-arrow" aria-hidden="true">↗</span></a><span className="on-catering-kanji" lang="ja" aria-hidden="true">美味</span></section><section className="on-catering-highlight"><div className="on-container on-catering-highlight-head"><p className="on-label">FROM OUR CATERING TABLE</p><h2>YOUR GATHERING.<br />A LITTLE OISHII.</h2><p>Fresh sushi boats, generous spreads, and a Filipino welcome. Let’s talk about a setup that suits your gathering.</p><p className="on-photo-strip-hint" id="highlight-hint">Scroll through our catering table →</p></div><div className="on-catering-highlight-strip" tabIndex={0} role="region" aria-label="Catering highlights photo gallery" aria-describedby="highlight-hint"><div className="on-catering-highlight-track" role="list">{HIGHLIGHT_PHOTOS.map((src, index) => <div className="on-catering-highlight-card" role="listitem" key={src}><FoodPhoto src={src} alt={`Oishii Nori catering set-up ${index + 1}`} eager={index < 2} /></div>)}</div></div></section><section className="on-occasions on-container"><h2>WHAT WE CATER.</h2><div>{OCCASIONS.map(([name, copy]) => <article key={name}><h3>{name}</h3><p>{copy}</p></article>)}</div></section>
    <section className="on-big-orders"><div className="on-container"><div className="on-photo-band-head"><p className="on-eyebrow">MORE TO SHARE</p><h2>BIG ORDERS<br />WELCOME.</h2><p>Meetings, parties, and a whole lot of cravings. A look at real orders made for a crowd.</p></div><div className="on-big-orders-grid">{BIG_ORDER_PHOTOS.map((src, index) => <div className="on-big-order-card" key={src}><FoodPhoto src={src} alt={index < 4 ? `Oishii Nori large food order and catering spread ${index + 1}` : `Guests sharing a large order at Oishii Nori, photo ${index - 3}`} /></div>)}</div></div></section>
    <section className="on-real-gatherings"><div className="on-container on-photo-band-head"><p className="on-eyebrow">AT OUR TABLES</p><h2>REAL GATHERINGS.</h2><p>Shared rolls, full tables, and time together. A few moments from our Santa Cruz kitchen.</p><p className="on-photo-strip-hint" id="gatherings-hint">Scroll through ten moments at our tables →</p></div><div className="on-gatherings-strip" tabIndex={0} role="region" aria-label="Real gatherings photo gallery" aria-describedby="gatherings-hint"><div className="on-gatherings-track" role="list">{GROUP_PHOTOS.map((src, index) => <div className="on-gathering-card" role="listitem" key={src}><FoodPhoto src={src} alt={`Guests gathered around a table at Oishii Nori, photo ${index + 1}`} /></div>)}</div></div></section>
    <section className="on-gallery"><div className="on-container"><h2>MADE TO BE SHARED.</h2><p>A look at the food and gatherings we’ve helped bring together.</p><div id="catering-photos" className="on-gallery-grid on-catering-gallery-grid">{CATERING_PHOTOS.slice(0, visiblePhotos).map((src, index) => <FoodPhoto key={src} src={src} alt={`Oishii Nori catering setup ${index + 1}`} />)}</div><div className="on-gallery-controls"><p aria-live="polite" aria-atomic="true">Showing {visiblePhotos} of {CATERING_PHOTOS.length} photos</p>{visiblePhotos < CATERING_PHOTOS.length && <button className="on-button" type="button" aria-controls="catering-photos" onClick={() => setVisiblePhotos(count => Math.min(count + 12, CATERING_PHOTOS.length))}>View more photos <span aria-hidden="true">↓</span></button>}</div></div></section><section id="catering-inquiry" className="on-inquiry on-container"><div><h2>LET’S FEED<br />YOUR GATHERING.</h2><p>Share your plans, guest count, and any food preferences. We’ll use your inquiry to discuss availability and options.</p><p>Have a general question? <a href="/#contact">Contact the kitchen <span className="on-arrow" aria-hidden="true">↗</span></a></p></div><InquiryForm kind="catering" /></section></main><SiteFooter home={false} /></div>;
}
