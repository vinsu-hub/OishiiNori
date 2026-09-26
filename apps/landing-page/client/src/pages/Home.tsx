import { useEffect, useState } from 'react';
import SiteNav from '@/components/SiteNav';
import SiteFooter from '@/components/SiteFooter';
import InquiryForm from '@/components/InquiryForm';
import FoodPhoto from '@/components/FoodPhoto';
import { MapView } from '@/components/Map';
import { type ApiProduct, type BusinessHours, fetchBusinessHours, fetchMenu } from '@/lib/api';
import { formatTime12h } from '@/lib/utils';

// Swap category photography here. Undefined entries intentionally use typographic tiles.
const CATEGORY_PHOTOS: Record<string, string | undefined> = { Sushi: '/products/oishii-baked-sushi.jpg', Ramen: '/products/tonkatsu-ramen.jpg', Katsu: undefined, Drinks: undefined };
const BEST_SELLERS = [
  { name: 'Oishii Nori Ramen', photo: '/products/tonkatsu-ramen.jpg', description: 'A warm bowl for your next ramen craving.' },
  { name: 'Torikatsu Maki', photo: '/products/torikatsu-ramen.jpg', description: 'Your next roll of choice. Made for a good appetite.' },
  { name: 'Sushi Boat', photo: '/products/oishii-baked-sushi.jpg', description: 'Bring your people. Make sushi the centre of the table.' },
];
// Set to '/interior.jpg' when interior photography is available.
const INTERIOR_PHOTO: string | undefined = undefined;
const shopLocation = { lat: 14.278476, lng: 121.4158777 };
export interface HomeInitialData { products: ApiProduct[]; hours: BusinessHours | null }
export default function Home({ initialData }: { initialData?: HomeInitialData } = {}) {
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
    const prices = match?.sizes.map(size => size.price).filter(value => Number.isFinite(value) && value >= 0) ?? [];
    return prices.length ? `₱${Math.min(...prices).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : null;
  };
  return <div className="on-site"><SiteNav home /><main id="main-content">
    <section id="home" className="on-hero on-container"><div className="on-hero-copy"><h1>OISHII<br /><span>NORI</span></h1><p className="on-tagline">Boldly Oishii.</p><p>Sushi, ramen, and good company.<br />Make room for your next craving.</p><div className="on-actions"><a className="on-button" href="/menu">Order now ↗</a><a className="on-button on-outline" href="/menu/?reserve=1">Reserve ↗</a></div></div><div className="on-hero-art"><div className="on-brush" aria-hidden="true" /><FoodPhoto src="/products/oishii-baked-sushi.jpg" alt="Oishii baked sushi" eager /><span className="on-japanese" lang="ja">美味しい・海苔</span><span className="on-food-note">GOOD FOOD.<br />GOOD MOOD.</span></div></section>
    <section id="about" className="on-intro on-container"><h2>MADE FOR<br /><span className="on-brush-text">GOOD CRAVINGS.</span></h2><p>Big flavours. Warm bowls. Rolls to share. Japanese-inspired favourites for lunch, dinner, and every “let’s eat” in between.</p><span className="on-seal" lang="ja">美味</span></section>
    <section id="menu" className="on-sellers"><div className="on-container"><div className="on-section-title"><h2>BEST SELLERS.</h2><a href="/menu">Explore the menu ↗</a></div><div className="on-seller-grid">{BEST_SELLERS.map(item => <a href="/menu" className="on-seller" key={item.name}><div className="on-seller-image"><FoodPhoto src={item.photo} alt={`${item.name} food photo placeholder`} /><span className="on-badge">BEST SELLER</span></div><div className="on-seller-copy"><h3>{item.name}</h3><p>{item.description}</p>{price(item.name) && <strong className="on-price">{price(item.name)}</strong>}<span className="on-card-arrow" aria-hidden="true">↗</span></div></a>)}</div></div></section>
    <section className="on-categories"><div className="on-container"><h2>SUSHI. RAMEN. KATSU.<br /><span>YOUR KIND OF OISHII.</span></h2><div className="on-category-grid">{Object.entries(CATEGORY_PHOTOS).map(([name, src]) => <a href="/menu" key={name}><FoodPhoto src={src} alt={name} /><h3>{name} <span>↗</span></h3></a>)}</div></div></section>
    <section className="on-experience on-container"><FoodPhoto src={INTERIOR_PHOTO} alt="Your seat at Oishii Nori" /><div><h2>YOUR TABLE<br />IS WAITING.</h2><p>Come hungry. Stay for the company. Find your way to our kitchen in Santa Cruz, Laguna.</p><a className="on-button" href="#find-us">View branches ↗</a></div></section>
    <section id="order" className="on-order on-container"><div><span lang="ja">お持ち帰り</span><h2>ORDER ONLINE.</h2><p>Your Oishii favourites, just a few taps away.</p><a className="on-button on-light" href="/menu">Order now ↗</a></div><div><span lang="ja">ご予約</span><h2>RESERVE A TABLE.</h2><p>Make a little room for your next get-together.</p><a className="on-button on-outline" href="/menu/?reserve=1">Reserve ↗</a></div></section>
    <section id="faq" className="on-faq on-container"><h2>GOOD TO KNOW.</h2><div>{[['Do you take reservations?', 'Use the Reserve button to request a table online.'], ['What are your hours?', hoursLabel], ['Where are you located?', 'Pedro Guevara Ave., Santa Cruz, Laguna 4009, Philippines.'], ["What’s on the menu?", 'Sushi, ramen, katsu, snacks, and cafe drinks. Explore our full online menu.']].map(([question, answer]) => <details key={question}><summary>{question}</summary><p>{answer}</p></details>)}</div></section>
    <section id="catering-cta" className="on-catering-band"><div className="on-container"><span lang="ja">みんなで</span><h2>BIG GATHERINGS.<br />BOLD CRAVINGS.</h2><p>Events, parties, corporate get-togethers. Talk to us about sushi boats and group orders for your next occasion.</p><a className="on-button" href="/catering">Explore catering ↗</a></div></section>
    <section id="find-us" className="on-find on-container"><div className="on-map-panel"><h2>FIND THE KITCHEN.</h2><p>Pedro Guevara Ave.<br />Santa Cruz, Laguna 4009</p><p className="on-hours">Kitchen hours · {hoursLabel}</p><MapView className="on-map" {...shopLocation} zoom={17} /><a className="on-map-link" href="https://maps.app.goo.gl/9oACBZo6tUdzyabK7" target="_blank" rel="noreferrer">Open in Maps ↗</a></div><div id="contact"><h2>CONTACT US.</h2><p>A question, a craving, or something to share? Drop us a line.</p><InquiryForm kind="contact" /></div></section>
  </main><SiteFooter hours={hoursLabel} /></div>;
}
