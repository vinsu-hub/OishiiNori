import type { ApiProduct } from '@/lib/api';

// Vite's file inventory resolves only photos that actually exist, including during SSR.
const photoFiles = Object.keys(import.meta.glob('/public/products/*.{jpg,webp}')).map(path => path.replace('/public', ''));
const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
export function productPhoto(product: ApiProduct) {
  const imageName = product.image_path?.split('/').pop()?.split('?')[0];
  return photoFiles.find(path => path.split('/').pop() === imageName) ?? photoFiles.find(path => path.replace(/\.(jpg|webp)$/, '') === `/products/${slug(product.name)}`);
}
// "Add on" / "Add ons" products (sauce cups, extra chasu) aren't dishes to browse.
export const isAddonCategory = (category: string) => /^add[\s-]?ons?$/i.test(category.trim());
export const isBrowsable = (product: ApiProduct) => product.active && !isAddonCategory(product.category);
export function productPrices(product: ApiProduct) {
  return product.sizes.map(size => size.price).filter(price => typeof price === 'number' && Number.isFinite(price) && price >= 0);
}
export const peso = (value: number) => `₱${value.toLocaleString('en-PH', { maximumFractionDigits: 2 })}`;
export function priceLabel(product: ApiProduct) {
  const prices = productPrices(product);
  return prices.length ? `${product.sizes.length > 1 ? 'from ' : ''}${peso(Math.min(...prices))}` : null;
}
