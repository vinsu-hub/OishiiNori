// Build-time prerendering: bakes the real, live-fetched menu + hours into
// the shipped index.html so every crawler -- JS-executing or not -- sees the
// actual page content, not an empty <div id="root">. Uses Vite's own SSR
// module loader (not a hand-rolled esbuild bundle) so this automatically
// gets the exact same JSX transform / "@/" alias / import.meta.env handling
// as the real app build -- no config to keep in sync by hand.
//
// The real browser bundle is untouched: main.tsx still does a plain
// createRoot().render(<App/>) with no initialData, so client behavior
// (the existing useEffect fetches in Home.tsx) is unchanged. This script
// only affects what's already in the HTML before any JS runs.
import { createServer, loadEnv } from 'vite';
import { renderToString } from 'react-dom/server';
import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const SHOP_ADDRESS = {
  streetAddress: 'Pedro Guevara Ave',
  addressLocality: 'Santa Cruz',
  addressRegion: 'Laguna',
  postalCode: '4009',
  addressCountry: 'PH',
};
const SHOP_GEO = { lat: 14.278476, lng: 121.4158777 };
const SITE_URL = 'https://www.oishiinori.com';
const MAPS_URL = 'https://maps.app.goo.gl/9oACBZo6tUdzyabK7';
// Blocked on the owner: fill these in and they flow into the Restaurant schema.
// Keep them identical to the Google Business Profile (same phone format, same links).
const SHOP_PHONE = null; // e.g. '+63 9XX XXX XXXX'
const SHOP_PROFILES = []; // Facebook, Instagram, TikTok, GrabFood, foodpanda URLs
const HERO_IMAGE = `${SITE_URL}/products/oishii-baked-sushi.jpg`;

const BREADCRUMB_NAMES = {
  '/sushi': 'Sushi', '/ramen': 'Ramen', '/delivery': 'Delivery', '/our-menu': 'Menu',
  '/catering': 'Catering', '/about': 'About', '/events': 'Events',
};

const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

