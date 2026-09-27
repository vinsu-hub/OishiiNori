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
const HERO_IMAGE = `${SITE_URL}/products/oishii-baked-sushi.jpg`;

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

function buildJsonLd(hours, route, products) {
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
    servesCuisine: ['Japanese', 'Sushi', 'Ramen'],
    priceRange: '₱₱',
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
        name: 'Where are you located?',
        acceptedAnswer: { '@type': 'Answer', text: 'Pedro Guevara Ave, Santa Cruz, Laguna 4009, Philippines.' },
      },
      {
        '@type': 'Question',
        name: "What's on the menu?",
        acceptedAnswer: { '@type': 'Answer', text: 'Sushi, ramen, tako/snacks, and cafe drinks, made fresh daily.' },
      },
    ],
  };

  const schemas = [restaurant];
  if (route === '/') schemas.push(faq);
  if (route === '/our-menu') {
    const activeProducts = products.filter(product => product.active);
    const categories = [...new Set(activeProducts.map(product => product.category))];
    schemas.push({
      '@context': 'https://schema.org',
      '@type': 'Menu',
      name: 'Oishii Nori Menu',
      url: `${SITE_URL}/our-menu`,
      hasMenuSection: categories.map(category => ({
        '@type': 'MenuSection',
        name: category,
        hasMenuItem: activeProducts.filter(product => product.category === category).map(product => {
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
  }
  if (route === '/catering') schemas.push({
    '@context': 'https://schema.org',
    '@type': 'Service',
    name: 'Oishii Nori Catering',
    serviceType: 'Catering, sushi boats and group orders',
    description: 'Fresh sushi boats, generous spreads, and a Filipino welcome for events, parties, meetings and team gatherings.',
    url: `${SITE_URL}/catering`,
    provider: { '@id': `${SITE_URL}/#restaurant` },
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
    const [products, hours] = await Promise.all([
      fetch(`${apiBase}/public/menu`).then((r) => {
        if (!r.ok) throw new Error(`GET /public/menu failed: ${r.status}`);
        return r.json();
      }),
      fetch(`${apiBase}/public/business-hours`)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
    ]);
    console.log(`[prerender] fetched ${products.length} products, hours=${hours ? 'ok' : 'unavailable'}`);

    const pages = [
      { route: '/', component: 'Home', title: 'Oishii Nori — Good food, good mood.',
        description: 'Filipino-owned Oishii Nori serves fresh, authentic Japanese food with a Filipino twist. Everyday value in Santa Cruz, Laguna.', initialData: { products, hours } },
      { route: '/about', component: 'About', title: 'About | Oishii Nori — Filipino-Owned Japanese Kitchen in Santa Cruz, Laguna',
        description: 'Meet Oishii Nori, a Filipino-owned kitchen in Santa Cruz, Laguna serving fresh Japanese food with a Filipino twist, fair prices, and a warm welcome.', initialData: { hours } },
      { route: '/our-menu', component: 'OurMenu', title: 'Menu | Oishii Nori — Sushi, Ramen & Katsu in Santa Cruz, Laguna',
        description: 'Explore Oishii Nori’s live menu with real prices: Japanese favorites and rolls with a Filipino twist in Santa Cruz, Laguna. Find your next craving and order online.', initialData: { products } },
      { route: '/catering', component: 'Catering', title: 'Catering | Oishii Nori — Sushi Boats & Group Orders in Santa Cruz, Laguna',
        description: 'Bring Oishii Nori to your next gathering: fresh sushi boats, generous spreads, and group orders in Santa Cruz, Laguna. Share your occasion and let’s talk food.' },
    ];
    const outputRoot = path.join(root, 'dist', 'public');
    const template = fs.readFileSync(path.join(outputRoot, 'index.html'), 'utf-8');
    for (const page of pages) {
      const { default: Component } = await vite.ssrLoadModule(`/src/pages/${page.component}.tsx`);
      const bodyHtml = renderToString(React.createElement(Router, { ssrPath: page.route },
        React.createElement(Component, page.initialData ? { initialData: page.initialData } : {})));
      const outputPath = path.join(outputRoot, page.route.slice(1), 'index.html');
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, renderPageHtml(template, bodyHtml, page, buildJsonLd(hours, page.route, products)));
      console.log(`[prerender] wrote ${page.route}: real content + route metadata + JSON-LD into ${outputPath}`);
    }
  } finally {
    await vite.close();
  }
}

main().catch((err) => {
  console.error('[prerender] failed:', err);
  process.exit(1);
});
