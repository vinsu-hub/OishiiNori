import { useState } from 'react';
export default function FoodPhoto({ src, alt, eager = false }: { src?: string; alt: string; eager?: boolean }) {
  const [failed, setFailed] = useState(false);
  return <div className={`on-photo ${!src || failed ? 'on-photo-fallback' : ''}`}>{src && !failed ? <img src={src} alt={alt} decoding="async" width={800} height={800} loading={eager ? 'eager' : 'lazy'} fetchPriority={eager ? 'high' : 'auto'} onError={() => setFailed(true)} /> : <span>{alt}<small>OISHII NORI</small></span>}</div>;
}