// Matches src/lib/utils.ts's own formatTime12h (which Home.tsx now imports)
// -- the FAQ schema's hours answer should read the same way the visible FAQ
// section on the page does. Kept as its own copy rather than loaded via
// vite.ssrLoadModule: this function is called before `main()` creates the
// Vite server, in code shared with a hypothetical non-SSR caller, so
// duplicating this one small pure function is simpler than restructuring
// the module for an import that would only save a few lines.
function formatTime12h(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m).padStart(2, '0')} ${period}`;
}

function buildJsonLd({ hours, route, products, deliveryFees, pageMeta, dishPages, dishProducts }) {
  const openingHours = hours
    ? [
        {
          '@type': 'OpeningHoursSpecification',
          dayOfWeek: DAY_NAMES.filter((_, i) => !(hours.closed_weekdays || []).includes(i)),
          opens: hours.open_time.slice(0, 5),
          closes: hours.close_time.slice(0, 5),
        },
      ]
    : undefined;

  const restaurant = {
    '@context': 'https://schema.org',
    '@type': 'Restaurant',
    '@id': `${SITE_URL}/#restaurant`,
    name: 'Oishii Nori',
    image: HERO_IMAGE,
    url: SITE_URL,
    alternateName: 'Oishii Nori Santa Cruz',
    description: pageMeta['/'].description,
    servesCuisine: ['Japanese', 'Sushi', 'Ramen', 'Takoyaki', 'Filipino-Japanese'],
    priceRange: '₱₱',
    currenciesAccepted: 'PHP',
    paymentAccepted: 'Cash, GCash',
    hasMap: MAPS_URL,
    areaServed: [
      { '@type': 'City', name: 'Santa Cruz', containedInPlace: { '@type': 'AdministrativeArea', name: 'Laguna' } },
    ],
    ...(SHOP_PHONE ? { telephone: SHOP_PHONE } : {}),
    ...(SHOP_PROFILES.length ? { sameAs: SHOP_PROFILES } : {}),
    address: {
      '@type': 'PostalAddress',
      ...SHOP_ADDRESS,
    },
    geo: { '@type': 'GeoCoordinates', latitude: SHOP_GEO.lat, longitude: SHOP_GEO.lng },
    ...(openingHours ? { openingHoursSpecification: openingHours } : {}),
    menu: `${SITE_URL}/our-menu`,
    acceptsReservations: true,
  };

  const hoursText = hours
    ? `Open daily, ${formatTime12h(hours.open_time.slice(0, 5))} — ${formatTime12h(hours.close_time.slice(0, 5))}.`
    : 'Open daily.';

  const faq = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: [
      {
        '@type': 'Question',
        name: 'Do you take reservations?',
        acceptedAnswer: { '@type': 'Answer', text: "Yes — reserve a table online and we'll confirm it in real time." },
      },
      {
        '@type': 'Question',
        name: 'What are your hours?',
        acceptedAnswer: { '@type': 'Answer', text: hoursText },
      },
      {
        '@type': 'Question',
        name: 'Saan kayo sa Santa Cruz, Laguna?',
        acceptedAnswer: { '@type': 'Answer', text: 'Pedro Guevara Ave., Santa Cruz, Laguna 4009, Philippines.' },
      },
      {
        '@type': 'Question',
        name: 'Do you deliver?',
        acceptedAnswer: { '@type': 'Answer', text: 'Yes, across Santa Cruz, Laguna, and to nearby towns such as Pagsanjan, Pila, Lumban and Magdalena. The fee depends on your barangay or town; see oishiinori.com/delivery for every area.' },
      },
      {
        '@type': 'Question',
        name: "What's on the menu?",
        acceptedAnswer: { '@type': 'Answer', text: 'Sushi bake, maki, ramen, takoyaki, katsu, bento, and drip tea. Explore our full online menu.' },
      },
    ],
  };

  const faqPage = pairs => ({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: pairs.map(([name, text]) => ({ '@type': 'Question', name, acceptedAnswer: { '@type': 'Answer', text } })),
  });
  const menuSchema = (name, url, sections) => ({
      '@context': 'https://schema.org',
      '@type': 'Menu',
      name,
      url,
      hasMenuSection: sections.map(({ name: sectionName, items }) => ({
        '@type': 'MenuSection',
        name: sectionName,
        hasMenuItem: items.map(product => {
          const prices = product.sizes.map(size => size.price)
            .filter(price => typeof price === 'number' && Number.isFinite(price) && price >= 0);
          return {
            '@type': 'MenuItem',
            name: product.name,
            ...(prices.length ? { offers: {
              '@type': 'Offer', price: Math.min(...prices), priceCurrency: 'PHP',
            } } : {}),
          };
        }),
      })),
    });

  const schemas = [restaurant];
  if (route === '/') schemas.push(faq);
  if (route !== '/') schemas.push({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: `${SITE_URL}/` },
      { '@type': 'ListItem', position: 2, name: BREADCRUMB_NAMES[route], item: `${SITE_URL}${route}` },
    ],
  });
  if (route === '/our-menu') {
    const activeProducts = products.filter(product => product.active);
    const categories = [...new Set(activeProducts.map(product => product.category))];
    schemas.push(menuSchema('Oishii Nori Menu', `${SITE_URL}/our-menu`,
      categories.map(category => ({ name: category, items: activeProducts.filter(product => product.category === category) }))));
  }
  const dish = dishPages[route];
  if (dish) {
    const items = dishProducts(dish, products);
    schemas.push(menuSchema(`Oishii Nori ${dish.label.split(' / ')[1].toLowerCase()} menu`, `${SITE_URL}${route}`,
      dish.sections.map(section => ({ name: section.heading, items: items.filter(product => section.categories.includes(product.category)) }))
        .filter(section => section.items.length)));
    schemas.push(faqPage(dish.faq(products)));
  }
  if (route === '/delivery' && deliveryFees.length) schemas.push({
    '@context': 'https://schema.org',
    '@type': 'Service',
    name: 'Oishii Nori Delivery',
    serviceType: 'Food delivery',
    description: pageMeta['/delivery'].description,
    url: `${SITE_URL}/delivery`,
    provider: { '@id': `${SITE_URL}/#restaurant` },
    areaServed: deliveryFees.map(row => ({ '@type': 'Place', name: row.zone === 'Nearby towns' ? `${row.barangay}, Laguna` : `${row.barangay}, Santa Cruz, Laguna` })),
    offers: deliveryFees.map(row => ({
      '@type': 'Offer', name: `Delivery to ${row.barangay}`, price: row.fee, priceCurrency: 'PHP',
    })),
  });
  if (route === '/catering') schemas.push({
    '@context': 'https://schema.org',
    '@type': 'Service',
    name: 'Oishii Nori Catering',
    serviceType: 'Catering, sushi boats and group orders',
    description: 'Fresh sushi boats, generous spreads, and a Filipino welcome for events, parties, meetings and team gatherings.',
    url: `${SITE_URL}/catering`,
    provider: { '@id': `${SITE_URL}/#restaurant` },
  });
  if (route === '/events') schemas.push({
    '@context': 'https://schema.org',
    '@type': 'Event',
    name: 'Sushi Making Class for Kids — Your Sushi Story',
    description: 'A hands-on sushi-making class where kids learned to roll, slice and pack their own maki with the Oishii Nori crew.',
    eventStatus: 'https://schema.org/EventScheduled',
    eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
    startDate: '2026-10-04',
    image: [`${SITE_URL}/events/sushi-kids/01.jpg`],
    location: { '@id': `${SITE_URL}/#restaurant` },
    organizer: { '@id': `${SITE_URL}/#restaurant` },
    url: `${SITE_URL}/events`,
  });
  return schemas.map(schema => `<script type="application/ld+json">${JSON.stringify(schema).replace(/</g, '\\u003c')}</script>`).join('\n    ');
}

