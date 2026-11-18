import { useMemo, useState } from 'react';
import { Check, ChevronsUpDown, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { ApiStockItem } from '@/lib/api';

/** What the picker needs from an ingredient (ApiIngredient or a Recipes & Costs row). */
export interface PickerIngredient {
  id: string;
  name: string;
  base_unit: string;
  station?: string | null;
  prep_yield?: number | null;
}
import { STOCK_STATION_LABELS } from '@/lib/constants';

/** Recipe ingredient picker with search: every ingredient (prep bases
 * marked), plus the Station Items rows that aren't ingredients yet -- cups,
 * lids, boxes -- so they can go into a recipe without being typed in again
 * (picking one links it: onPickStockItem). */
export function IngredientPicker({
  value,
  ingredients,
  stockItems = [],
  onPick,
  onPickStockItem,
  onNew,
  ariaLabel,
}: {
  value: string;
  ingredients: PickerIngredient[];
  stockItems?: ApiStockItem[];
  onPick: (ingredientId: string) => void;
  onPickStockItem?: (item: ApiStockItem) => void;
  onNew?: () => void;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = ingredients.find((i) => i.id === value);
  const unlinked = useMemo(() => {
    const names = new Set(ingredients.map((i) => i.name.trim().toLowerCase()));
    return stockItems.filter((s) => s.active && !s.ingredient_id && !names.has(s.name.trim().toLowerCase()));
  }, [ingredients, stockItems]);
  const where = (station?: string | null) => (station && station in STOCK_STATION_LABELS ? STOCK_STATION_LABELS[station as keyof typeof STOCK_STATION_LABELS] : 'Unsorted');

  return (
    <Popover open={open} onOpenChange={setOpen} modal>
      <PopoverTrigger asChild>
        <Button variant="outline" role="combobox" aria-expanded={open} aria-label={ariaLabel} className="w-full justify-between font-normal">
          <span className="truncate">{selected ? selected.name : 'Select ingredient'}</span>
          <ChevronsUpDown className="ml-1 h-4 w-4 shrink-0 opacity-50" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="z-[200] w-[min(26rem,calc(100vw-2rem))] p-0" align="start">
        <Command
          filter={(itemValue, search) => (itemValue.toLowerCase().includes(search.trim().toLowerCase()) ? 1 : 0)}
        >
          <CommandInput placeholder="Search ingredients, cups, boxes…" />
          <CommandList className="max-h-80">
            <CommandEmpty>Nothing found. Add it with “New ingredient”.</CommandEmpty>
            {onNew && (
              <CommandGroup>
                <CommandItem value="__new__ new ingredient" onSelect={() => { setOpen(false); onNew(); }} className="font-medium text-primary">
                  <Plus className="mr-1 h-3.5 w-3.5" aria-hidden /> New ingredient…
                </CommandItem>
              </CommandGroup>
            )}
            <CommandGroup heading={`Ingredients (${ingredients.length})`}>
              {ingredients.map((i) => (
                <CommandItem
                  key={i.id}
                  value={`${i.name} ${i.prep_yield != null ? '(prep base)' : ''} ${i.id}`}
                  onSelect={() => { setOpen(false); onPick(i.id); }}
                >
                  <Check className={`mr-1 h-4 w-4 ${i.id === value ? 'opacity-100' : 'opacity-0'}`} aria-hidden />
                  <span className="flex-1 truncate">{i.name}</span>
                  {i.prep_yield != null && <span className="rounded bg-secondary px-1.5 text-[10px] uppercase">Prep base</span>}
                  <span className="ml-2 shrink-0 text-xs text-muted-foreground">{i.base_unit} · {where(i.station)}</span>
                </CommandItem>
              ))}
            </CommandGroup>
            {onPickStockItem && unlinked.length > 0 && (
              <CommandGroup heading={`Station items, not yet ingredients (${unlinked.length})`}>
                {unlinked.map((s) => (
                  <CommandItem
                    key={s.id}
                    value={`${s.name} ${s.category ?? ''} ${s.id}`}
                    onSelect={() => { setOpen(false); onPickStockItem(s); }}
                  >
                    <Plus className="mr-1 h-4 w-4 opacity-60" aria-hidden />
                    <span className="flex-1 truncate">{s.name}</span>
                    <span className="ml-2 shrink-0 text-xs text-muted-foreground">{s.unit || 'pcs'} · {where(s.station)} · {s.category}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
