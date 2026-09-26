import { useReveal } from '@/lib/useReveal';
import { Router } from 'wouter';
import { useEffect, useState } from 'react';
import SiteNav from '@/components/SiteNav';
import SiteFooter from '@/components/SiteFooter';
import InquiryForm from '@/components/InquiryForm';
import FoodPhoto from '@/components/FoodPhoto';
import { MapView } from '@/components/Map';
import { type ApiProduct, type BusinessHours, fetchBusinessHours, fetchMenu } from '@/lib/api';
import { formatTime12h } from '@/lib/utils';

// Generated Torikatsu and drinks are illustrative placeholders; replace with real photos when available.
const CATEGORY_PHOTOS: Record<string, string | undefined> = { Sushi: '/generated/torikatsu.jpg', Ramen: '/products/chasu-ramen.jpg', Katsu: '/products/cheesy-katsu-w-rice.jpg', Drinks: '/generated/drinks.jpg' };
const BEST_SELLERS = [
  { name: 'Oishii Nori Ramen', photo: '/products/chasu-ramen.jpg', description: 'Rich broth, tender chashu, soft egg, and fresh toppings.' },
  { name: 'Torikatsu Maki', photo: '/generated/torikatsu.jpg', description: 'Cream cheese, breaded chicken, wrapped in cucumber with special sauce topped with crispy potato strings.' },
  { name: 'Sushi Boat', photo: '/hero/sushi-boats.jpg', description: 'A variety of our best rolls, perfect for sharing.' },
];
// Reuse the real catering spread until approved restaurant interior photography is available.
const INTERIOR_PHOTO = '/hero/sushi-boats.jpg';
const shopLocation = { lat: 14.278476, lng: 121.4158777 };
export interface HomeInitialData { products: ApiProduct[]; hours: BusinessHours | null }
export default function Home({ initialData }: { initialData?: HomeInitialData } = {}) {
  const revealRef = useReveal();
  const [products, setProducts] = useState(initialData?.products ?? []);
  const [hours, setHours] = useState(initialData?.hours ?? null);
  useEffect(() => {
    document.title = 'Oishii Nori | Boldly Oishii.';
    let active = true;
    fetchMenu().then(data => { if (active) setProducts(data); }).catch(() => {});
    fetchBusinessHours().then(data => { if (active) setHours(data); }).catch(() => {});
    return () => { active = false; };
  }, []);
  const hoursLabel = hours ? `${formatTime12h(hours.open_time.slice(0, 5))} – ${formatTime12h(hours.close_time.slice(0, 5))}` : '11:00 AM – 10:00 PM';
  const price = (name: string) => {
    const match = products.find(p => p.name.toLowerCase().includes(name.toLowerCase()));
    const sizes = match?.sizes ?? [];
    const featured = name === 'Sushi Boat' ? sizes.find(size => /medium/i.test(size.size_label) || size.total_pieces === 64) : undefined;
    const prices = (featured ? [featured] : sizes).map(size => size.price).filter(value => Number.isFinite(value) && value >= 0);
    return prices.length ? `₱${Math.min(...prices).toLocaleString('en-PH', { maximumFractionDigits: 2 })}` : null;
  };
  return <Router ssrPath="/"><div className="on-site"><SiteNav home /><main tabIndex={-1} id="main-content" ref={revealRef}>
    <section id="home" className="on-hero"><div className="on-hero-copy"><p className="on-eyebrow">EXCLUSIVE ROLLS</p><h1>OISHII<br /><span>NORI</span></h1><p className="on-tagline" lang="ja">おいしいのり</p><p>Rolls with a little more feeling.<br />Fresh ingredients, bright ideas,<br />and a table waiting for you.</p><div className="on-actions"><a className="on-button" href="/menu">Order now <span className="on-arrow" aria-hidden="true">→</span></a><a className="on-button on-outline" href="/menu?reserve=1">Reserve <span className="on-arrow" aria-hidden="true">→</span></a></div></div><div className="on-hero-art"><div className="on-brush" aria-hidden="true" /><FoodPhoto src="/hero/sushi-boats.jpg" alt="Oishii Nori wooden sushi boats filled with maki and carved vegetable flowers" eager /><span className="on-japanese" lang="ja">新鮮な素材・最高の味</span></div></section>
    <section className="on-intro on-container"><div><p className="on-intro-japanese" lang="ja">おいしいのり</p><h2>MADE FOR<br />GOOD CRAVINGS.</h2></div><p>At Oishii Nori, we serve more than just sushi.<br />We serve good vibes, fresh ingredients,<br />and bold flavors — all in a space made<br />for great food and even better company.<br /><a className="on-story-link" href="/about">Read our story <span className="on-arrow" aria-hidden="true">↗</span></a></p><span className="on-seal" lang="ja">美味</span></section>
    <section className="on-sellers"><div className="on-container on-sellers-layout"><div className="on-section-title"><p className="on-eyebrow">ON THE TABLE</p><h2>BEST<br />SELLERS</h2><a href="/our-menu">See the full menu <span className="on-arrow" aria-hidden="true">↗</span></a></div><p className="on-sellers-tagline">The crowd favorites.<br />Always a good idea.</p><div className="on-seller-grid">{BEST_SELLERS.map(item => <a href="/menu" className="on-seller" key={item.name}><div className="on-seller-image"><FoodPhoto src={item.photo} alt={item.name === 'Oishii Nori Ramen' ? 'Chashu ramen with golden broth, pork, egg and scallions' : item.name === 'Torikatsu Maki' ? 'Illustrative Torikatsu Maki with crispy potato strings (AI-generated)' : 'Real Oishii Nori sushi boats with assorted maki'} /><span className="on-badge">BEST<br />SELLER</span></div><div className="on-seller-copy"><h3>{item.name}</h3><p>{item.description}</p>{price(item.name) ? <strong className="on-price">{price(item.name)}</strong> : <span className="on-price-fallback">View menu for prices →</span>}</div></a>)}</div></div></section>
    <section className="on-categories"><div className="on-container"><div className="on-category-heading"><p className="on-eyebrow">MORE THAN SUSHI.</p><h2>SUSHI. RAMEN. KATSU.<br />YOUR KIND OF <span>OISHII.</span></h2></div><div className="on-category-grid">{Object.entries(CATEGORY_PHOTOS).map(([name, src]) => <a href={`/our-menu?cat=${encodeURIComponent(name)}`} key={name}><FoodPhoto src={src} alt={name === 'Sushi' ? 'Illustrative Torikatsu Maki (AI-generated)' : name === 'Drinks' ? 'Illustrative Oishii Nori milk tea cups (AI-generated)' : name === 'Ramen' ? 'Chashu ramen with golden broth' : 'Cheesy katsu served with rice'} /><h3>{name} <span>→</span></h3></a>)}</div></div></section>
    <section className="on-experience"><FoodPhoto src={INTERIOR_PHOTO} alt="A real Oishii Nori sushi boat spread ready to share" /><div className="on-experience-heading"><p className="on-eyebrow">THE OISHII NORI EXPERIENCE</p><h2>YOUR TABLE<br />IS WAITING.</h2></div><div className="on-experience-copy"><p>From casual rolls to late-night cravings,<br />Oishii Nori is made for good food,<br />good company, and a table worth staying at.</p><a href="#find-us">View branches <span className="on-arrow" aria-hidden="true">→</span></a></div><span className="on-experience-japanese" lang="ja">一緒に食べよう</span></section>
    <section id="order" className="on-order on-container"><div><span lang="ja">お持ち帰り</span><h2>ORDER ONLINE.</h2><p>Your Oishii favourites, just a few taps away.</p><a className="on-button on-light" href="/menu">Order now <span className="on-arrow" aria-hidden="true">↗</span></a></div><div><span lang="ja">ご予約</span><h2>RESERVE A TABLE.</h2><p>Make a little room for your next get-together.</p><a className="on-button on-outline" href="/menu?reserve=1">Reserve <span className="on-arrow" aria-hidden="true">↗</span></a></div></section>
    <section id="faq" className="on-faq on-container"><h2>GOOD TO KNOW.</h2><div>{[['Do you take reservations?', 'Use the Reserve button to request a table online.'], ['What are your hours?', hoursLabel], ['Where are you located?', 'Pedro Guevara Ave., Santa Cruz, Laguna 4009, Philippines.'], ["What’s on the menu?", 'Sushi, ramen, katsu, snacks, and cafe drinks. Explore our full online menu.']].map(([question, answer]) => <details key={question}><summary>{question}</summary><p>{answer}</p></details>)}</div></section>
    <section id="catering-cta" className="on-catering-band"><div className="on-container"><span lang="ja">みんなで</span><h2>BIG GATHERINGS.<br />BOLD CRAVINGS.</h2><p>Events, parties, corporate get-togethers. Talk to us about sushi boats and group orders for your next occasion.</p><a className="on-button" href="/catering">Explore catering <span className="on-arrow" aria-hidden="true">↗</span></a></div></section>
    <section id="find-us" className="on-find on-container"><div className="on-map-panel"><p className="on-eyebrow">FIND US</p><h2>OISHII NORI<br /><span>SANTA CRUZ</span></h2><p className="on-address"><span aria-hidden="true">●</span> Pedro Guevara Ave.<br />Santa Cruz, Laguna 4009, Philippines</p><p className="on-hours">Kitchen hours · {hoursLabel}</p><MapView className="on-map" {...shopLocation} zoom={17} /><a className="on-map-link" href="https://maps.app.goo.gl/9oACBZo6tUdzyabK7" target="_blank" rel="noreferrer">Open in Maps <span className="on-arrow" aria-hidden="true">↗</span></a></div><div id="contact"><h2>CONTACT US.</h2><p>A question, a craving, or something to share? Drop us a line.</p><InquiryForm kind="contact" /></div></section>
  </main><SiteFooter hours={hoursLabel} /></div></Router>;
}
