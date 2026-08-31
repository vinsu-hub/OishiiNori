import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

/**
 * `React.lazy` that survives a deploy landing mid-session.
 *
 * When Vercel ships a new build, the old page chunks (`/assets/POSTerminal-<hash>.js`)
 * are gone. A tab still running the previous build asks for that old URL the
 * moment it navigates to a not-yet-loaded route; Vercel's SPA fallback answers
 * with `index.html` (200, `text/html`), so the dynamic `import()` rejects with
 * "Failed to fetch dynamically imported module" and the top-level ErrorBoundary
 * takes over with "An unexpected error occurred."
 *
 * The fix: on that specific failure, force one full reload so the browser picks
 * up the current `index.html` and its fresh chunk hashes. A sessionStorage guard
 * keyed per module makes it a one-shot -- if the reload didn't help (genuinely
 * offline, chunk really missing), the error is rethrown and the ErrorBoundary
 * shows as before instead of a reload loop.
 */
export function lazyWithReload<T extends ComponentType<unknown>>(
  factory: () => Promise<{ default: T }>,
  key: string,
): LazyExoticComponent<T> {
  return lazy(async () => {
    const flag = `chunk-reload:${key}`;
    try {
      const mod = await factory();
      sessionStorage.removeItem(flag);
      return mod;
    } catch (err) {
      const isChunkError =
        err instanceof Error &&
        /dynamically imported module|Importing a module script failed|Failed to fetch/i.test(err.message);
      if (isChunkError && sessionStorage.getItem(flag) !== '1') {
        sessionStorage.setItem(flag, '1');
        window.location.reload();
        // Never resolves -- the reload replaces the page.
        return new Promise<{ default: T }>(() => {});
      }
      throw err;
    }
  });
}
