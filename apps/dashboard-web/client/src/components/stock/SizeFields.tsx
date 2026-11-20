import { Input } from '@/components/ui/input';
import { describeSize, sizeFromInput, type SizeDirection } from '@/lib/units';

export interface SizeDraft {
  name: string;
  qty: string;
  direction: SizeDirection;
}

export const EMPTY_SIZE: SizeDraft = { name: '', qty: '', direction: 'up' };

/** base_qty for a filled-in draft, or null while it's incomplete. */
export function sizeDraftFactor(d: SizeDraft): number | null {
  const n = Number(d.qty);
  if (!d.name.trim() || !Number.isFinite(n) || n <= 0) return null;
  return sizeFromInput(d.direction, n);
}

/** "1 [pack] = [10] sachet" or, flipped, "1 pcs = [120] [g]": the second
 * way is for a size smaller than the main unit (grams of a pcs item), so
 * nobody has to work out "1 g = 0.0083 pcs". */
export function SizeFields({
  draft,
  onChange,
  baseUnit,
}: {
  draft: SizeDraft;
  onChange: (d: SizeDraft) => void;
  baseUnit: string;
}) {
  const set = (patch: Partial<SizeDraft>) => onChange({ ...draft, ...patch });
  const factor = sizeDraftFactor(draft);
  const nameInput = (
    <Input
      className="w-28"
      placeholder={draft.direction === 'up' ? 'e.g. pack' : 'e.g. g'}
      value={draft.name}
      onChange={(e) => set({ name: e.target.value })}
      aria-label="Size name"
    />
  );
  const qtyInput = (
    <Input
      className="w-24"
      inputMode="decimal"
      type="number"
      min={0}
      step="any"
      placeholder={draft.direction === 'up' ? 'e.g. 10' : 'e.g. 120'}
      value={draft.qty}
      onChange={(e) => set({ qty: e.target.value })}
      aria-label={draft.direction === 'up' ? `How many ${baseUnit} in one` : `How many in one ${baseUnit}`}
    />
  );

  return (
    <div className="space-y-2 text-sm">
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Bigger or smaller than one">
        {(
          [
            ['up', `Bigger than 1 ${baseUnit} (pack, box, tray)`],
            ['down', `Smaller than 1 ${baseUnit} (g, ml, slice)`],
          ] as const
        ).map(([dir, label]) => (
          <button
            key={dir}
            type="button"
            role="radio"
            aria-checked={draft.direction === dir}
            onClick={() => set({ direction: dir })}
            className={`rounded-full border px-2.5 py-1 text-xs ${
              draft.direction === dir ? 'border-primary bg-primary/10 text-primary' : 'hover:bg-muted'
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground">1</span>
        {draft.direction === 'up' ? (
          <>
            {nameInput}
            <span className="text-muted-foreground">=</span>
            {qtyInput}
            <span className="text-muted-foreground">{baseUnit}</span>
          </>
        ) : (
          <>
            <span className="text-muted-foreground">{baseUnit} =</span>
            {qtyInput}
            {nameInput}
          </>
        )}
      </div>
      {factor != null && draft.direction === 'down' && (
        <p className="text-xs text-muted-foreground">
          Counting 1,000 {draft.name.trim()} = {Math.round(1000 * factor * 100) / 100} {baseUnit}.{' '}
          {describeSize(draft.name.trim(), factor, baseUnit)}
        </p>
      )}
    </div>
  );
}
