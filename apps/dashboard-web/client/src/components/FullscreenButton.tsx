import { useEffect, useState } from 'react';
import { Maximize2, Minimize2 } from 'lucide-react';

/** Floating full-screen toggle for the tablet screens (POS, Kitchen Display):
 * hides the browser's address and tab bars so the whole tablet shows the
 * app. Not rendered where the browser has no Fullscreen API (iPhone Safari). */
export function FullscreenButton({
  corner,
  anchored = false,
}: {
  corner: 'bottom-right' | 'bottom-left';
  /** Position inside the nearest positioned parent instead of the viewport
   * (POS: stays clear of the sidebar whether it's expanded or collapsed). */
  anchored?: boolean;
}) {
  const supported = typeof document !== 'undefined' && !!document.documentElement.requestFullscreen;
  const [isFull, setIsFull] = useState(() => typeof document !== 'undefined' && !!document.fullscreenElement);

  useEffect(() => {
    const onChange = () => setIsFull(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  if (!supported) return null;

  const toggle = () => {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      document.documentElement.requestFullscreen().catch(() => {});
    }
  };

  const label = isFull ? 'Exit full screen' : 'Full screen';
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={label}
      title={label}
      className={`${anchored ? 'absolute' : 'fixed'} bottom-4 z-40 flex h-14 items-center gap-2 rounded-full border bg-card px-4 text-sm font-semibold shadow-lg transition hover:bg-muted active:scale-95 ${
        corner === 'bottom-right' ? 'right-4' : 'left-4'
      }`}
    >
      {isFull ? <Minimize2 className="h-5 w-5" aria-hidden="true" /> : <Maximize2 className="h-5 w-5" aria-hidden="true" />}
      <span>{label}</span>
    </button>
  );
}
