import React, { useEffect, useRef, useState } from 'react';

// Full-screen "Now Serving" board for the restaurant TV (open /tv, press F11).
// Read-only and unauthenticated -- the backend feed carries order numbers only.
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL as string;
const POLL_MS = 5000;

interface QueueDisplay {
  preparing: number[];
  ready: number[];
}

function Column({
  title,
  numbers,
  accent,
  emptyText,
  highlighted = new Set<number>(),
}: {
  title: string;
  numbers: number[];
  accent: string;
  emptyText: string;
  highlighted?: Set<number>;
}) {
  return (
    <section className="tv-column" style={{ '--tv-accent': accent } as React.CSSProperties}>
      <h2 className="tv-column-title">
        {title}
      </h2>
      <div className="tv-number-grid">
        {numbers.map((n) => (
          <span
            key={n}
            className={`tv-order-number ${highlighted.has(n) ? 'is-newly-ready' : ''}`}
          >
            {n}
          </span>
        ))}
        {numbers.length === 0 && <p className="tv-column-empty">{emptyText}</p>}
      </div>
    </section>
  );
}

export default function TvDisplay() {
  const [data, setData] = useState<QueueDisplay>({ preparing: [], ready: [] });
  const [online, setOnline] = useState(true);
  const [loading, setLoading] = useState(true);
  const [newlyReady, setNewlyReady] = useState<Set<number>>(new Set());
  const previousReady = useRef<Set<number> | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch(`${API_BASE_URL}/public/queue-display`);
        if (!res.ok) throw new Error(String(res.status));
        const json = (await res.json()) as QueueDisplay;
        if (!cancelled) {
          if (previousReady.current) {
            setNewlyReady(new Set(json.ready.filter((number) => !previousReady.current?.has(number))));
          }
          previousReady.current = new Set(json.ready);
          setData(json);
          setOnline(true);
          setLoading(false);
        }
      } catch {
        // Keep showing the last good board rather than blanking the TV on a network blip.
        if (!cancelled) {
          setOnline(false);
          setLoading(false);
        }
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
    <main className="tv-display">
      <header className="tv-header">
        <strong>Oishii Nori</strong>
        <span className={`tv-connection ${online ? 'is-online' : ''}`} role="status">
          {online ? 'Live' : 'Reconnecting...'}
        </span>
      </header>
      {loading ? (
        <div className="tv-board-message" role="status">Loading order board...</div>
      ) : data.preparing.length === 0 && data.ready.length === 0 ? (
        <div className="tv-board-message">No orders right now</div>
      ) : (
        <div className="tv-columns">
          <Column title="Now Preparing" numbers={data.preparing} accent="#f0b84a" emptyText="No orders preparing" />
          <Column
            title="Now Serving"
            numbers={data.ready}
            accent="#6cdb8a"
            emptyText="No orders ready"
            highlighted={newlyReady}
          />
        </div>
      )}
    </main>
  );
}
