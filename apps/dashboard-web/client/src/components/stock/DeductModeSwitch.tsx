import { useState } from 'react';
import { toast } from 'sonner';
import { type PrepBase, setPrepBaseMode } from '@/lib/api';

const MODES = [
  {
    value: 'batch' as const,
    label: 'Made in batches',
    help: 'Staff press "Made a batch" (or EOD Count spots it). A sale takes this item.',
  },
  {
    value: 'auto' as const,
    label: 'Take from raw items',
    help: 'Nobody logs batches. A sale takes what this is made of, straight away.',
  },
];

/** How a prep base comes off stock: made in batches, or straight from its
 * raw items on every sale (good for small preps nobody logs). */
export function DeductModeSwitch({
  base,
  canEdit,
  onChanged,
}: {
  base: Pick<PrepBase, 'ingredient_id' | 'name' | 'deduct_mode'> & { components: { name: string }[] };
  canEdit: boolean;
  onChanged: (updated: PrepBase) => void;
}) {
  const [saving, setSaving] = useState(false);
  const mode = base.deduct_mode ?? 'batch';
  const current = MODES.find((m) => m.value === mode)!;

  async function pick(value: 'batch' | 'auto') {
    if (value === mode || saving) return;
    setSaving(true);
    try {
      const updated = await setPrepBaseMode(base.ingredient_id, value);
      toast.success(
        value === 'auto'
          ? `${base.name}: sales now take ${base.components.map((c) => c.name).join(', ')}`
          : `${base.name}: made in batches again`,
      );
      onChanged(updated);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not change it');
    } finally {
      setSaving(false);
    }
  }

  if (!canEdit) {
    return <p className="text-xs text-muted-foreground">{current.label}: {current.help}</p>;
  }
  return (
    <div className="space-y-1">
      <div className="inline-flex rounded-md border p-0.5" role="radiogroup" aria-label={`How ${base.name} comes off stock`}>
        {MODES.map((m) => (
          <button
            key={m.value}
            type="button"
            role="radio"
            aria-checked={mode === m.value}
            disabled={saving}
            onClick={() => pick(m.value)}
            className={`rounded px-2.5 py-1 text-xs ${mode === m.value ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'}`}
          >
            {m.label}
          </button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">{current.help}</p>
    </div>
  );
}
