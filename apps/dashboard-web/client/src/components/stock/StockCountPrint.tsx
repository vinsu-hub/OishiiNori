import { fmtQty } from '@/lib/units';

export interface PrintRow {
  key: string;
  name: string;
  stationLabel: string;
  section: string;
  systemEnding: number;
  unit: string;
  threshold: number | null;
  kind: 'ingredient' | 'stock_item';
  countedToday: boolean;
  /** Count boxes: its sizes (pack, box...) then the base unit. */
  units: string[];
  /** Prep base printed under its ingredient as "Base". */
  nested?: boolean;
}

/** The paper EOD count sheet: per station, one table per category (sheet
 * section), with empty boxes to write the count in. Hidden on screen; shown
 * only when printing (window.print), like the Shift Reports cash report. */
export function StockCountPrint({ rows, title, date }: { rows: PrintRow[]; title: string; date: string }) {
  const stations = new Map<string, Map<string, PrintRow[]>>();
  for (const row of rows) {
    if (!stations.has(row.stationLabel)) stations.set(row.stationLabel, new Map());
    const sections = stations.get(row.stationLabel)!;
    if (!sections.has(row.section)) sections.set(row.section, []);
    sections.get(row.section)!.push(row);
  }

  return (
    <div className="stock-count-print hidden print:block">
      <style>{`
        @page { size: A4 portrait; margin: 12mm; }
        @media print {
          body * { visibility: hidden !important; }
          .stock-count-print, .stock-count-print * { visibility: visible !important; }
          .stock-count-print { position: absolute; left: 0; top: 0; width: 100%; color: #000; background: #fff; }
          .stock-count-print table { width: 100%; border-collapse: collapse; font-size: 10.5pt; }
          .stock-count-print th, .stock-count-print td { border: 1px solid #000; padding: 3px 5px; text-align: left; }
          .stock-count-print th { background: #eee !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; font-size: 9pt; }
          .stock-count-print .pc-section { break-inside: avoid; page-break-inside: avoid; margin-bottom: 10px; }
          .stock-count-print .pc-station { break-before: page; }
          .stock-count-print .pc-station:first-of-type { break-before: auto; }
        }
      `}</style>
      <header className="mb-3 border-b border-black pb-2">
        <h1 className="text-lg font-bold">EOD Stock Count · {title}</h1>
        <p className="text-sm">
          Date: {date} &nbsp;&nbsp; Counted by: ______________________ &nbsp;&nbsp; Checked by: ______________________
        </p>
      </header>
      {Array.from(stations, ([station, sections]) => (
        <section key={station} className="pc-station">
          <h2 className="mb-1 mt-2 text-base font-bold uppercase">{station}</h2>
          {Array.from(sections, ([section, items]) => (
            <div key={section} className="pc-section">
              <h3 className="mb-1 text-sm font-bold">{section} · {items.length}</h3>
              <table>
                <thead>
                  <tr>
                    <th style={{ width: '30%' }}>Item</th>
                    <th style={{ width: '14%' }}>System</th>
                    <th style={{ width: '22%' }}>Counted</th>
                    <th style={{ width: '9%' }}>Unit</th>
                    <th style={{ width: '9%' }}>Low at</th>
                    <th>Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((r) => (
                    <tr key={r.key}>
                      <td style={r.nested ? { paddingLeft: 18 } : undefined}>
                        {r.nested ? '↳ Base: ' : ''}
                        {r.name}
                        {r.kind === 'stock_item' ? ' (station item)' : ''}
                        {r.countedToday ? ' ✓' : ''}
                      </td>
                      <td>{fmtQty(r.systemEnding)} {r.unit}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {r.units.length > 1 ? r.units.map((u) => `____ ${u}`).join('  ') : ''}
                      </td>
                      <td>{r.unit}</td>
                      <td>{r.threshold ? fmtQty(r.threshold) : ''}</td>
                      <td />
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </section>
      ))}
      <p className="mt-2 text-xs">✓ = already counted today in the system. {rows.length} items.</p>
    </div>
  );
}
