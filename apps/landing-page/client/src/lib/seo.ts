import { useEffect } from 'react';

// One source for every indexed route's title + description. scripts/prerender.mjs
// loads this same module (vite.ssrLoadModule) to write each route's static
// <head> and sitemap.xml, and each page calls usePageMeta() so the title a
// JS-rendering crawler sees after hydration matches the prerendered one.
// Main keyword per route comes from apps/landing-page/SEO_KEYWORDS.md.
export const SITE_URL = 'https://www.oishiinori.com';

export interface PageMeta { title: string; description: string }

export const PAGE_META = {
  '/': {
    title: 'Oishii Nori | Japanese Restaurant & Sushi in Santa Cruz, Laguna',
    description: 'Japanese restaurant and sushi shop in Santa Cruz, Laguna, Philippines: sushi bake, maki, ramen and takoyaki from a Filipino-owned kitchen on Pedro Guevara Ave. Order online, get delivery, or reserve a table.',
  },
  '/sushi': {
    title: 'Sushi in Laguna: Sushi Bake, Maki & Sushi Boats | Oishii Nori',
    description: 'Looking for sushi in Laguna? Oishii Nori in Santa Cruz serves sushi bake trays, maki rolls, torched maki and sushi boats, with live prices in pesos. Order online for pickup or delivery.',
  },
  '/ramen': {
    title: 'Ramen in Laguna | Oishii Nori Ramen Bowls',
    description: 'Ramen in Santa Cruz, Laguna: chasu, tonkatsu, black garlic, spicy miso, tantanmen and seafood ramen bowls at Oishii Nori. See live prices and order online.',
  },
  '/delivery': {
    title: 'Sushi Delivery in Santa Cruz, Laguna | Oishii Nori',
    description: 'Pa-deliver sushi, ramen and takoyaki anywhere in Santa Cruz, Laguna. See every barangay we deliver to and its delivery fee, then order online.',
  },
  '/our-menu': {
    title: 'Menu & Prices | Oishii Nori, Santa Cruz, Laguna',
    description: 'The full Oishii Nori menu with live prices: sushi, maki, ramen, takoyaki, bento, donburi and drip tea in Santa Cruz, Laguna. Find your next craving and order online.',
  },
  '/catering': {
    title: 'Sushi Catering & Sushi Boats in Laguna | Oishii Nori',
    description: 'Sushi catering in Santa Cruz, Laguna: sushi boats, maki platters and party food trays for birthdays, binyag, office meetings and family handaan. Send us your occasion.',
  },
  '/about': {
    title: 'About Oishii Nori | Our Story, a Filipino-Owned Japanese Kitchen',
    description: 'Meet Oishii Nori, a Filipino-owned Japanese restaurant in Santa Cruz, Laguna serving fresh sushi and ramen with a Filipino twist, fair prices and a warm welcome.',
  },
  '/events': {
    title: 'Kids Sushi Making Class in Santa Cruz, Laguna | Oishii Nori',
    description: 'Little hands, big rolls: photos from Oishii Nori’s Sushi Making Class for Kids in Santa Cruz, Laguna. Book a sushi class for your school, party or team.',
  },
} satisfies Record<string, PageMeta>;

export type IndexedRoute = keyof typeof PAGE_META;

export function usePageMeta(route: IndexedRoute) {
  useEffect(() => {
    const { title, description } = PAGE_META[route];
    document.title = title;
    document.querySelector('meta[name="description"]')?.setAttribute('content', description);
  }, [route]);
}
