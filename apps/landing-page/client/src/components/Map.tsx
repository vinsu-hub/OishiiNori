import { useState } from 'react';
// The original template loaded Google Maps JS through Manus's own "Forge"
// API proxy (a platform-specific key + proxy host) -- that infrastructure
// doesn't exist outside Manus, so this is a plain embedded iframe instead.
// No API key required, works anywhere; the "Open in Maps" link elsewhere on
// the page still covers turn-by-turn directions.
interface MapViewProps {
  className?: string;
  lat: number;
  lng: number;
  zoom?: number;
}

export function MapView({ className, lat, lng, zoom = 17 }: MapViewProps) {
  const [interactive, setInteractive] = useState(false);
  const src = `https://www.google.com/maps?q=${lat},${lng}&z=${zoom}&output=embed`;
  return (
    <div className="on-map-wrap"><iframe
      className={className}
      src={src}
      title="Oishii Nori location"
      loading="lazy"
      referrerPolicy="no-referrer-when-downgrade"
      tabIndex={interactive ? 0 : -1}
      style={{ border: 0, pointerEvents: interactive ? 'auto' : 'none' }}
    />{!interactive ? <button className="on-map-activate" type="button" onClick={() => setInteractive(true)}>Tap to interact with map</button> : <button className="on-map-release" type="button" onClick={() => setInteractive(false)}>Return to page scrolling</button>}</div>
  );
}
