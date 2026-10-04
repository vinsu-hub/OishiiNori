/** The real dining room's walls, counter, kitchen and entrance, drawn behind
 * the "Dining Room" zone's tables on the floor plan. Traced from the
 * client's floor plan mockup (Main.dc.html, 2026-10-04) with every
 * coordinate offset by (-60, -140) -- the same offset
 * services/api-fastapi/scripts/seed_floor_plan_v2.py uses for the tables,
 * so the tables land in the right spots on this drawing. Display only:
 * pointer-events are off so tables stay clickable/draggable on top. */

import type { CSSProperties } from 'react';

export const DINING_ROOM_ZONE = 'Dining Room';
export const DINING_ROOM_SIZE = { w: 840, h: 1480 };

type Box = [x: number, y: number, w: number, h: number];

const FLOORS: { box: Box; className: string }[] = [
  { box: [30, 282, 612, 1020], className: 'bg-amber-100/60 dark:bg-amber-950/30' }, // dining
  { box: [632, 142, 183, 478], className: 'bg-amber-100/60 dark:bg-amber-950/30' }, // side annex
  { box: [12, 52, 430, 230], className: 'bg-stone-200/70 dark:bg-stone-800/50' }, // kitchen
  { box: [595, 14, 208, 77], className: 'bg-sky-100/70 dark:bg-sky-950/40' }, // CR
];

const WALLS: Box[] = [
  [12, 279, 430, 6],
  [439, 52, 6, 233],
  [592, 14, 6, 80],
  [592, 88, 214, 6],
  [812, 142, 6, 481],
  [637, 617, 178, 6],
  [27, 609, 6, 696],
  [639, 620, 6, 685],
  [27, 1299, 88, 6],
  [242, 1299, 68, 6],
];

const BENCHES: Box[] = [
  [637, 142, 158, 34],
  [646, 342, 157, 34],
  [646, 388, 157, 34],
  [650, 558, 158, 34],
];

const LABELS: { at: [number, number]; text: string; className: string }[] = [
  { at: [36, 74], text: 'KITCHEN', className: 'text-lg font-extrabold tracking-[0.14em] text-muted-foreground' },
  { at: [684, 38], text: 'CR', className: 'text-xl font-extrabold tracking-[0.1em] text-muted-foreground' },
  { at: [40, 330], text: 'SERVICE AREA', className: 'text-[11px] font-bold tracking-[0.1em] text-muted-foreground/80' },
  { at: [130, 1442], text: 'ENTRANCE', className: 'text-xs font-extrabold tracking-[0.12em] text-foreground' },
  { at: [410, 1314], text: 'GLASS STOREFRONT', className: 'text-[11px] font-bold tracking-[0.1em] text-sky-700 dark:text-sky-400' },
];

function pos([x, y, w, h]: Box): CSSProperties {
  return { left: x, top: y, width: w, height: h };
}

export function DiningRoomBackdrop() {
  return (
    <div className="pointer-events-none absolute inset-0 select-none" aria-hidden="true">
      {FLOORS.map((f, i) => (
        <div key={`floor-${i}`} className={`absolute ${f.className}`} style={pos(f.box)} />
      ))}

      {/* Kitchen's open (dashed) top and left edges */}
      <div className="absolute border-t-2 border-dashed border-muted-foreground/50" style={{ left: 12, top: 52, width: 430 }} />
      <div className="absolute border-l-2 border-dashed border-muted-foreground/50" style={{ left: 12, top: 52, height: 230 }} />

      {WALLS.map((b, i) => (
        <div key={`wall-${i}`} className="absolute bg-foreground/85" style={pos(b)} />
      ))}
      <div className="absolute border border-sky-600 bg-sky-200 dark:bg-sky-800" style={pos([310, 1299, 336, 6])} />

      {/* Entrance door: swing arc + door leaf */}
      <div
        className="absolute border-b border-l border-dashed border-muted-foreground"
        style={{ ...pos([115, 1302, 127, 127]), borderBottomLeftRadius: 127 }}
      />
      <div className="absolute bg-foreground/85" style={pos([240, 1302, 3, 127])} />

      {/* Counter and fixtures */}
      <div
        className="absolute flex items-center justify-center rounded-sm border-2 border-amber-900 bg-amber-700/80 text-sm font-extrabold tracking-[0.14em] text-white"
        style={pos([25, 397, 379, 85])}
      >
        COUNTER
      </div>
      <div
        className="absolute border-2 border-stone-500"
        style={{
          ...pos([38, 507, 43, 128]),
          background: 'repeating-linear-gradient(45deg, rgb(140 134 123 / 0.7) 0 2px, transparent 2px 7px)',
        }}
      />
      <div className="absolute border-2 border-stone-500 bg-stone-300/60 dark:bg-stone-700/60" style={pos([33, 665, 22, 59])} />
      <div className="absolute rounded border-2 border-green-700 bg-green-200/70 dark:bg-green-900/50" style={pos([33, 1187, 34, 48])} />
      <div className="absolute rounded border-2 border-green-700 bg-green-200/70 dark:bg-green-900/50" style={pos([33, 1241, 34, 44])} />

      {BENCHES.map((b, i) => (
        <div
          key={`bench-${i}`}
          className="absolute flex items-center justify-center rounded border-2 border-amber-800/70 bg-amber-300/50 text-[10px] font-bold tracking-[0.08em] text-amber-900 dark:bg-amber-800/40 dark:text-amber-200"
          style={pos(b)}
        >
          BENCH
        </div>
      ))}

      {LABELS.map((l) => (
        <div key={l.text} className={`absolute whitespace-nowrap ${l.className}`} style={{ left: l.at[0], top: l.at[1] }}>
          {l.text}
        </div>
      ))}
    </div>
  );
}
