import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

// One line in an Edit order dialog. Kept lines carry their add-ons, held
// ingredients and discount; a replaced or newly added line starts plain.
export interface EditLine {
  key: string;
  product_size_id: string;
  quantity: number;
  held_ingredients: string[];
  addons: { addon_id: string; quantity: number; unit_price: number }[];
  discount_type_id: string | null;
  discount_amount: number;
  // A bundle whose rolls the kitchen already logged stays as it is.
  locked: boolean;
}

/** Add, remove or replace lines. Shared by Advance Orders and Online Orders. */
export function OrderItemLinesEditor({ lines, onChange, sizeOptions, names, allowEmpty = false }: {
  lines: EditLine[];
  onChange: (update: (lines: EditLine[]) => EditLine[]) => void;
  sizeOptions: { id: string; text: string }[];
  names: Map<string, string>;
  allowEmpty?: boolean;
}) {
  const updateLine = (key: string, patch: Partial<EditLine>) =>
    onChange((rows) => rows.map((line) => line.key === key ? { ...line, ...patch } : line));
  return <div className="space-y-2">
    {lines.map((line) => line.locked ? <div key={line.key} className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/50 p-2 text-sm">
      <span className="flex-1">{line.quantity}× {names.get(line.product_size_id) ?? 'Bundle'}</span>
      <span className="text-xs text-muted-foreground">Bundle already made — can't be changed</span>
    </div> : <div key={line.key} className="flex flex-wrap items-center gap-2 rounded-md border p-2">
      <select aria-label="Item" className="h-10 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm" value={line.product_size_id}
        onChange={(e) => updateLine(line.key, { product_size_id: e.target.value, addons: [], held_ingredients: [], discount_type_id: null, discount_amount: 0 })}>
        {!sizeOptions.some((option) => option.id === line.product_size_id) && <option value={line.product_size_id}>{names.get(line.product_size_id) ?? 'Item'}</option>}
        {sizeOptions.map((option) => <option key={option.id} value={option.id}>{option.text}</option>)}
      </select>
      <Input aria-label="Quantity" className="w-20" type="number" min="1" step="1" value={line.quantity}
        onChange={(e) => updateLine(line.key, { quantity: Math.max(1, Math.floor(Number(e.target.value) || 1)) })} />
      <Button type="button" variant="outline" size="icon" aria-label="Remove item" onClick={() => onChange((rows) => rows.filter((l) => l.key !== line.key))}><Trash2 className="h-4 w-4" /></Button>
      {(line.addons.length > 0 || line.held_ingredients.length > 0 || line.discount_type_id) && <p className="w-full text-xs text-muted-foreground">
        {[line.addons.length ? `${line.addons.length} add-on${line.addons.length > 1 ? 's' : ''} kept` : '', line.held_ingredients.length ? `No ${line.held_ingredients.join(', ')}` : '', line.discount_type_id ? 'Discount kept' : ''].filter(Boolean).join(' · ')}
      </p>}
    </div>)}
    {lines.length === 0 && !allowEmpty && <p className="text-sm text-destructive">An order needs at least one item.</p>}
    <select aria-label="Add item" className="h-10 w-full rounded-md border bg-background px-3 text-sm" value=""
      onChange={(e) => { const id = e.target.value; if (id) onChange((rows) => [...rows, { key: `new-${Date.now()}`, product_size_id: id, quantity: 1, held_ingredients: [], addons: [], discount_type_id: null, discount_amount: 0, locked: false }]); }}>
      <option value="" disabled>+ Add item</option>
      {sizeOptions.map((option) => <option key={option.id} value={option.id}>{option.text}</option>)}
    </select>
  </div>;
}
