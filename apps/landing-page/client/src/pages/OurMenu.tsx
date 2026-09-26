import { useEffect, useState } from 'react';
import { Link, useSearch } from 'wouter';
import SiteNav from '@/components/SiteNav';
import SiteFooter from '@/components/SiteFooter';
import FoodPhoto from '@/components/FoodPhoto';
import { fetchMenu, type ApiProduct } from '@/lib/api';

// Vite's file inventory resolves only photos that actually exist, including during SSR.
const photoFiles = Object.keys(import.meta.glob('/public/products/*.jpg')).map(path => path.replace('/public', ''));
const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
function productPhoto(product: ApiProduct) {
  const imageName = product.image_path?.split('/').pop()?.split('?')[0];
  return photoFiles.find(path => path.split('/').pop() === imageName) ?? photoFiles.find(path => path === `/products/${slug(product.name)}.jpg`);
}
function priceLabel(product: ApiProduct) {
  const prices = product.sizes.map(size => size.price).filter(price => typeof price === 'number' && Number.isFinite(price) && price >= 0);
  return prices.length ? `${product.sizes.length > 1 ? 'from ' : ''}₱${Math.min(...prices).toLocaleString('en-PH', { maximumFractionDigits: 2 })}` : null;
}
export default function OurMenu() {
  const search = useSearch();
  const requested = new URLSearchParams(search).get('cat') || 'All';
  const [products, setProducts] = useState<ApiProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    document.title = 'Menu | Oishii Nori';
    let active = true;
    setLoading(true); setError(false);
    fetchMenu().then(data => { if (active) setProducts(data.filter(product => product.active)); }).catch(() => { if (active) setError(true); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [attempt]);
  const categories = [...new Set(products.map(product => product.category).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const selected = requested.toLowerCase() === 'all' ? 'All' : categories.find(category => category.toLowerCase() === requested.toLowerCase()) ?? categories.find(category => category.toLowerCase().includes(requested.toLowerCase())) ?? 'All';
  const visible = selected === 'All' ? products : products.filter(product => product.category === selected);
  return <div className="on-site"><SiteNav /><main id="main-content">
    <section className="on-catering-hero on-container on-menu-hero"><p className="on-label">OISHII NORI / ON THE MENU</p><h1>FIND YOUR<br /><span>NEXT CRAVING.</span></h1><p>Browse the kitchen’s menu, then order your favourites online.</p><a className="on-button" href="/menu">Order now ↗</a></section>
    <nav className="on-menu-filters" aria-label="Menu categories"><div>{['All', ...categories].map(category => <Link key={category} href={category === 'All' ? '/our-menu' : `/our-menu?cat=${encodeURIComponent(category)}`} aria-current={selected === category ? 'true' : undefined}>{category}</Link>)}</div></nav>
    <section className="on-menu-content on-container" aria-busy={loading}><div className="on-menu-heading"><h2>{selected === 'All' ? 'THE FULL MENU.' : selected}</h2>{!loading && !error && <p>{visible.length} {visible.length === 1 ? 'craving' : 'cravings'} to explore</p>}</div>
      {loading ? <div className="on-menu-grid" role="status" aria-label="Loading menu">{Array.from({ length: 8 }, (_, index) => <div className="on-menu-skeleton" key={index}><div /><span /><span /></div>)}</div> : error ? <div className="on-menu-state" role="alert"><h3>The menu needs a moment.</h3><p>We couldn’t load the menu. Please try again, or head to online ordering.</p><button className="on-button" onClick={() => setAttempt(value => value + 1)}>Try again</button><a className="on-map-link" href="/menu">Order online ↗</a></div> : !visible.length ? <div className="on-menu-state"><h3>No dishes here just yet.</h3><p>Please check back soon for fresh cravings.</p><a className="on-button" href="/menu">Order now ↗</a></div> : <div className="on-menu-grid">{visible.map(product => <article className="on-menu-card" key={product.id}><FoodPhoto key={productPhoto(product) ?? product.id} src={productPhoto(product)} alt={product.name} /><div><p className="on-menu-category">{product.category}</p><h3>{product.name}</h3>{priceLabel(product) && <p className="on-menu-price">{priceLabel(product)}</p>}<a className="on-button" href="/menu">Order now ↗</a></div></article>)}</div>}
    </section>
  </main><SiteFooter home={false} /></div>;
}
