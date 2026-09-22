import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { DashboardLayout } from '@/components/DashboardLayout';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Loader2, Plus, Trash2, Upload } from 'lucide-react';
import { formatCurrency } from '@/lib/utils';
import {
  ApiIngredient,
  ApiProduct,
  ApiProductSize,
  ApiRecipeItem,
  Department,
  KitchenStation,
  createIngredient,
  createProduct,
  createProductSize,
  createRecipeItem,
  deleteProductSize,
  deleteRecipeItem,
  fetchInventory,
  fetchProducts,
  fetchRecipe,
  updateProduct,
  updateProductSize,
  updateRecipeItem,
  uploadProductImage,
} from '@/lib/api';

const STATIONS: { value: KitchenStation; label: string }[] = [
  { value: 'sushi_bar', label: 'Sushi Bar' },
  { value: 'sushi_bar_oven', label: 'Sushi Bar / Oven' },
  { value: 'hot_line', label: 'Hot Line' },
  { value: 'salad_cold_bar', label: 'Salad / Cold Bar' },
  { value: 'cafe_bar', label: 'Cafe Bar' },
];

const DEPARTMENTS: { value: Department; label: string }[] = [
  { value: 'kitchen', label: 'Kitchen' },
  { value: 'cafe', label: 'Cafe' },
];

interface SizeRow {
  localId: string;
  id?: string;
  size_label: string;
  price: string;
  scale_factor: string;
  sort_order: number;
}

function newSizeRow(sortOrder: number): SizeRow {
  return { localId: crypto.randomUUID(), size_label: '', price: '', scale_factor: '1', sort_order: sortOrder };
}

function sizeRowFromApi(s: ApiProductSize): SizeRow {
  return {
    localId: crypto.randomUUID(),
    id: s.id,
    size_label: s.size_label,
    price: String(s.price),
    scale_factor: String(s.scale_factor),
    sort_order: s.sort_order,
  };
}

interface RecipeRow {
  localId: string;
  id?: string;
  ingredient_id: string;
  qty_per_serving: string;
  unit: string;
  prep_notes: string;
}

function newRecipeRow(): RecipeRow {
  return { localId: crypto.randomUUID(), ingredient_id: '', qty_per_serving: '', unit: '', prep_notes: '' };
}

// Sentinel Select value that opens the inline "create a new ingredient"
// form on a recipe row, instead of picking one of the existing ones --
// see createIngredient() in lib/api.ts and its own docstring for why this
// had to be built: there was no path anywhere in the app to add a brand-new
// ingredient before this.
const NEW_INGREDIENT_VALUE = '__new__';

function recipeRowFromApi(r: ApiRecipeItem): RecipeRow {
  return {
    localId: crypto.randomUUID(),
    id: r.id,
    ingredient_id: r.ingredient_id,
    qty_per_serving: String(r.qty_per_serving),
    unit: r.unit,
    prep_notes: r.prep_notes || '',
  };
}

