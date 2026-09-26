import { useEffect } from 'react';
import SiteNav from '@/components/SiteNav';
import SiteFooter from '@/components/SiteFooter';
import InquiryForm from '@/components/InquiryForm';
import FoodPhoto from '@/components/FoodPhoto';
// Add paths such as /catering/your-photo.jpg when event photography is available.
const CATERING_PHOTOS: string[] = [];
const OCCASIONS = [
  ['Events', 'Put Japanese-inspired favourites on the menu for your next occasion.'],
  ['Parties', 'Celebrate with the people you love and food made for sharing.'],
  ['Corporate', 'Ask us about group orders for meetings and team gatherings.'],
  ['Sushi Boats', 'Make sushi part of the gathering. Tell us what you have in mind.'],
  ['Group Orders', 'Feeding a crowd? Let’s talk about your group and their cravings.'],
  ['Packages', 'Ask about available options for your event, guest count, and budget.'],
];
export default function Catering() {
  useEffect(() => { document.title = 'Catering | Oishii Nori'; }, []);
  return <div className="on-site"><SiteNav /><main id="main-content"><section className="on-catering-hero on-container"><p className="on-label">OISHII NORI / CATERING</p><h1>YOUR PEOPLE.<br /><span>OUR KITCHEN.</span></h1><p>Bring a little Oishii to your next gathering.<br />Tell us the occasion. We’ll talk food.</p><a className="on-button" href="#catering-inquiry">Plan your gathering ↗</a><span className="on-catering-kanji" lang="ja" aria-hidden="true">美味</span></section><section className="on-occasions on-container"><h2>WHAT WE CATER.</h2><div>{OCCASIONS.map(([name, copy]) => <article key={name}><h3>{name}</h3><p>{copy}</p></article>)}</div></section><section className="on-gallery"><div className="on-container"><h2>MADE TO BE SHARED.</h2>{CATERING_PHOTOS.length ? <div className="on-gallery-grid">{CATERING_PHOTOS.map((src, index) => <FoodPhoto key={src} src={src} alt={`Oishii Nori catering spread ${index + 1}`} />)}</div> : <><p>Catering photos coming soon.</p><div className="on-gallery-grid" aria-hidden="true">{['SUSHI BOATS', 'GOOD COMPANY', 'BOLD CRAVINGS'].map(text => <FoodPhoto key={text} alt={text} />)}</div></>}</div></section><section id="catering-inquiry" className="on-inquiry on-container"><div><h2>LET’S FEED<br />YOUR GATHERING.</h2><p>Share your plans, guest count, and any food preferences. We’ll use your inquiry to discuss availability and options.</p><p>Have a general question? <a href="/#contact">Contact the kitchen ↗</a></p></div><InquiryForm kind="catering" /></section></main><SiteFooter /></div>;
}
