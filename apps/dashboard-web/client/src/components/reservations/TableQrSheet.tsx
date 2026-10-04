import { useEffect, useMemo, useState } from 'react';
import QRCode from 'qrcode';
import { toast } from 'sonner';
import { Copy, ExternalLink, Loader2, Printer } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { fetchTables, type ApiTable } from '@/lib/api';
import { CUSTOMER_MENU_URL, tableOrderUrl } from '@/lib/constants';

interface TableQr {
  number: number;
  label: string;
  url: string;
  svg: string;
}

// Error-correction "M" survives a smudge or a sauce stain without making the
// code so dense it's hard to scan from across a table.
const QR_OPTIONS = { type: 'svg', margin: 1, errorCorrectionLevel: 'M' } as const;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const PRINT_CSS = `
  @page { size: A4; margin: 12mm; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: 'Helvetica Neue', Arial, sans-serif; color: #000; }
  .grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8mm; }
  .card { border: 1px dashed #999; border-radius: 4mm; padding: 6mm; text-align: center; break-inside: avoid; page-break-inside: avoid; height: 84mm; display: flex; flex-direction: column; align-items: center; justify-content: center; }
  .brand { font-size: 11pt; font-weight: 700; letter-spacing: 0.18em; }
  .table { font-size: 26pt; font-weight: 800; margin: 1mm 0 2mm; }
  .qr svg { width: 48mm; height: 48mm; display: block; }
  .cta { font-size: 11pt; font-weight: 600; margin-top: 2mm; }
  .url { font-size: 7pt; color: #555; margin-top: 1mm; word-break: break-all; }
`;

function cardHtml(q: TableQr): string {
  return `<div class="card">
    <div class="brand">OISHII NORI</div>
    <div class="table">TABLE ${q.number}</div>
    <div class="qr">${q.svg}</div>
    <div class="cta">Scan to order</div>
    <div class="url">${escapeHtml(q.url)}</div>
  </div>`;
}

/** Prints through a hidden iframe (same approach as the POS receipt), so the
 * sheet gets its own A4 layout without app-wide print CSS. */
function printSheet(qrs: TableQr[]): void {
  const iframe = document.createElement('iframe');
  iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
  document.body.appendChild(iframe);
  const doc = iframe.contentDocument;
  const win = iframe.contentWindow;
  if (!doc || !win) {
    iframe.remove();
    return;
  }
  doc.open();
  doc.write(
    `<!doctype html><html><head><title>Table QR codes</title><style>${PRINT_CSS}</style></head><body><div class="grid">${qrs
      .map(cardHtml)
      .join('')}</div></body></html>`
  );
  doc.close();
  win.onafterprint = () => iframe.remove();
  setTimeout(() => {
    win.focus();
    win.print();
    setTimeout(() => iframe.remove(), 60_000);
  }, 100);
}

/** One QR code per active table, linking to the customer menu with
 * ?table=<pos_table_number> -- the number POS, Kitchen Display and the floor
 * plan all use, so a QR order shows up on the right table everywhere. */
export function TableQrSheet() {
  const [tables, setTables] = useState<ApiTable[] | null>(null);
  const [qrs, setQrs] = useState<TableQr[]>([]);

  useEffect(() => {
    fetchTables()
      .then(setTables)
      .catch((e) => toast.error(e instanceof Error ? e.message : 'Failed to load tables'));
  }, []);

  const numbered = useMemo(
    () =>
      (tables ?? [])
        .filter((t): t is ApiTable & { pos_table_number: number } => t.active && t.pos_table_number != null)
        .sort((a, b) => a.pos_table_number - b.pos_table_number),
    [tables]
  );
  const unnumbered = (tables ?? []).filter((t) => t.active && t.pos_table_number == null);

  useEffect(() => {
    let cancelled = false;
    Promise.all(
      numbered.map(async (t) => {
        const url = tableOrderUrl(t.pos_table_number);
        return { number: t.pos_table_number, label: t.label, url, svg: await QRCode.toString(url, QR_OPTIONS) };
      })
    )
      .then((result) => !cancelled && setQrs(result))
      .catch((e) => toast.error(e instanceof Error ? e.message : 'Failed to generate QR codes'));
    return () => {
      cancelled = true;
    };
  }, [numbered]);

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      toast.success('Link copied');
    } catch {
      toast.error('Could not copy -- long-press the link to copy it instead.');
    }
  }

  if (tables === null) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading tables...
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted-foreground">
          Each code opens the menu at <code className="rounded bg-muted px-1">{CUSTOMER_MENU_URL}</code> with that
          table's number, so the order arrives already marked for that table. Print on A4 (6 per page) and cut along
          the dashed lines.
        </p>
        <Button onClick={() => printSheet(qrs)} disabled={qrs.length === 0}>
          <Printer className="h-4 w-4" aria-hidden="true" />
          Print all ({qrs.length})
        </Button>
      </div>

      {unnumbered.length > 0 && (
        <p className="text-sm text-amber-700">
          No QR code for {unnumbered.map((t) => t.label).join(', ')} -- give {unnumbered.length === 1 ? 'it' : 'them'} a
          POS table number in the Tables tab first.
        </p>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {qrs.map((q) => (
          <Card key={q.number}>
            <CardContent className="flex flex-col items-center gap-2 p-4 text-center">
              <p className="text-xs font-bold tracking-[0.18em] text-muted-foreground">OISHII NORI</p>
              <p className="text-2xl font-extrabold">TABLE {q.number}</p>
              {q.label !== `Table ${q.number}` && <p className="text-sm text-muted-foreground">{q.label}</p>}
              <div
                className="w-44 rounded bg-white p-1 [&_svg]:block [&_svg]:h-auto [&_svg]:w-full"
                role="img"
                aria-label={`QR code for table ${q.number}`}
                dangerouslySetInnerHTML={{ __html: q.svg }}
              />
              <p className="break-all text-xs text-muted-foreground">{q.url}</p>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => copy(q.url)}>
                  <Copy className="h-4 w-4" aria-hidden="true" />
                  Copy link
                </Button>
                <Button size="sm" variant="outline" asChild>
                  <a href={q.url} target="_blank" rel="noreferrer">
                    <ExternalLink className="h-4 w-4" aria-hidden="true" />
                    Open
                  </a>
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
