# Keyword map: www.oishiinori.com

One main keyword per URL. Titles and descriptions live in `client/src/lib/seo.ts`. The prerender and the pages both read them from there, so change them there only.

Research: 2026-10-16. SERP-overlap clustering was done with web search. US-located results limited it, so it gave no volume data and no shared-URL counts. Re-check against Search Console queries (see "Tracking") after 4–6 weeks.

| URL | Main keyword | Supporting keywords | Intent |
|---|---|---|---|
| `/` | Japanese restaurant Santa Cruz Laguna | sushi Santa Cruz Laguna, sushi shop Santa Cruz Laguna, Japanese food Laguna, Oishii Nori | Local pack, brand |
| `/sushi` | sushi in Laguna | sushi bake Laguna, sushi bake Santa Cruz, baked sushi Laguna, maki rolls Laguna, torched maki, masarap na sushi sa Laguna, murang sushi Santa Cruz | Local pack, listicle |
| `/ramen` | ramen in Laguna | ramen Santa Cruz Laguna, ramen near me, saan may ramen sa Laguna, spicy ramen, Oishii Nori Ramen | Local pack, listicle |
| `/delivery` | sushi delivery Santa Cruz Laguna | Japanese food delivery Laguna, ramen delivery Santa Cruz, baked sushi delivery, [barangay] + food delivery | Transactional |
| `/catering` | sushi catering Laguna | sushi boat Laguna, sushi party tray Laguna, Japanese food catering Santa Cruz, baked sushi party tray | Commercial |
| `/our-menu` | Oishii Nori menu | takoyaki Santa Cruz Laguna, bento, donburi, Japanese curry, drip tea | Brand, navigational |
| `/events` | kids sushi making class Laguna | sushi class Santa Cruz | Niche |

## Philippine search wording

Write the way people in the Philippines search, not US English:
- **"sushi bake"**, not only "baked sushi". It's the PH name for the dish, and it leads the /sushi title, H1 and FAQ.
- **pax** for serving sizes, **barkada**, **handaan**, **binyag**, and **party food trays** for catering.
- **Taglish questions** in the FAQs: "Magkano…?", "Saan may…?", "Pwede bang pa-deliver…?". People ask Google and AI assistants this way.
- Prices always in **₱ / PHP**.
- **Location tags:** `lang="en-PH"`, `og:locale=en_PH` and `geo.region=PH-LAG` meta tags in `client/index.html`. The Restaurant schema already has `addressCountry: PH`. The `.com` domain is fine; Google takes country from content, address, Business Profile and links.

## Rules

- **Don't cannibalize.** `/` sells the place (restaurant, address, hours, reserve). `/sushi` sells the dishes. Don't retarget `/` to "sushi in Laguna".
- **No per-town pages.** They would be doorway pages. Nearby towns (Pagsanjan, Pila, Lumban, Victoria, Magdalena) appear only where the statement is true:
  - delivery covers Santa Cruz barangays only (`delivery_fees` table)
  - customers from those towns are pointed to pickup
- **No `/takoyaki` page for now.** No standalone demand showed up. Revisit if Search Console shows takoyaki impressions landing on `/our-menu`.
- **Product photo alt text = the dish name.** Don't add "Santa Cruz, Laguna" to every product image; with 160 products that reads as keyword stuffing.
- **Every price and area on the keyword pages is live data** (`/public/menu`, `/public/delivery-fees`). Don't hard-code prices in the copy.

## Competitors seen (for context)

- **Ramen:** Ipponyari, Ramen Kuroda and Santouka (Santa Rosa), Boss D Ramen (Siniloan), Ramen Muna (San Pablo).
- **Japanese food, province-wide:** Hana Japanese (Pagsanjan; may have closed) leads Wanderlog's "Japanese restaurants in Laguna" list. No Santa Cruz restaurant is on it, so getting Oishii Nori listed there is worth doing.

## Tracking

- Search Console → Performance → filter queries containing `sushi`, `ramen`, `takoyaki` or `laguna`. Record impressions, clicks and average position per page every 2 weeks.
- Business Profile → Performance → "Searches" for Maps queries.
- Plugin: `CLAUDE_SEO_PYTHON=/opt/homebrew/bin/python3.12` plus the `seo-google` skill (`gsc_query.py`), once Search Console credentials are set up.

## Blocked on the owner

- **Phone number and social/delivery-app profile URLs.** Fill in `SHOP_PHONE` / `SHOP_PROFILES` in `scripts/prerender.mjs`, matching the Business Profile exactly.
- **Nearby landmarks** for the location copy (e.g. "across from ___").
