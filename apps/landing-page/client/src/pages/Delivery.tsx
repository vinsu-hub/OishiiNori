import { useReveal } from '@/lib/useReveal';
import { useEffect, useState } from 'react';
import SiteNav from '@/components/SiteNav';
import SiteFooter from '@/components/SiteFooter';
import { fetchDeliveryFees, type DeliveryFee } from '@/lib/api';
import { peso } from '@/lib/menu';
import { usePageMeta } from '@/lib/seo';

// Same delivery_fees rows the online order form charges from, so this page
// can never promise an area or a fee that checkout doesn't honor. Zone
// "Santa Cruz" rows are barangays; "Nearby towns" rows are whole towns.
const TOWN_ZONE = 'Nearby towns';

function zonesOf(fees: DeliveryFee[]) {
  const zones = new Map<string, DeliveryFee[]>();
  const sorted = [...fees].sort((a, b) => Number(a.zone === TOWN_ZONE) - Number(b.zone === TOWN_ZONE)
    || a.fee - b.fee || a.barangay.localeCompare(b.barangay));
  for (const row of sorted) {
    zones.set(row.zone, [...(zones.get(row.zone) ?? []), row]);
  }
  return [...zones.entries()];
}

export default function Delivery({ initialData }: { initialData?: { deliveryFees: DeliveryFee[] } } = {}) {
  const revealRef = useReveal();
  usePageMeta('/delivery');
  const [fees, setFees] = useState<DeliveryFee[]>(initialData?.deliveryFees ?? []);
  useEffect(() => {
    let active = true;
    fetchDeliveryFees().then(data => { if (active) setFees(data); }).catch(() => {});
    return () => { active = false; };
  }, []);
  const barangays = fees.filter(row => row.zone !== TOWN_ZONE);
  const towns = fees.filter(row => row.zone === TOWN_ZONE).map(row => row.barangay);
  const amounts = fees.map(row => row.fee);
  const range = amounts.length ? `${peso(Math.min(...amounts))} to ${peso(Math.max(...amounts))}` : null;
  const faq: [string, string][] = [
    ['Magkano ang delivery fee?', range ? `From ${range}, depending on your barangay or town. The fee is added automatically when you pick it at checkout.` : 'It depends on your barangay or town; the fee is added automatically at checkout.'],
    ['Nagde-deliver ba kayo sa labas ng Santa Cruz?', towns.length ? `Yes. We also deliver to ${towns.slice(0, -1).join(', ')} and ${towns[towns.length - 1]}. Pick your town at checkout; the fees are listed above.` : 'For now we deliver within Santa Cruz. Order online for pickup at our kitchen on Pedro Guevara Ave.'],
    ['What can I order for delivery?', 'The full online menu: sushi, baked sushi, maki, sushi boats, ramen, takoyaki, rice meals and drinks.'],
  ];
  return <div className="on-site"><SiteNav /><main tabIndex={-1} id="main-content" ref={revealRef}>
    <section className="on-catering-hero on-container on-menu-hero"><p className="on-label">OISHII NORI / DELIVERY</p><h1>SUSHI DELIVERY<br /><span>SANTA CRUZ.</span><span className="on-h1-sub">Sushi, ramen & takoyaki delivered in Santa Cruz, Laguna</span></h1><p>Oishii Nori delivers across Santa Cruz, Laguna{barangays.length ? `: ${barangays.length} barangays` : ''}, from the Poblacion to Santo Angel{towns.length ? `, plus ${towns.length} nearby towns` : ''}. Pick your barangay or town at checkout and the delivery fee is added for you. The fees below are the same ones our online order form uses.</p><div className="on-actions"><a className="on-button" href="/menu">Order for delivery <span className="on-arrow" aria-hidden="true">↗</span></a></div><span className="on-catering-kanji" lang="ja" aria-hidden="true">配達</span></section>
    <section className="on-menu-content on-container"><div className="on-menu-heading"><h2>WHERE WE DELIVER.</h2><p>{range ? `Delivery fees ${range}` : ' '}</p></div>
      <div className="on-delivery-zones">{zonesOf(fees).map(([zone, rows]) => <article key={zone}><h3>{/pin|home/i.test(zone) ? 'Next to our kitchen' : zone}</h3><ul>{rows.map(row => <li key={row.barangay}><span>{row.barangay}</span><strong>{peso(row.fee)}</strong></li>)}</ul></article>)}</div>
    </section>
    <section className="on-catering-band"><div className="on-container"><span lang="ja">近く</span><h2>NEARBY IN<br />LAGUNA?</h2><p>{towns.length ? `We deliver to ${towns.join(', ')} too. Pick your town at checkout, or choose pickup at our kitchen on Pedro Guevara Ave.` : 'Our kitchen on Pedro Guevara Ave. is a short drive away. Order online and choose pickup.'}</p><a className="on-button" href="/menu">Order online <span className="on-arrow" aria-hidden="true">↗</span></a></div></section>
    <section className="on-faq on-container"><h2>GOOD TO KNOW.</h2><div>{faq.map(([question, answer]) => <details key={question}><summary>{question}</summary><p>{answer}</p></details>)}</div></section>
    <section className="on-serve-strip"><div className="on-container"><p className="on-eyebrow">WHAT TO ORDER</p><nav className="on-related" aria-label="Related pages">{[['Sushi in Laguna', '/sushi'], ['Ramen in Laguna', '/ramen'], ['Full menu', '/our-menu'], ['Sushi catering', '/catering']].map(([label, href]) => <a key={href} href={href}>{label} <span className="on-arrow" aria-hidden="true">↗</span></a>)}</nav></div></section>
  </main><SiteFooter home={false} /></div>;
}
