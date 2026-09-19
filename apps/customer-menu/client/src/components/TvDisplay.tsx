import React, { useEffect, useRef, useState } from 'react';

// Read-only counter ticket board. Open /tv?demo=1 for an entirely local preview.
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL as string;
const POLL_MS = 5000;

interface QueueDisplay {
  preparing: number[];
  ready: number[];
}

function demoQueue(step: number): QueueDisplay {
  const first = 128 + (step % 40);
  return {
    preparing: Array.from({ length: 8 }, (_, index) => first + index + 3),
    ready: [first, first + 1, first + 2],
  };
}

function Column({ numbers, serving = false, highlighted, loading, online }: {
  numbers: number[];
  serving?: boolean;
  highlighted: Set<number>;
  loading: boolean;
  online: boolean;
}) {
  const columns = numbers.length > 12 ? 4 : numbers.length > 1 ? 3 : 1;
  const rows = Math.max(3, Math.ceil(numbers.length / columns));
  return (
    <section className={`tv-column ${serving ? 'tv-serving' : 'tv-preparing'}`}
      aria-labelledby={serving ? 'tv-serving-title' : 'tv-preparing-title'}
      style={{ '--tv-grid-columns': columns, '--tv-grid-rows': rows } as React.CSSProperties}>
      <div className="tv-column-heading">
        <span className="tv-japanese" lang="ja">{serving ? 'お待たせしました' : '調理中'}</span>
        <h2 id={serving ? 'tv-serving-title' : 'tv-preparing-title'}>{serving ? 'Now Serving' : 'Now Preparing'}</h2>
        <p>{serving ? 'Please collect at the counter when your ticket number appears.' : 'Good food is on its way. Thank you for waiting.'}</p>
      </div>
      {numbers.length ? (
        <div className="tv-number-grid" role="list" aria-label={serving ? 'Ready ticket numbers' : 'Preparing ticket numbers'}>
          {numbers.map(number => (
            <div key={number} role="listitem" className={`tv-order-number ${highlighted.has(number) ? 'is-newly-ready' : ''}`}>
              <span style={{ '--tv-digit-scale': Math.min(1, 3.5 / String(number).length) } as React.CSSProperties}>{number}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="tv-column-empty" role="status">
          <span className="tv-empty-mark" aria-hidden="true">{serving ? '◎' : '◌'}</span>
          <strong>{loading ? 'One moment…' : !online ? 'Connecting to the counter…' : serving ? 'Something delicious is coming.' : 'Ready for your next craving.'}</strong>
          <p>{loading ? 'We’re checking your ticket numbers.' : !online ? 'Please ask our team about your ticket number.' : serving ? 'Your ticket number will appear here when it’s ready.' : 'Your ticket number will appear here once ordered.'}</p>
        </div>
      )}
      <div className="tv-column-foot"><span>{serving ? 'Ready to enjoy' : 'Made with care'}</span><span lang="ja">番号</span></div>
    </section>
  );
}

export default function TvDisplay() {
  const [demo] = useState(() => new URLSearchParams(window.location.search).get('demo') === '1');
  const [data, setData] = useState<QueueDisplay>(() => demo ? demoQueue(0) : { preparing: [], ready: [] });
  const [online, setOnline] = useState(true);
  const [loading, setLoading] = useState(!demo);
  const [now, setNow] = useState(() => new Date());
  const [newlyReady, setNewlyReady] = useState<Set<number>>(new Set());
  const previousReady = useRef<Set<number> | null>(null);

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const accept = (json: QueueDisplay) => {
      if (cancelled) return;
      setNewlyReady(new Set(json.ready.filter(number => previousReady.current !== null && !previousReady.current.has(number))));
      previousReady.current = new Set(json.ready);
      setData(json);
      setOnline(true);
      setLoading(false);
    };
    // Return before constructing the live poll: preview must never call the API.
    if (demo) {
      let step = 0;
      accept(demoQueue(step));
      const id = window.setInterval(() => accept(demoQueue(++step)), POLL_MS * 2);
      return () => { cancelled = true; window.clearInterval(id); };
    }
    async function load() {
      try {
        const res = await fetch(`${API_BASE_URL}/public/queue-display`);
        if (!res.ok) throw new Error(String(res.status));
        accept((await res.json()) as QueueDisplay);
      } catch {
        // Retain the last good board during network interruptions.
        if (!cancelled) { setOnline(false); setLoading(false); }
      }
    }
    void load();
    const id = window.setInterval(load, POLL_MS);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [demo]);

  useEffect(() => {
    if (!newlyReady.size) return;
    const id = window.setTimeout(() => setNewlyReady(new Set()), 4500);
    return () => window.clearTimeout(id);
  }, [newlyReady]);

  return (
    <main className="tv-display">
      <div className="tv-content">
        <header className="tv-header">
          <div className="tv-brand"><img src="/logo.jpg" alt="" /><div><strong>Oishii Nori</strong><span>A little Japan, close to home.</span></div></div>
          <div className="tv-header-meta">
            <span className={`tv-connection ${online ? 'is-online' : ''}`} role="status">
              <i aria-hidden="true" />{demo ? 'Demo · Sample tickets' : loading ? 'Connecting' : online ? 'Live from our kitchen' : 'Reconnecting · Last update shown'}
            </span>
            <time dateTime={now.toISOString()}>{now.toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit' })}</time>
          </div>
        </header>
        <div className="tv-columns">
          <Column numbers={data.preparing} highlighted={new Set()} loading={loading} online={online} />
          <Column serving numbers={data.ready} highlighted={newlyReady} loading={loading} online={online} />
        </div>
        <footer className="tv-footer"><span>Keep an eye on <strong>your ticket number.</strong></span><span>{demo ? 'Preview only · No live orders' : 'Freshly made. Happily served.'}</span></footer>
      </div>
    </main>
  );
}
