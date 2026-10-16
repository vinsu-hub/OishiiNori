import { useReveal } from '@/lib/useReveal';
import { useEffect, useState } from 'react';
import SiteNav from '@/components/SiteNav';
import SiteFooter from '@/components/SiteFooter';
import FoodPhoto from '@/components/FoodPhoto';
import { fetchMenu, type ApiProduct } from '@/lib/api';
import { DISH_PAGES, dishProducts, type DishRoute } from '@/lib/dishPages';
import { priceLabel, productPhoto } from '@/lib/menu';
import { usePageMeta } from '@/lib/seo';

const RELATED: [string, string][] = [['Sushi in Laguna', '/sushi'], ['Ramen in Laguna', '/ramen'], ['Delivery in Santa Cruz', '/delivery'], ['Sushi catering', '/catering'], ['Full menu', '/our-menu']];

export default function DishLandingPage({ route, initialData }: { route: DishRoute; initialData?: { products: ApiProduct[] } }) {
  const config = DISH_PAGES[route];
  const revealRef = useReveal();
  usePageMeta(route);
  const [products, setProducts] = useState<ApiProduct[]>(initialData?.products ?? []);
  const [loading, setLoading] = useState(!initialData);
  useEffect(() => {
    let active = true;
    fetchMenu().then(data => { if (active) setProducts(data); }).catch(() => {}).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);
  const items = dishProducts(config, products);
  return <div className="on-site"><SiteNav /><main tabIndex={-1} id="main-content" ref={revealRef}>
    <section className="on-catering-hero on-container on-menu-hero"><p className="on-label">{config.label}</p><h1>{config.display[0]}<br /><span>{config.display[1]}</span><span className="on-h1-sub">{config.keyword}</span></h1><p>{config.intro}</p><div className="on-actions"><a className="on-button" href="/menu">Order now <span className="on-arrow" aria-hidden="true">↗</span></a><a className="on-button on-outline" href="/menu?reserve=1">Reserve <span className="on-arrow" aria-hidden="true">↗</span></a></div><span className="on-catering-kanji" lang="ja" aria-hidden="true">{config.japanese}</span></section>
    {loading && !items.length ? <section className="on-menu-content on-container" aria-busy="true"><div className="on-menu-grid" role="status" aria-label="Loading menu">{Array.from({ length: 4 }, (_, index) => <div className="on-menu-skeleton" key={index}><div /><span /><span /></div>)}</div></section>
      : config.sections.map(section => {
        const sectionItems = items.filter(product => section.categories.includes(product.category));
        if (!sectionItems.length) return null;
        return <section className="on-menu-content on-container" key={section.heading}><div className="on-menu-heading"><h2>{section.heading}</h2><p>{sectionItems.length} {sectionItems.length === 1 ? 'craving' : 'cravings'} to explore</p></div><div className="on-menu-grid">{sectionItems.map(product => <article className="on-menu-card" key={product.id}><FoodPhoto key={productPhoto(product) ?? product.id} src={productPhoto(product)} alt={product.name} /><div><p className="on-menu-category">{product.sizes.map(size => size.size_label).join(' · ')}</p><h3>{product.name}</h3>{priceLabel(product) && <p className="on-menu-price">{priceLabel(product)}</p>}<a className="on-button" href="/menu">Order now <span className="on-arrow" aria-hidden="true">↗</span></a></div></article>)}</div></section>;
      })}
    <section className="on-experience"><FoodPhoto src={config.photo.src} alt={config.photo.alt} /><div className="on-experience-heading"><p className="on-eyebrow">FIND US IN SANTA CRUZ</p><h2>PEDRO GUEVARA<br />AVE.</h2></div><div className="on-experience-copy"><p>Oishii Nori, Pedro Guevara Ave.,<br />Santa Cruz, Laguna 4009.<br />Dine in, take out, or order online.</p><a href="https://maps.app.goo.gl/9oACBZo6tUdzyabK7" target="_blank" rel="noreferrer">Open in Maps <span className="on-arrow" aria-hidden="true">↗</span></a></div></section>
    <section className="on-faq on-container"><h2>GOOD TO KNOW.</h2><div>{config.faq(products).map(([question, answer]) => <details key={question}><summary>{question}</summary><p>{answer}</p></details>)}</div></section>
    <section className="on-serve-strip"><div className="on-container"><p className="on-eyebrow">MORE FROM OISHII NORI</p><nav className="on-related" aria-label="Related pages">{RELATED.filter(([, href]) => href !== route).map(([label, href]) => <a key={href} href={href}>{label} <span className="on-arrow" aria-hidden="true">↗</span></a>)}</nav></div></section>
  </main><SiteFooter home={false} /></div>;
}
