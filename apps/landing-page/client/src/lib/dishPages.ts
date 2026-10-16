import type { ApiProduct } from '@/lib/api';
import { peso, productPrices } from '@/lib/menu';

// Keyword landing pages (/sushi, /ramen). Takoyaki stays on /our-menu
// and Home: keyword research found no standalone search demand for it. Each one shows the live
// catalog for its own menu categories, so every page has real, distinct
// content -- not a copy of /our-menu with a different title. Main keyword per
// page: apps/landing-page/SEO_KEYWORDS.md.
export type DishRoute = '/sushi' | '/ramen';

export interface DishSection { heading: string; categories: string[] }

export interface DishPageConfig {
  route: DishRoute;
  label: string;
  /** Display lines of the H1; the keyword line underneath is `keyword`. */
  display: [string, string];
  keyword: string;
  japanese: string;
  intro: string;
  sections: DishSection[];
  /** Products (by name) in those categories that are not dishes, e.g. packaging. */
  exclude?: string[];
  photo: { src: string; alt: string };
  faq: (products: ApiProduct[]) => [string, string][];
}

function minPrice(products: ApiProduct[], categories: string[]) {
  const prices = products.filter(product => categories.includes(product.category)).flatMap(productPrices);
  return prices.length ? Math.min(...prices) : null;
}

export function dishProducts(config: DishPageConfig, products: ApiProduct[]) {
  return products.filter(product => product.active && !config.exclude?.includes(product.name)
    && config.sections.some(section => section.categories.includes(product.category)));
}

const DELIVERY_ANSWER = 'Yes. We deliver across Santa Cruz, Laguna, and the fee depends on your barangay. See our delivery page for every area and fee, or order online for pickup.';

export const DISH_PAGES: Record<DishRoute, DishPageConfig> = {
  '/sushi': {
    route: '/sushi',
    label: 'OISHII NORI / SUSHI',
    display: ['SUSHI IN', 'LAGUNA.'],
    keyword: 'Sushi bake, maki rolls & sushi boats in Santa Cruz, Laguna',
    japanese: '寿司',
    intro: 'Looking for sushi in Laguna? Oishii Nori is a Filipino-owned Japanese kitchen on Pedro Guevara Ave in Santa Cruz. We make sushi bake trays (baked sushi) for 2 to 6 pax, maki rolls by 4 or 8 pieces, torched maki, salmon boxes, and sushi boats for parties. Every price on this page comes straight from our live menu.',
    sections: [
      { heading: 'Sushi bake', categories: ['Baked Sushi'] },
      { heading: 'Maki rolls', categories: ['Oishii Maki Rolls', 'Torched Maki'] },
      { heading: 'Sushi boats & platters', categories: ['Maki & Gyoza Platters (Bundle)', 'Oishii Platter (Bundle)', 'Salmon Box'] },
    ],
    photo: { src: '/hero/sushi-boats.jpg', alt: 'Oishii Nori sushi boats filled with maki rolls in Santa Cruz, Laguna' },
    faq: products => {
      const baked = minPrice(products, ['Baked Sushi']);
      const maki = minPrice(products, ['Oishii Maki Rolls']);
      const boat = minPrice(products, ['Maki & Gyoza Platters (Bundle)']);
      return [
        ['Where can I get sushi in Santa Cruz, Laguna?', 'At Oishii Nori, Pedro Guevara Ave, Santa Cruz, Laguna 4009. Dine in, take out, or order online for delivery within Santa Cruz.'],
        ['What is sushi bake?', 'Also called baked sushi: sushi rice and toppings such as kani, salmon teriyaki, spicy tuna or scallop, layered in a tray and baked. You scoop it onto nori to eat. Our trays come in Small (2–3 pax), Medium (4–5 pax) and Large (5–6 pax).'],
        ['Magkano ang sushi sa Oishii Nori?', [
          maki !== null && `Maki rolls start at ${peso(maki)}`,
          baked !== null && `sushi bake trays at ${peso(baked)}`,
          boat !== null && `sushi boats at ${peso(boat)}`,
        ].filter(Boolean).join(', ') + '. See the full list with sizes above.'],
        ['Pwede bang pa-deliver ang sushi?', DELIVERY_ANSWER],
      ];
    },
  },
  '/ramen': {
    route: '/ramen',
    label: 'OISHII NORI / RAMEN',
    display: ['RAMEN IN', 'LAGUNA.'],
    keyword: 'Ramen bowls in Santa Cruz, Laguna',
    japanese: 'ラーメン',
    intro: 'Craving ramen in Laguna? At Oishii Nori in Santa Cruz, pick a regular bowl like chasu, beef, tonkatsu or torikatsu ramen, go premium with Angus, seafood or our own Oishii Nori Ramen, or bring the heat with spicy miso, tantanmen or black garlic. Prices below come straight from our live menu.',
    sections: [
      { heading: 'Regular ramen', categories: ['Ramen (Regular)'] },
      { heading: 'Premium ramen', categories: ['Ramen (Premium)'] },
      { heading: 'Specialty bowls', categories: ['Ramen'] },
    ],
    exclude: ['Take out box'],
    photo: { src: '/products/chasu-ramen.jpg', alt: 'Chasu ramen with golden broth, pork, egg and scallions at Oishii Nori, Santa Cruz, Laguna' },
    faq: products => {
      const bowls = products.filter(product => ['Ramen', 'Ramen (Regular)', 'Ramen (Premium)'].includes(product.category) && product.name !== 'Take out box').flatMap(productPrices);
      return [
        ['Saan may ramen sa Santa Cruz, Laguna?', 'Dito sa Oishii Nori, Pedro Guevara Ave, Santa Cruz, Laguna. Dine in, take out, or order online.'],
        ['How much is a bowl of ramen?', bowls.length ? `Bowls start at ${peso(Math.min(...bowls))}, and premium bowls are ${peso(Math.max(...bowls))}.` : 'See the live prices above.'],
        ['Is there spicy ramen?', 'Yes: Spicy Miso and Tantanmen are our spicy bowls. Black Garlic is rich and savory without the heat.'],
        ['Pwede bang pa-deliver ang ramen?', DELIVERY_ANSWER],
      ];
    },
  },
};
