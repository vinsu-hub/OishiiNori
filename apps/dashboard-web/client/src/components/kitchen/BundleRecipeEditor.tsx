import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ApiProduct, fetchBundleRecipe, saveBundleRecipe } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export function BundleRecipeEditor({ product }: { product: ApiProduct }) {
  const [sizeId, setSizeId] = useState('');
  const [pieces, setPieces] = useState('');
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    setError('');
    setSizeId('');
    setPieces('');
    fetchBundleRecipe(product.id).then((source) => {
      if (!cancelled && source) {
        setSizeId(source.product_size_id);
        setPieces(String(source.pieces_per_serving));
      }
    }).catch((e: Error) => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [product.id]);

  async function save() {
    setBusy(true);
    try {
      await saveBundleRecipe(product.id, { product_size_id: sizeId, pieces_per_serving: Number(pieces) });
      toast.success('Bundle recipe saved');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save bundle recipe');
    } finally { setBusy(false); }
  }

  return (
    <div className="rounded-md border p-3 space-y-3">
      <p className="font-medium">Recipe for platters and sushi boats</p>
      <p className="text-sm text-muted-foreground">Choose the saved recipe used for this flavor and confirm how many pieces that recipe makes. Kitchen staff will continue entering individual pieces.</p>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : <>
        <Label>Recipe size</Label>
        <Select value={sizeId} onValueChange={setSizeId} disabled={busy}>
          <SelectTrigger aria-label="Bundle recipe size"><SelectValue placeholder="Choose a saved recipe size" /></SelectTrigger>
          <SelectContent>{product.sizes.map((s) => <SelectItem key={s.id} value={s.id}>{s.size_label}</SelectItem>)}</SelectContent>
        </Select>
        <Label htmlFor="bundle-recipe-pieces">Pieces made by one recipe serving</Label>
        <Input id="bundle-recipe-pieces" type="number" min={1} step={1} value={pieces} onChange={(e) => setPieces(e.target.value)} disabled={busy} />
        <Button type="button" disabled={busy || !sizeId || !Number.isInteger(Number(pieces)) || Number(pieces) <= 0} onClick={save}>Save bundle recipe</Button>
      </>}
    </div>
  );
}