export default function MenuEditing() {
  const [products, setProducts] = useState<ApiProduct[]>([]);
  const [ingredients, setIngredients] = useState<ApiIngredient[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    Promise.all([fetchProducts(false), fetchInventory()])
      .then(([prod, ing]) => {
        setProducts([...prod].sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name)));
        setIngredients([...ing].sort((a, b) => a.name.localeCompare(b.name)));
      })
      .catch((e) => toast.error(`Failed to load menu: ${e.message}`))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const ingredientsById = useMemo(() => {
    const map = new Map<string, ApiIngredient>();
    for (const ing of ingredients) map.set(ing.id, ing);
    return map;
  }, [ingredients]);

  // --- Edit dialog state ---
  const [editing, setEditing] = useState<ApiProduct | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [detailName, setDetailName] = useState('');
  const [detailCategory, setDetailCategory] = useState('');
  const [detailStation, setDetailStation] = useState<KitchenStation>('sushi_bar');
  const [detailDepartment, setDetailDepartment] = useState<Department>('kitchen');
  const [detailActive, setDetailActive] = useState(true);
  const [savingDetails, setSavingDetails] = useState(false);

  const [sizeRows, setSizeRows] = useState<SizeRow[]>([]);
  const [originalSizeIds, setOriginalSizeIds] = useState<Set<string>>(new Set());
  const [savingSizes, setSavingSizes] = useState(false);

  const [recipeSizeId, setRecipeSizeId] = useState<string>('');
  const [recipeRows, setRecipeRows] = useState<RecipeRow[]>([]);
  const [originalRecipeIds, setOriginalRecipeIds] = useState<Set<string>>(new Set());
  const [loadingRecipe, setLoadingRecipe] = useState(false);
  const [savingRecipe, setSavingRecipe] = useState(false);

  // Inline "+ New ingredient..." form state -- keyed by which recipe row
  // (by localId) currently has it open, so only one row shows the form at a time.
  const [creatingIngredientFor, setCreatingIngredientFor] = useState<string | null>(null);
  const [newIngredientName, setNewIngredientName] = useState('');
  const [newIngredientUnit, setNewIngredientUnit] = useState('');
  const [newIngredientCategory, setNewIngredientCategory] = useState('');
  const [creatingIngredient, setCreatingIngredient] = useState(false);

  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [uploadingImage, setUploadingImage] = useState(false);

  // --- Create dialog state ---
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createCategory, setCreateCategory] = useState('');
  const [createStation, setCreateStation] = useState<KitchenStation>('sushi_bar');
  const [createDepartment, setCreateDepartment] = useState<Department>('kitchen');
  const [createSizeRows, setCreateSizeRows] = useState<SizeRow[]>([newSizeRow(0)]);
  const [creating, setCreating] = useState(false);

  function openEdit(product: ApiProduct) {
    setEditing(product);
    setDetailName(product.name);
    setDetailCategory(product.category);
    setDetailStation(product.station);
    setDetailDepartment(product.department);
    setDetailActive(product.active);

    const rows = product.sizes.map(sizeRowFromApi);
    setSizeRows(rows);
    setOriginalSizeIds(new Set(product.sizes.map((s) => s.id)));

    setRecipeSizeId(product.sizes[0]?.id || '');
    setRecipeRows([]);
    setOriginalRecipeIds(new Set());

    setImageFile(null);
    setImagePreview(null);

    setEditOpen(true);
  }

  useEffect(() => {
    if (!editOpen || !recipeSizeId) return;
    setLoadingRecipe(true);
    fetchRecipe(recipeSizeId)
      .then((items) => {
        setRecipeRows(items.map(recipeRowFromApi));
        setOriginalRecipeIds(new Set(items.map((i) => i.id)));
      })
      .catch((e) => toast.error(`Failed to load recipe: ${e.message}`))
      .finally(() => setLoadingRecipe(false));
  }, [editOpen, recipeSizeId]);

  async function handleSaveDetails() {
    if (!editing) return;
    if (!detailName.trim() || !detailCategory.trim()) {
      toast.error('Name and category are required');
      return;
    }
    setSavingDetails(true);
    try {
      await updateProduct(editing.id, {
        name: detailName.trim(),
        category: detailCategory.trim(),
        station: detailStation,
        department: detailDepartment,
        active: detailActive,
      });
      toast.success('Details saved');
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save details');
    } finally {
      setSavingDetails(false);
    }
  }

  function updateSizeRow(localId: string, patch: Partial<SizeRow>) {
    setSizeRows((rows) => rows.map((r) => (r.localId === localId ? { ...r, ...patch } : r)));
  }

  function addSizeRow() {
    setSizeRows((rows) => [...rows, newSizeRow(rows.length)]);
  }

  function removeSizeRow(localId: string) {
    setSizeRows((rows) => (rows.length === 1 ? rows : rows.filter((r) => r.localId !== localId)));
  }

  async function handleSaveSizes() {
    if (!editing) return;
    const invalid = sizeRows.some((r) => !r.size_label.trim() || !Number.isFinite(Number(r.price)) || Number(r.price) < 0);
    if (invalid) {
      toast.error('Every size needs a label and a price of 0 or more');
      return;
    }
    setSavingSizes(true);
    try {
      const currentIds = new Set(sizeRows.filter((r) => r.id).map((r) => r.id as string));
      const removed = Array.from(originalSizeIds).filter((id) => !currentIds.has(id));

      await Promise.all([
        ...sizeRows
          .filter((r) => !r.id)
          .map((r) =>
            createProductSize(editing.id, {
              size_label: r.size_label.trim(),
              price: Number(r.price),
              scale_factor: Number(r.scale_factor) || 1,
              sort_order: r.sort_order,
            })
          ),
        ...sizeRows
          .filter((r) => r.id)
          .map((r) =>
            updateProductSize(r.id as string, {
              size_label: r.size_label.trim(),
              price: Number(r.price),
              scale_factor: Number(r.scale_factor) || 1,
              sort_order: r.sort_order,
            })
          ),
        ...removed.map((id) => deleteProductSize(id)),
      ]);
      toast.success('Sizes & prices saved');
      load();
      const refreshed = await fetchProducts(false);
      const updated = refreshed.find((p) => p.id === editing.id);
      if (updated) {
        setEditing(updated);
        setSizeRows(updated.sizes.map(sizeRowFromApi));
        setOriginalSizeIds(new Set(updated.sizes.map((s) => s.id)));
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save sizes');
    } finally {
      setSavingSizes(false);
    }
  }

  function updateRecipeRow(localId: string, patch: Partial<RecipeRow>) {
    setRecipeRows((rows) => rows.map((r) => (r.localId === localId ? { ...r, ...patch } : r)));
  }

  function addRecipeRow() {
    setRecipeRows((rows) => [...rows, newRecipeRow()]);
  }

  function removeRecipeRow(localId: string) {
    setRecipeRows((rows) => rows.filter((r) => r.localId !== localId));
  }

  function openNewIngredientForm(localId: string) {
    setCreatingIngredientFor(localId);
    setNewIngredientName('');
    setNewIngredientUnit('');
    setNewIngredientCategory('');
  }

  function cancelNewIngredientForm(localId: string) {
    setCreatingIngredientFor(null);
    // The Select was already switched to the sentinel value -- put the row
    // back to "nothing picked yet" rather than leaving an invalid selection.
    updateRecipeRow(localId, { ingredient_id: '' });
  }

  async function handleCreateIngredient(localId: string) {
    if (!newIngredientName.trim() || !newIngredientUnit.trim()) {
      toast.error('Name and base unit are required');
      return;
    }
    setCreatingIngredient(true);
    try {
      const ingredient = await createIngredient({
        name: newIngredientName.trim(),
        base_unit: newIngredientUnit.trim(),
        category: newIngredientCategory.trim() || undefined,
      });
      setIngredients((prev) => [...prev, ingredient].sort((a, b) => a.name.localeCompare(b.name)));
      updateRecipeRow(localId, { ingredient_id: ingredient.id, unit: ingredient.base_unit });
      setCreatingIngredientFor(null);
      toast.success(`Created ingredient "${ingredient.name}" -- starts at 0 stock until a delivery/count gives it real stock`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to create ingredient');
    } finally {
      setCreatingIngredient(false);
    }
  }

  async function handleSaveRecipe() {
    if (!recipeSizeId) return;
    // A row still mid-"create new ingredient" carries the NEW_INGREDIENT_VALUE
    // sentinel, not a real ingredient id -- never send that to the backend.
    const activeRows = recipeRows.filter((r) => r.ingredient_id && r.ingredient_id !== NEW_INGREDIENT_VALUE);
    const invalid = activeRows.some((r) => !Number.isFinite(Number(r.qty_per_serving)) || Number(r.qty_per_serving) <= 0 || !r.unit.trim());
    if (invalid) {
      toast.error('Every recipe line needs an ingredient, a quantity greater than 0, and a unit');
      return;
    }
    setSavingRecipe(true);
    try {
      const currentIds = new Set(activeRows.filter((r) => r.id).map((r) => r.id as string));
      const removed = Array.from(originalRecipeIds).filter((id) => !currentIds.has(id));

      await Promise.all([
        ...activeRows
          .filter((r) => !r.id)
          .map((r) =>
            createRecipeItem(recipeSizeId, {
              ingredient_id: r.ingredient_id,
              qty_per_serving: Number(r.qty_per_serving),
              unit: r.unit.trim(),
              prep_notes: r.prep_notes.trim() || null,
            })
          ),
        ...activeRows
          .filter((r) => r.id)
          .map((r) =>
            updateRecipeItem(r.id as string, {
              ingredient_id: r.ingredient_id,
              qty_per_serving: Number(r.qty_per_serving),
              unit: r.unit.trim(),
              prep_notes: r.prep_notes.trim() || null,
            })
          ),
        ...removed.map((id) => deleteRecipeItem(id)),
      ]);
      toast.success('Recipe saved');
      const items = await fetchRecipe(recipeSizeId);
      setRecipeRows(items.map(recipeRowFromApi));
      setOriginalRecipeIds(new Set(items.map((i) => i.id)));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save recipe');
    } finally {
      setSavingRecipe(false);
    }
  }

  function handleImageChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] || null;
    setImageFile(file);
    setImagePreview(file ? URL.createObjectURL(file) : null);
  }

  async function handleUploadImage() {
    if (!editing || !imageFile) return;
    setUploadingImage(true);
    try {
      const updated = await uploadProductImage(editing.id, imageFile);
      toast.success('Image updated');
      setEditing(updated);
      setImageFile(null);
      setImagePreview(null);
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to upload image');
    } finally {
      setUploadingImage(false);
    }
  }

  function openCreate() {
    setCreateName('');
    setCreateCategory('');
    setCreateStation('sushi_bar');
    setCreateDepartment('kitchen');
    setCreateSizeRows([newSizeRow(0)]);
    setCreateOpen(true);
  }

  function updateCreateSizeRow(localId: string, patch: Partial<SizeRow>) {
    setCreateSizeRows((rows) => rows.map((r) => (r.localId === localId ? { ...r, ...patch } : r)));
  }

  function addCreateSizeRow() {
    setCreateSizeRows((rows) => [...rows, newSizeRow(rows.length)]);
  }

  function removeCreateSizeRow(localId: string) {
    setCreateSizeRows((rows) => (rows.length === 1 ? rows : rows.filter((r) => r.localId !== localId)));
  }

  async function handleCreate() {
    if (!createName.trim() || !createCategory.trim()) {
      toast.error('Name and category are required');
      return;
    }
    const invalid = createSizeRows.some(
      (r) => !r.size_label.trim() || !Number.isFinite(Number(r.price)) || Number(r.price) < 0
    );
    if (invalid) {
      toast.error('Every size needs a label and a price of 0 or more');
      return;
    }
    setCreating(true);
    try {
      await createProduct({
        name: createName.trim(),
        category: createCategory.trim(),
        station: createStation,
        department: createDepartment,
        sizes: createSizeRows.map((r) => ({
          size_label: r.size_label.trim(),
          price: Number(r.price),
          scale_factor: Number(r.scale_factor) || 1,
          sort_order: r.sort_order,
        })),
      });
      toast.success(`${createName.trim()} created`);
      setCreateOpen(false);
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to create menu item');
    } finally {
      setCreating(false);
    }
  }

  function renderSizeRowsEditor(
    rows: SizeRow[],
    onUpdate: (localId: string, patch: Partial<SizeRow>) => void,
    onAdd: () => void,
    onRemove: (localId: string) => void
  ) {
    return (
      <div className="space-y-3">
        {rows.map((row) => (
          <div key={row.localId} className="grid grid-cols-12 gap-2 items-end">
            <div className="col-span-5 space-y-1">
              <Label className="text-xs">Size label</Label>
              <Input value={row.size_label} onChange={(e) => onUpdate(row.localId, { size_label: e.target.value })} placeholder="e.g. Regular" />
            </div>
            <div className="col-span-3 space-y-1">
              <Label className="text-xs">Price</Label>
              <Input type="number" min={0} step="0.01" value={row.price} onChange={(e) => onUpdate(row.localId, { price: e.target.value })} />
            </div>
            <div className="col-span-3 space-y-1">
              <Label className="text-xs">Scale factor</Label>
              <Input type="number" min={0} step="0.01" value={row.scale_factor} onChange={(e) => onUpdate(row.localId, { scale_factor: e.target.value })} />
            </div>
            <div className="col-span-1">
              <Button variant="ghost" size="icon-sm" onClick={() => onRemove(row.localId)} disabled={rows.length === 1} aria-label="Remove size">
                <Trash2 className="w-4 h-4" />
              </Button>
            </div>
          </div>
        ))}
        <Button variant="outline" size="sm" onClick={onAdd} className="gap-1">
          <Plus className="w-4 h-4" />
          Add size
        </Button>
      </div>
    );
  }

  return (
    <DashboardLayout title="Menu Editing">
      <div className="p-6 space-y-4">
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            Manage menu items: details, sizes &amp; prices, recipe components, and photos.
          </p>
          <Button onClick={openCreate}>Add menu item</Button>
        </div>

        {loading && <p className="text-sm text-muted-foreground">Loading menu...</p>}
        {!loading && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Photo</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Department</TableHead>
                <TableHead>Station</TableHead>
                <TableHead>Sizes</TableHead>
                <TableHead>Active</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {products.map((p) => (
                <TableRow key={p.id}>
                  <TableCell>
                    {p.image_path ? (
                      <img src={p.image_path} alt={p.name} className="w-10 h-10 rounded-md object-cover" />
                    ) : (
                      <div className="w-10 h-10 rounded-md bg-muted" />
                    )}
                  </TableCell>
                  <TableCell className="font-medium">{p.name}</TableCell>
                  <TableCell className="text-muted-foreground">{p.category}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{p.department}</Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {STATIONS.find((s) => s.value === p.station)?.label || p.station}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {p.sizes.map((s) => `${s.size_label} (${formatCurrency(s.price)})`).join(', ') || '--'}
                  </TableCell>
                  <TableCell>
                    <Badge variant={p.active ? 'outline' : 'secondary'}>{p.active ? 'Active' : 'Deactivated'}</Badge>
                  </TableCell>
                  <TableCell>
                    <Button size="sm" variant="outline" onClick={() => openEdit(p)}>
                      Edit
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {products.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="text-center text-sm text-muted-foreground">
                    No menu items yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        )}
      </div>

      {/* Edit dialog */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing?.name}</DialogTitle>
          </DialogHeader>

          {editing && (
            <Tabs defaultValue="details">
              <TabsList>
                <TabsTrigger value="details">Details</TabsTrigger>
                <TabsTrigger value="sizes">Sizes &amp; Prices</TabsTrigger>
                <TabsTrigger value="recipe">Recipe</TabsTrigger>
                <TabsTrigger value="image">Image</TabsTrigger>
              </TabsList>

              <TabsContent value="details" className="space-y-3 pt-4">
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label>Name</Label>
                    <Input value={detailName} onChange={(e) => setDetailName(e.target.value)} />
                  </div>
                  <div className="space-y-1">
                    <Label>Category</Label>
                    <Input value={detailCategory} onChange={(e) => setDetailCategory(e.target.value)} />
                  </div>
                  <div className="space-y-1">
                    <Label>Station</Label>
                    <Select value={detailStation} onValueChange={(v) => setDetailStation(v as KitchenStation)}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {STATIONS.map((s) => (
                          <SelectItem key={s.value} value={s.value}>
                            {s.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label>Department</Label>
                    <Select value={detailDepartment} onValueChange={(v) => setDetailDepartment(v as Department)}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {DEPARTMENTS.map((d) => (
                          <SelectItem key={d.value} value={d.value}>
                            {d.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="flex items-center justify-between rounded-md border p-3">
                  <div>
                    <Label>Active</Label>
                    <p className="text-xs text-muted-foreground">Deactivating hides this item from the POS and menu without deleting its history.</p>
                  </div>
                  <Switch checked={detailActive} onCheckedChange={setDetailActive} />
                </div>
                <Button disabled={savingDetails} onClick={handleSaveDetails}>
                  {savingDetails ? 'Saving...' : 'Save details'}
                </Button>
              </TabsContent>

              <TabsContent value="sizes" className="space-y-3 pt-4">
                {renderSizeRowsEditor(sizeRows, updateSizeRow, addSizeRow, removeSizeRow)}
                <Button disabled={savingSizes} onClick={handleSaveSizes} className="gap-2">
                  {savingSizes ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                  Save sizes &amp; prices
                </Button>
              </TabsContent>

              <TabsContent value="recipe" className="space-y-3 pt-4">
                <div className="space-y-1">
                  <Label>Size</Label>
                  <Select value={recipeSizeId} onValueChange={setRecipeSizeId}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select a size" />
                    </SelectTrigger>
                    <SelectContent>
                      {editing.sizes.map((s) => (
                        <SelectItem key={s.id} value={s.id}>
                          {s.size_label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {loadingRecipe && <p className="text-sm text-muted-foreground">Loading recipe...</p>}
                {!loadingRecipe && recipeSizeId && (
                  <div className="space-y-3">
                    {recipeRows.map((row) => (
                      <div key={row.localId} className="grid grid-cols-12 gap-2 items-end">
                        <div className={creatingIngredientFor === row.localId ? 'col-span-12 space-y-1' : 'col-span-4 space-y-1'}>
                          <Label className="text-xs">Ingredient</Label>
                          <Select
                            value={row.ingredient_id}
                            onValueChange={(v) => {
                              if (v === NEW_INGREDIENT_VALUE) {
                                openNewIngredientForm(row.localId);
                                updateRecipeRow(row.localId, { ingredient_id: v });
                              } else {
                                updateRecipeRow(row.localId, { ingredient_id: v });
                              }
                            }}
                          >
                            <SelectTrigger>
                              <SelectValue placeholder="Select ingredient" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value={NEW_INGREDIENT_VALUE} className="font-medium text-primary">
                                <Plus className="w-3.5 h-3.5 inline mr-1" />
                                New ingredient...
                              </SelectItem>
                              {ingredients.map((ing) => (
                                <SelectItem key={ing.id} value={ing.id}>
                                  {ing.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          {creatingIngredientFor === row.localId && (
                            <div className="mt-2 space-y-2 rounded-md border p-3 bg-muted/40">
                              <p className="text-xs text-muted-foreground">
                                New ingredient -- starts at 0 stock until a delivery or count gives it real stock.
                              </p>
                              <Input
                                placeholder="Name"
                                value={newIngredientName}
                                onChange={(e) => setNewIngredientName(e.target.value)}
                              />
                              <div className="grid grid-cols-2 gap-2">
                                <Input
                                  placeholder="Base unit (g, ml, pcs...)"
                                  value={newIngredientUnit}
                                  onChange={(e) => setNewIngredientUnit(e.target.value)}
                                />
                                <Input
                                  placeholder="Category (optional)"
                                  value={newIngredientCategory}
                                  onChange={(e) => setNewIngredientCategory(e.target.value)}
                                />
                              </div>
                              <div className="flex gap-2">
                                <Button
                                  size="sm"
                                  disabled={creatingIngredient}
                                  onClick={() => handleCreateIngredient(row.localId)}
                                  className="gap-2"
                                >
                                  {creatingIngredient ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                                  Create &amp; use
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  disabled={creatingIngredient}
                                  onClick={() => cancelNewIngredientForm(row.localId)}
                                >
                                  Cancel
                                </Button>
                              </div>
                            </div>
                          )}
                        </div>
                        {creatingIngredientFor !== row.localId && (
                          <>
                            <div className="col-span-2 space-y-1">
                              <Label className="text-xs">Qty per serving</Label>
                              <Input
                                type="number"
                                min={0}
                                step="0.01"
                                value={row.qty_per_serving}
                                onChange={(e) => updateRecipeRow(row.localId, { qty_per_serving: e.target.value })}
                              />
                            </div>
                            <div className="col-span-2 space-y-1">
                              <Label className="text-xs">Unit</Label>
                              <Input
                                value={row.unit}
                                onChange={(e) => updateRecipeRow(row.localId, { unit: e.target.value })}
                                placeholder={row.ingredient_id ? ingredientsById.get(row.ingredient_id)?.base_unit : 'unit'}
                              />
                            </div>
                            <div className="col-span-3 space-y-1">
                              <Label className="text-xs">Prep notes (optional)</Label>
                              <Input value={row.prep_notes} onChange={(e) => updateRecipeRow(row.localId, { prep_notes: e.target.value })} />
                            </div>
                            <div className="col-span-1">
                              <Button variant="ghost" size="icon-sm" onClick={() => removeRecipeRow(row.localId)} aria-label="Remove ingredient">
                                <Trash2 className="w-4 h-4" />
                              </Button>
                            </div>
                          </>
                        )}
                      </div>
                    ))}
                    <div className="flex items-center justify-between">
                      <Button variant="outline" size="sm" onClick={addRecipeRow} className="gap-1">
                        <Plus className="w-4 h-4" />
                        Add ingredient
                      </Button>
                      <Button disabled={savingRecipe} onClick={handleSaveRecipe} className="gap-2">
                        {savingRecipe ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                        Save recipe
                      </Button>
                    </div>
                  </div>
                )}
                {!recipeSizeId && <p className="text-sm text-muted-foreground">This item has no sizes yet -- add one under Sizes &amp; Prices first.</p>}
              </TabsContent>

              <TabsContent value="image" className="space-y-3 pt-4">
                <div className="flex items-center gap-4">
                  {(imagePreview || editing.image_path) ? (
                    <img src={imagePreview || editing.image_path || ''} alt={editing.name} className="w-24 h-24 rounded-md object-cover border" />
                  ) : (
                    <div className="w-24 h-24 rounded-md bg-muted border" />
                  )}
                  <div className="space-y-2">
                    <Input type="file" accept="image/jpeg,image/png,image/webp" onChange={handleImageChange} />
                    <Button disabled={!imageFile || uploadingImage} onClick={handleUploadImage} className="gap-2">
                      {uploadingImage ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                      Upload
                    </Button>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">JPEG, PNG, or WEBP, up to 5MB.</p>
              </TabsContent>
            </Tabs>
          )}
        </DialogContent>
      </Dialog>

      {/* Create dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Add menu item</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>Name</Label>
                <Input value={createName} onChange={(e) => setCreateName(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label>Category</Label>
                <Input value={createCategory} onChange={(e) => setCreateCategory(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label>Station</Label>
                <Select value={createStation} onValueChange={(v) => setCreateStation(v as KitchenStation)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {STATIONS.map((s) => (
                      <SelectItem key={s.value} value={s.value}>
                        {s.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>Department</Label>
                <Select value={createDepartment} onValueChange={(v) => setCreateDepartment(v as Department)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DEPARTMENTS.map((d) => (
                      <SelectItem key={d.value} value={d.value}>
                        {d.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <Card>
              <CardContent className="pt-6">
                <Label className="text-xs">Sizes &amp; prices</Label>
                <div className="mt-2">
                  {renderSizeRowsEditor(createSizeRows, updateCreateSizeRow, addCreateSizeRow, removeCreateSizeRow)}
                </div>
              </CardContent>
            </Card>
            <p className="text-xs text-muted-foreground">
              Recipe components and a photo can be added afterward by editing this item once it's created.
            </p>
          </div>
          <DialogFooter>
            <Button disabled={creating} onClick={handleCreate}>
              {creating ? 'Creating...' : 'Create menu item'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
}
