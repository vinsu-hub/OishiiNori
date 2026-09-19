import React, { useEffect, useState } from 'react';

// Full-screen "Now Serving" board for the restaurant TV (open /tv, press F11).
// Read-only and unauthenticated -- the backend feed carries order numbers only.
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL as string;
const POLL_MS = 5000;

interface QueueDisplay {
  preparing: number[];
  ready: number[];
}

function Column({ title, numbers, accent }: { title: string; numbers: number[]; accent: string }) {
  return (
    <section style={{ flex: 1, padding: '2vw', borderRight: '1px solid #2a2a2a', minWidth: 0 }}>
      <h2 style={{ fontSize: '3.2vw', margin: 0, color: accent, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
        {title}
      </h2>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1.6vw', marginTop: '2vw' }}>
        {numbers.map((n) => (
          <span
            key={n}
            style={{
              fontSize: '7vw',
              fontWeight: 700,
              lineHeight: 1,
              padding: '1vw 2vw',
              border: `0.3vw solid ${accent}`,
              borderRadius: '1.2vw',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {n}
          </span>
        ))}
        {numbers.length === 0 && <span style={{ fontSize: '2.4vw', color: '#777' }}>--</span>}
      </div>
    </section>
  );
}

export default function TvDisplay() {
  const [data, setData] = useState<QueueDisplay>({ preparing: [], ready: [] });
  const [online, setOnline] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch(`${API_BASE_URL}/public/queue-display`);
        if (!res.ok) throw new Error(String(res.status));
        const json = (await res.json()) as QueueDisplay;
        if (!cancelled) {
          setData(json);
          setOnline(true);
        }
      } catch {
        // Keep showing the last good board rather than blanking the TV on a network blip.
        if (!cancelled) setOnline(false);
      }
    }
    load();
    const id = window.setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  return (
    <main
      style={{
        position: 'fixed',
        inset: 0,
        background: '#0f0f0f',
        color: '#fff',
        fontFamily: "'DM Sans', system-ui, sans-serif",
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <header style={{ padding: '1.5vw 2vw', borderBottom: '1px solid #2a2a2a', display: 'flex', justifyContent: 'space-between' }}>
        <strong style={{ fontSize: '2.6vw' }}>Oishii Nori</strong>
        <span style={{ fontSize: '1.6vw', color: online ? '#5ec27a' : '#e0a030' }}>
          {online ? 'Live' : 'Reconnecting...'}
        </span>
      </header>
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <Column title="Now Preparing" numbers={data.preparing} accent="#e0a030" />
        <Column title="Now Serving" numbers={data.ready} accent="#5ec27a" />
      </div>
    </main>
  );
}
