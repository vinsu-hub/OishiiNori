import { useReveal } from '@/lib/useReveal';
import { useEffect, useState } from 'react';
import SiteNav from '@/components/SiteNav';
import SiteFooter from '@/components/SiteFooter';
import { fetchDeliveryFees, type DeliveryFee } from '@/lib/api';
import { peso } from '@/lib/menu';
import { usePageMeta } from '@/lib/seo';

// Same delivery_fees rows the online order form charges from, so this page
// can never promise an area or a fee that checkout doesn't honor. Every row
// is a Santa Cruz barangay: nearby towns get a pickup line, not a delivery claim.
const NEARBY_TOWNS = ['Pagsanjan', 'Pila', 'Lumban', 'Victoria', 'Magdalena'];

function zonesOf(fees: DeliveryFee[]) {
  const zones = new Map<string, DeliveryFee[]>();
  for (const row of [...fees].sort((a, b) => a.fee - b.fee || a.barangay.localeCompare(b.barangay))) {
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
  const amounts = fees.map(row => row.fee);
  const range = amounts.length ? `${peso(Math.min(...amounts))} to ${peso(Math.max(...amounts))}` : null;
  const faq: [string, string][] = [
    ['Magkano ang delivery fee?', range ? `From ${range}, depending on your barangay. The fee is added automatically when you pick your barangay at checkout.` : 'It depends on your barangay; the fee is added automatically at checkout.'],
    ['Nagde-deliver ba kayo sa labas ng Santa Cruz?', `Not yet. If you’re in ${NEARBY_TOWNS.slice(0, -1).join(', ')} or ${NEARBY_TOWNS[NEARBY_TOWNS.length - 1]}, order online for pickup at our kitchen on Pedro Guevara Ave.`],
    ['What can I order for delivery?', 'The full online menu: sushi, baked sushi, maki, sushi boats, ramen, takoyaki, rice meals and drinks.'],
  ];
  return <div className="on-site"><SiteNav /><main tabIndex={-1} id="main-content" ref={revealRef}>
    <section className="on-catering-hero on-container on-menu-hero"><p className="on-label">OISHII NORI / DELIVERY</p><h1>SUSHI DELIVERY<br /><span>SANTA CRUZ.</span><span className="on-h1-sub">Sushi, ramen & takoyaki delivered in Santa Cruz, Laguna</span></h1><p>Oishii Nori delivers across Santa Cruz, Laguna{fees.length ? `: ${fees.length} barangays` : ''}, from the Poblacion to Santo Angel. Pick your barangay at checkout and the delivery fee is added for you. The fees below are the same ones our online order form uses.</p><div className="on-actions"><a className="on-button" href="/menu">Order for delivery <span className="on-arrow" aria-hidden="true">↗</span></a></div><span className="on-catering-kanji" lang="ja" aria-hidden="true">配達</span></section>
    <section className="on-menu-content on-container"><div className="on-menu-heading"><h2>WHERE WE DELIVER.</h2><p>{range ? `Delivery fees ${range}` : ' '}</p></div>
      <div className="on-delivery-zones">{zonesOf(fees).map(([zone, rows]) => <article key={zone}><h3>{/pin|home/i.test(zone) ? 'Next to our kitchen' : zone}</h3><ul>{rows.map(row => <li key={row.barangay}><span>{row.barangay}</span><strong>{peso(row.fee)}</strong></li>)}</ul></article>)}</div>
    </section>
    <section className="on-catering-band"><div className="on-container"><span lang="ja">近く</span><h2>NEARBY IN<br />LAGUNA?</h2><p>Coming from {NEARBY_TOWNS.join(', ')}? We don’t deliver outside Santa Cruz yet, but our kitchen on Pedro Guevara Ave. is a short drive away. Order online and choose pickup.</p><a className="on-button" href="/menu">Order for pickup <span className="on-arrow" aria-hidden="true">↗</span></a></div></section>
    <section className="on-faq on-container"><h2>GOOD TO KNOW.</h2><div>{faq.map(([question, answer]) => <details key={question}><summary>{question}</summary><p>{answer}</p></details>)}</div></section>
    <section className="on-serve-strip"><div className="on-container"><p className="on-eyebrow">WHAT TO ORDER</p><nav className="on-related" aria-label="Related pages">{[['Sushi in Laguna', '/sushi'], ['Ramen in Laguna', '/ramen'], ['Full menu', '/our-menu'], ['Sushi catering', '/catering']].map(([label, href]) => <a key={href} href={href}>{label} <span className="on-arrow" aria-hidden="true">↗</span></a>)}</nav></div></section>
  </main><SiteFooter home={false} /></div>;
}