function escapeAttribute(value) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Always use the untouched build shell so no route inherits another route's body or schema.
function renderPageHtml(template, bodyHtml, page, jsonLd) {
  if (!template.includes('<div id="root"></div>')) {
    throw new Error('prerender.mjs: expected empty root placeholder not found in built index.html');
  }
  let html = template.replace('<div id="root"></div>', () => `<div id="root">${bodyHtml}</div>`);
  const replaceRequired = (pattern, replacement) => {
    if (!pattern.test(html)) throw new Error(`prerender.mjs: missing head tag ${pattern}`);
    html = html.replace(pattern, () => replacement);
  };
  const title = escapeAttribute(page.title);
  const description = escapeAttribute(page.description);
  const url = `${SITE_URL}${page.route}`;
  replaceRequired(/<title>[^<]*<\/title>/, `<title>${title}</title>`);
  replaceRequired(/<meta name="description" content="[^"]*"\s*\/>/, `<meta name="description" content="${description}" />`);
  replaceRequired(/<link rel="canonical" href="[^"]*"\s*\/>/, `<link rel="canonical" href="${url}" />`);
  for (const [key, value] of Object.entries({ 'og:url': url, 'og:title': title, 'og:description': description })) {
    replaceRequired(new RegExp(`<meta property="${key}" content="[^"]*"\\s*\\/>`), `<meta property="${key}" content="${value}" />`);
  }
  for (const [key, value] of Object.entries({ 'twitter:title': title, 'twitter:description': description })) {
    replaceRequired(new RegExp(`<meta name="${key}" content="[^"]*"\\s*\\/>`), `<meta name="${key}" content="${value}" />`);
  }
  html = html.replace(/<script\b[^>]*type="application\/ld\+json"[^>]*>[\s\S]*?<\/script>/g, '');
  return html.replace('</head>', () => `    ${jsonLd}\n  </head>`);
}

