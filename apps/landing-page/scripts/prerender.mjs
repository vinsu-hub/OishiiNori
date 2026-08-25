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
const SITE_URL = 'https://oishii-nori-landing.vercel.app';
const HERO_IMAGE = `${SITE_URL}/products/oishii-baked-sushi.jpg`;

const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

// Matches Home.tsx's own formatTime12h -- the FAQ schema's hours answer
// should read the same way the visible FAQ section on the page does.
function formatTime12h(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m).padStart(2, '0')} ${period}`;
}

function buildJsonLd(hours) {
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
    menu: `${SITE_URL}/#menu`,
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

  return `<script type="application/ld+json">${JSON.stringify(restaurant)}</script>\n    <script type="application/ld+json">${JSON.stringify(faq)}</script>`;
}

async function main() {
  const vite = await createServer({
    configFile: path.join(root, 'vite.config.ts'),
    server: { middlewareMode: true },
    appType: 'custom',
  });

  try {
    const { default: Home } = await vite.ssrLoadModule('/src/pages/Home.tsx');

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

    const bodyHtml = renderToString(React.createElement(Home, { initialData: { products, hours } }));

    const indexPath = path.join(root, 'dist', 'public', 'index.html');
    let indexHtml = fs.readFileSync(indexPath, 'utf-8');

    if (!indexHtml.includes('<div id="root"></div>')) {
      throw new Error('prerender.mjs: expected <div id="root"></div> placeholder not found in built index.html');
    }
    indexHtml = indexHtml.replace('<div id="root"></div>', `<div id="root">${bodyHtml}</div>`);
    indexHtml = indexHtml.replace('</head>', `    ${buildJsonLd(hours)}\n  </head>`);

    fs.writeFileSync(indexPath, indexHtml);
    console.log(`[prerender] wrote real content + JSON-LD into ${indexPath}`);
  } finally {
    await vite.close();
  }
}

main().catch((err) => {
  console.error('[prerender] failed:', err);
  process.exit(1);
});
