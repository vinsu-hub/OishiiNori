import { useReveal } from '@/lib/useReveal';
import { useEffect, useState } from 'react';
import SiteNav from '@/components/SiteNav';
import SiteFooter from '@/components/SiteFooter';
import InquiryForm from '@/components/InquiryForm';
import FoodPhoto from '@/components/FoodPhoto';
const CATERING_PHOTOS = Array.from({ length: 43 }, (_, index) => `/catering/gallery/catering-${String(index + 1).padStart(2, '0')}.jpg`);
const OCCASIONS = [
  ['Events', 'Put Japanese-inspired favourites on the menu for your next occasion.'],
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
  return <div className="on-site"><SiteNav /><main tabIndex={-1} id="main-content" ref={revealRef}><section className="on-catering-hero on-container"><p className="on-label">OISHII NORI / CATERING</p><h1>YOUR PEOPLE.<br /><span>OUR KITCHEN.</span></h1><p>Bring a little Oishii to your next gathering.<br />Tell us the occasion. We’ll talk food.</p><a className="on-button" href="#catering-inquiry">Plan your gathering <span className="on-arrow" aria-hidden="true">↗</span></a><span className="on-catering-kanji" lang="ja" aria-hidden="true">美味</span></section><section className="on-occasions on-container"><h2>WHAT WE CATER.</h2><div>{OCCASIONS.map(([name, copy]) => <article key={name}><h3>{name}</h3><p>{copy}</p></article>)}</div></section><section className="on-gallery"><div className="on-container"><h2>MADE TO BE SHARED.</h2><p>A look at the food and gatherings we’ve helped bring together.</p><div id="catering-photos" className="on-gallery-grid on-catering-gallery-grid">{CATERING_PHOTOS.slice(0, visiblePhotos).map((src, index) => <FoodPhoto key={src} src={src} alt={`Oishii Nori catering setup ${index + 1}`} />)}</div><div className="on-gallery-controls"><p aria-live="polite" aria-atomic="true">Showing {visiblePhotos} of {CATERING_PHOTOS.length} photos</p>{visiblePhotos < CATERING_PHOTOS.length && <button className="on-button" type="button" aria-controls="catering-photos" onClick={() => setVisiblePhotos(count => Math.min(count + 12, CATERING_PHOTOS.length))}>View more photos <span aria-hidden="true">↓</span></button>}</div></div></section><section id="catering-inquiry" className="on-inquiry on-container"><div><h2>LET’S FEED<br />YOUR GATHERING.</h2><p>Share your plans, guest count, and any food preferences. We’ll use your inquiry to discuss availability and options.</p><p>Have a general question? <a href="/#contact">Contact the kitchen <span className="on-arrow" aria-hidden="true">↗</span></a></p></div><InquiryForm kind="catering" /></section></main><SiteFooter home={false} /></div>;
}