async function main() {
  const vite = await createServer({
    configFile: path.join(root, 'vite.config.ts'),
    server: { middlewareMode: true },
    appType: 'custom',
  });

  try {
    const { Router } = await vite.ssrLoadModule('wouter');
    const { PAGE_META } = await vite.ssrLoadModule('/src/lib/seo.ts');
    const { DISH_PAGES, dishProducts } = await vite.ssrLoadModule('/src/lib/dishPages.ts');

    // Vercel's build sets VITE_API_BASE_URL as a real process env var; local
    // builds don't have it set unless the shell exports it, so fall back to
    // the same .env.local Vite itself would read (envDir = app root, per
    // vite.config.ts).
    const fileEnv = loadEnv('production', root, 'VITE_');
    const apiBase = process.env.VITE_API_BASE_URL || fileEnv.VITE_API_BASE_URL;
    if (!apiBase) {
      throw new Error('VITE_API_BASE_URL is not set -- cannot fetch real data to prerender.');
    }

    console.log(`[prerender] fetching real data from ${apiBase}...`);
    const [products, hours, deliveryFees, events] = await Promise.all([
      fetch(`${apiBase}/public/menu`).then((r) => {
        if (!r.ok) throw new Error(`GET /public/menu failed: ${r.status}`);
        return r.json();
      }),
      fetch(`${apiBase}/public/business-hours`)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
      fetch(`${apiBase}/public/delivery-fees`).then((r) => {
        if (!r.ok) throw new Error(`GET /public/delivery-fees failed: ${r.status}`);
        return r.json();
      }),
      // Owner-managed events; the page also refreshes them at runtime, so a
      // failure here just means the static HTML starts without them.
      fetch(`${apiBase}/public/events`)
        .then((r) => (r.ok ? r.json() : []))
        .catch(() => []),
    ]);
    console.log(`[prerender] fetched ${products.length} products, ${deliveryFees.length} delivery areas, hours=${hours ? 'ok' : 'unavailable'}`);

    // Titles/descriptions live in src/lib/seo.ts (shared with the pages' own
    // usePageMeta), so the static <head> and the hydrated one never disagree.
    const pages = [
      { route: '/', component: 'Home', initialData: { products, hours } },
      { route: '/sushi', component: 'Sushi', initialData: { products } },
      { route: '/ramen', component: 'Ramen', initialData: { products } },
      { route: '/delivery', component: 'Delivery', initialData: { deliveryFees } },
      { route: '/our-menu', component: 'OurMenu', initialData: { products } },
      { route: '/catering', component: 'Catering' },
      { route: '/about', component: 'About', initialData: { hours } },
      { route: '/events', component: 'Events', initialData: { events } },
    ].map(page => ({ ...page, ...PAGE_META[page.route] }));
    const outputRoot = path.join(root, 'dist', 'public');
    const template = fs.readFileSync(path.join(outputRoot, 'index.html'), 'utf-8');
    for (const page of pages) {
      const { default: Component } = await vite.ssrLoadModule(`/src/pages/${page.component}.tsx`);
      const bodyHtml = renderToString(React.createElement(Router, { ssrPath: page.route },
        React.createElement(Component, page.initialData ? { initialData: page.initialData } : {})));
      const outputPath = path.join(outputRoot, page.route.slice(1), 'index.html');
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      const jsonLd = buildJsonLd({ hours, route: page.route, products, deliveryFees, pageMeta: PAGE_META, dishPages: DISH_PAGES, dishProducts });
      fs.writeFileSync(outputPath, renderPageHtml(template, bodyHtml, page, jsonLd));
      console.log(`[prerender] wrote ${page.route}: real content + route metadata + JSON-LD into ${outputPath}`);
    }

    // sitemap.xml comes from the same route list, so a new page can't be
    // prerendered but missing from the sitemap (or the reverse). /review is a
    // client-only form page, indexed but not prerendered.
    const lastmod = new Date().toISOString().slice(0, 10);
    const sitemapRoutes = [...pages.map(page => page.route), '/review'];
    const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${sitemapRoutes
      .map(route => `  <url>\n    <loc>${SITE_URL}${route}</loc>\n    <lastmod>${lastmod}</lastmod>\n  </url>`).join('\n')}\n</urlset>\n`;
    fs.writeFileSync(path.join(outputRoot, 'sitemap.xml'), sitemap);
    console.log(`[prerender] wrote sitemap.xml with ${sitemapRoutes.length} URLs`);
  } finally {
    await vite.close();
  }
}

main().catch((err) => {
  console.error('[prerender] failed:', err);
  process.exit(1);
});
