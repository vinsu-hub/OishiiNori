import { useEffect, useState } from 'react';
import { ApiProduct, fetchProducts } from '@/lib/api';

/**
 * Table Orders / Delivery Requests / Online Orders (all three render via
 * DigitalOrdersQueue) and the rider's Delivery panel each independently
 * called fetchProducts() on mount just to resolve a line item's
 * product_size_id -> name/size_label -- tab-hopping between them refetched
 * the same 60-product catalog three times in a row. The catalog only
 * changes via an executive/manager action (Menu Editing), so a single
 * lazily-fetched, module-level cache shared by all of them is enough.
 *
 * Deliberately NOT a React Context mounted at the App root (the pattern
 * InventoryAlertsContext uses) -- that would fetch the full catalog for
 * every session regardless of role, including roles like stocker that
 * never reach a digital-order page at all. This only fetches the first
 * time any of these pages actually mounts.
 */
let cachedProducts: ApiProduct[] | null = null;
let inFlight: Promise<ApiProduct[]> | null = null;

function loadProductCatalog(): Promise<ApiProduct[]> {
  if (cachedProducts) return Promise.resolve(cachedProducts);
  if (!inFlight) {
    inFlight = fetchProducts(true)
      .then((products) => {
        cachedProducts = products;
        return products;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

export function useProductCatalog(): { products: ApiProduct[]; loading: boolean; error: string | null } {
  const [products, setProducts] = useState<ApiProduct[]>(cachedProducts ?? []);
  const [loading, setLoading] = useState(cachedProducts === null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (cachedProducts) {
      setProducts(cachedProducts);
      setLoading(false);
      return;
    }
    let cancelled = false;
    loadProductCatalog()
      .then((p) => {
        if (!cancelled) setProducts(p);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load products');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { products, loading, error };
}
