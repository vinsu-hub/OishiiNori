import React, { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { DashboardLayout } from '@/components/DashboardLayout';
import { useAuth } from '@/contexts/AuthContext';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Star,
  Search,
  Users,
  ShoppingBag,
  Percent,
  PauseCircle,
  X,
  Grid2x2,
  List as ListIcon,
} from 'lucide-react';
import {
  ApiDiscountType,
  ApiMenuAddon,
  ApiProduct,
  ApiProductSize,
  ApiRecipeItem,
  OrderType,
  TransactionPaymentMethod,
  createTransaction,
  QueuedOfflineError,
  fetchAddons,
  fetchBusinessSettings,
  fetchDiscountTypes,
  fetchProducts,
  fetchRecipe,
} from '@/lib/api';
import { formatCurrency } from '@/lib/utils';

interface CartLineAddon {
  addon_id: string;
  name: string;
  price: number;
  quantity: number;
}

interface CartLine {
  key: string;
  product: ApiProduct;
  size: ApiProductSize;
  quantity: number;
  held_ingredients: string[];
  addons: CartLineAddon[];
}

interface HeldCart {
  id: string;
  heldAt: string;
  lines: CartLine[];
}

const FAVORITES_STORAGE_KEY = 'pos-favorite-products';
const HELD_CARTS_STORAGE_KEY = 'pos-held-carts';

function loadFavorites(): Set<string> {
  try {
    const raw = localStorage.getItem(FAVORITES_STORAGE_KEY);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch {
    return new Set();
  }
}

// sessionStorage, not localStorage -- held orders are shift-scoped (should
// survive ordinary in-app navigation, which was the actual bug: wouter
// unmounts POSTerminal on route change, resetting plain component state),
// not meant to persist indefinitely across days the way Favorites should.
function loadHeldCarts(): HeldCart[] {
  try {
    const raw = sessionStorage.getItem(HELD_CARTS_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as HeldCart[]) : [];
  } catch {
    return [];
  }
}

// crypto.randomUUID() requires a secure context (HTTPS/localhost) -- this
// app always runs over Vercel HTTPS, but a plain fallback costs nothing and
// avoids a hard crash if that's ever not true (e.g. a local kiosk over
// plain HTTP/LAN).
function generateId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// "You might also like" -- the drinks/dessert and light-side categories in
// this catalog, the closest analog to SMFC's Sides/Drinks/Desserts upsell
// rail. Confirmed against live product data rather than guessed (this
// catalog's category strings aren't enumerable from static code).
const UPSELL_CATEGORIES = ['Cafe (16oz Iced)', 'Oishii Salad'];

// Availability lives per-size, not per-product -- a product counts as
// available if any size is buyable right now, else low_stock if any size
// is flagged low, else unavailable. Priority order (available beats
// low_stock beats unavailable) since a cashier can still sell it in some
// size whenever any size is buyable.
function productAvailability(product: ApiProduct): 'available' | 'low_stock' | 'unavailable' {
  if (product.sizes.some((s) => s.availability === 'available')) return 'available';
  if (product.sizes.some((s) => s.availability === 'low_stock')) return 'low_stock';
  return 'unavailable';
}

export default function POSTerminal() {
  const { user } = useAuth();
  const [products, setProducts] = useState<ApiProduct[]>([]);
  const [discountTypes, setDiscountTypes] = useState<ApiDiscountType[]>([]);
  const [addons, setAddons] = useState<ApiMenuAddon[]>([]);
  // Default matches the DB seed default (business_settings.vat_rate) --
  // overwritten as soon as the real fetch below resolves, just avoids a
  // flash of "0% tax" in the cart preview before that completes.
  const [vatRate, setVatRate] = useState(0.12);
  const [loading, setLoading] = useState(true);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [discountTypeId, setDiscountTypeId] = useState<string>('none');
  const [submitting, setSubmitting] = useState(false);

  const [sizePickerProduct, setSizePickerProduct] = useState<ApiProduct | null>(null);

  const [ownerRequestOpen, setOwnerRequestOpen] = useState(false);
  const [ownerRequestForm, setOwnerRequestForm] = useState({ employeeNumber: '', pin: '', note: '' });
  const [ownerRequestConfirmed, setOwnerRequestConfirmed] = useState<typeof ownerRequestForm | null>(null);

  const [editOrderOpen, setEditOrderOpen] = useState(false);
  const [editRecipes, setEditRecipes] = useState<Record<string, ApiRecipeItem[]>>({});
  const [editSelections, setEditSelections] = useState<Record<string, Set<string>>>({});
  const [editLoading, setEditLoading] = useState(false);

  const [heldCarts, setHeldCarts] = useState<HeldCart[]>(() => loadHeldCarts());
  const [favorites, setFavorites] = useState<Set<string>>(() => loadFavorites());
  const [selectedCategory, setSelectedCategory] = useState<string>('All');

  // Order context (table/guests/order type/payment method) -- persisted for
  // real on the transaction, see migration 0027. orderType/guestCount are
  // sticky across a charge (same posture as selectedCategory); tableNumber/
  // paymentMethod reset after a successful charge since they're a per-sale
  // fact, not a terminal-wide setting.
  const [orderType, setOrderType] = useState<OrderType>('dine_in');
  const [tableNumber, setTableNumber] = useState('');
  const [guestCount, setGuestCount] = useState(2);
  const [paymentMethod, setPaymentMethod] = useState<TransactionPaymentMethod | null>(null);

  const [searchQuery, setSearchQuery] = useState('');
  const [availabilityFilter, setAvailabilityFilter] = useState<
    'all' | 'available' | 'low_stock' | 'unavailable'
  >('all');
  // No Popularity/Stock sort options -- this catalog has no ranking data,
  // and a labeled sort that silently does nothing would be dead UI, the
  // same thing the "persist payment method for real" decision avoided.
  const [sortBy, setSortBy] = useState<'default' | 'price' | 'name'>('default');
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');

  useEffect(() => {
    try {
      sessionStorage.setItem(HELD_CARTS_STORAGE_KEY, JSON.stringify(heldCarts));
    } catch {
      // sessionStorage unavailable (private mode, etc.) -- held orders just
      // won't survive navigation in that case, not worth surfacing an error.
    }
  }, [heldCarts]);

  useEffect(() => {
    Promise.all([fetchProducts(true), fetchDiscountTypes(true), fetchBusinessSettings(), fetchAddons()])
      .then(([p, d, settings, a]) => {
        setProducts(p);
        setDiscountTypes(d);
        setVatRate(settings.vat_rate);
        setAddons(a);
      })
      .catch((e) => toast.error(`Failed to load menu: ${e.message}`))
      .finally(() => setLoading(false));
  }, []);

  // F3 scroll-to-discounts, F4 hold order, Esc clear order -- matches the
  // SMFC reference's shortcuts for these actions. F5 (free-text per-item
  // notes) deliberately doesn't port -- not requested, and would need its
  // own new transaction_items column; the existing held-ingredients Edit
  // Order dialog covers item customization instead.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'F3') {
        e.preventDefault();
        document.getElementById('discount-chip-row')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      } else if (e.key === 'F4') {
        e.preventDefault();
        handleHoldOrder();
      } else if (e.key === 'Escape') {
        // Radix's dialog dismissal listens on `document` in the capture
        // phase, which runs before an ordinary (bubble-phase) `window`
        // listener would see this same keydown -- by the time a bubble
        // listener ran, `ownerRequestOpen` etc. had already flipped to
        // false, so the guard below was checking stale state and never
        // actually blocked clearOrder(). Registering this listener on
        // `window` in the capture phase too puts it earlier in the capture
        // path (window is captured before document), so it runs first and
        // still sees the real pre-close state.
        if (sizePickerProduct || ownerRequestOpen || editOrderOpen) return;
        clearOrder();
      }
    }
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cart, sizePickerProduct, ownerRequestOpen, editOrderOpen]);

  const selectedDiscount = discountTypes.find((d) => d.id === discountTypeId) || null;

  const subtotal = useMemo(
    () =>
      cart.reduce((sum, line) => {
        const addonsTotal = line.addons.reduce((s, a) => s + a.price * a.quantity, 0);
        return sum + line.size.price * line.quantity + addonsTotal;
      }, 0),
    [cart]
  );

  // Categories are pure business data (this catalog's category strings
  // aren't enumerable from static code, see the UPSELL_CATEGORIES comment
  // above) -- derive the tab list live from whatever products actually
  // loaded, same pattern the customer-menu app already uses for its own
  // category rail.
  const categories = useMemo(
    () => Array.from(new Set(products.map((p) => p.category))).sort(),
    [products]
  );
  const pillCategories = useMemo(() => ['Favorites', ...categories, 'All'], [categories]);

  const availabilityCounts = useMemo(() => {
    const counts = { all: products.length, available: 0, low_stock: 0, unavailable: 0 };
    products.forEach((p) => {
      counts[productAvailability(p)]++;
    });
    return counts;
  }, [products]);

  const visibleProducts = useMemo(() => {
    let list = products.filter((product) => {
      if (selectedCategory === 'Favorites') {
        if (!favorites.has(product.id)) return false;
      } else if (selectedCategory !== 'All' && product.category !== selectedCategory) {
        return false;
      }
      if (availabilityFilter !== 'all' && productAvailability(product) !== availabilityFilter) return false;
      if (searchQuery.trim() && !product.name.toLowerCase().includes(searchQuery.trim().toLowerCase())) {
        return false;
      }
      return true;
    });
    if (sortBy === 'name') {
      list = [...list].sort((a, b) => a.name.localeCompare(b.name));
    } else if (sortBy === 'price') {
      const cheapest = (p: ApiProduct) => Math.min(...p.sizes.map((s) => s.price));
      list = [...list].sort((a, b) => cheapest(a) - cheapest(b));
    }
    return list;
  }, [products, selectedCategory, favorites, availabilityFilter, searchQuery, sortBy]);

  const upsellItems = useMemo(() => {
    const cartProductIds = new Set(cart.map((l) => l.product.id));
    return products
      .filter(
        (p) =>
          UPSELL_CATEGORIES.includes(p.category) &&
          !cartProductIds.has(p.id) &&
          p.sizes.some((s) => s.availability !== 'unavailable')
      )
      .slice(0, 6);
  }, [products, cart]);
  // Preview only -- the backend recomputes discount_amount/tax_amount
  // server-side from the live discount_type row; these numbers are for
  // display before charging, never sent as-is to the API.
  const previewDiscountAmount = selectedDiscount ? subtotal * (selectedDiscount.percentage / 100) : 0;
  const previewTaxable = subtotal - previewDiscountAmount;
  const previewTax = selectedDiscount?.vat_exempt ? 0 : previewTaxable * vatRate;
  const previewTotal = previewTaxable + previewTax;

  function addToCart(product: ApiProduct, size: ApiProductSize) {
    if (size.availability === 'unavailable') {
      toast.error(`${product.name} (${size.size_label}) is out of stock`);
      return;
    }
    setCart((prev) => {
      // Only merge into an existing line for this size when that line has
      // no held ingredients -- a line with holds represents one customer's
      // specific customization and shouldn't silently absorb a plain unit
      // meant for someone else (e.g. a second, unrelated order of the same
      // roll). A held line always gets its own new line instead.
      const existing = prev.find(
        (l) => l.size.id === size.id && l.held_ingredients.length === 0 && l.addons.length === 0
      );
      if (existing) {
        return prev.map((l) => (l.key === existing.key ? { ...l, quantity: l.quantity + 1 } : l));
      }
      return [...prev, { key: generateId(), product, size, quantity: 1, held_ingredients: [], addons: [] }];
    });
  }

  function handleProductClick(product: ApiProduct) {
    if (product.sizes.length === 0) return;
    if (product.sizes.length === 1) {
      addToCart(product, product.sizes[0]);
      return;
    }
    setSizePickerProduct(product);
  }

  function updateQuantity(key: string, delta: number) {
    setCart((prev) =>
      prev
        .map((l) => (l.key === key ? { ...l, quantity: l.quantity + delta } : l))
        .filter((l) => l.quantity > 0)
    );
  }

  function setLineAddonQuantity(lineKey: string, addon: ApiMenuAddon, quantity: number) {
    setCart((prev) =>
      prev.map((l) => {
        if (l.key !== lineKey) return l;
        const others = l.addons.filter((a) => a.addon_id !== addon.id);
        if (quantity <= 0) return { ...l, addons: others };
        return {
          ...l,
          addons: [...others, { addon_id: addon.id, name: addon.name, price: addon.price, quantity }],
        };
      })
    );
  }

  function confirmOwnerRequest() {
    if (!ownerRequestForm.employeeNumber || !ownerRequestForm.pin) {
      toast.error('Employee number and PIN are required');
      return;
    }
    setOwnerRequestConfirmed({ ...ownerRequestForm });
    setOwnerRequestOpen(false);
  }

  function clearOwnerRequest() {
    setOwnerRequestConfirmed(null);
    setOwnerRequestForm({ employeeNumber: '', pin: '', note: '' });
  }

  function openEditOrder() {
    setEditSelections(
      Object.fromEntries(cart.map((line) => [line.key, new Set(line.held_ingredients)]))
    );
    setEditOrderOpen(true);
    setEditLoading(true);
    Promise.all(
      cart.map((line) =>
        fetchRecipe(line.size.id).then((recipe) => [line.size.id, recipe] as const)
      )
    )
      .then((entries) => setEditRecipes(Object.fromEntries(entries)))
      .catch((e) => toast.error(e instanceof Error ? e.message : 'Failed to load ingredients'))
      .finally(() => setEditLoading(false));
  }

  function toggleHeldIngredient(lineKey: string, ingredientName: string) {
    setEditSelections((prev) => {
      const next = new Set(prev[lineKey] ?? []);
      if (next.has(ingredientName)) {
        next.delete(ingredientName);
      } else {
        next.add(ingredientName);
      }
      return { ...prev, [lineKey]: next };
    });
  }

  function saveEditOrder() {
    setCart((prev) =>
      prev.map((line) => ({
        ...line,
        held_ingredients: Array.from(editSelections[line.key] ?? []),
      }))
    );
    setEditOrderOpen(false);
  }

  function clearOrder() {
    setCart([]);
    setDiscountTypeId('none');
    clearOwnerRequest();
  }

  function handleHoldOrder() {
    if (cart.length === 0) {
      toast.error('Cart is empty');
      return;
    }
    setHeldCarts((prev) => [...prev, { id: generateId(), heldAt: new Date().toISOString(), lines: cart }]);
    clearOrder();
    toast.success('Order held');
  }

  function resumeHeldCart(held: HeldCart) {
    // Don't silently discard an in-progress, not-yet-held cart -- auto-hold
    // it first (same as pressing F4) so nothing is lost, then swap in the
    // one being resumed.
    if (cart.length > 0) {
      setHeldCarts((prev) => [
        ...prev.filter((h) => h.id !== held.id),
        { id: generateId(), heldAt: new Date().toISOString(), lines: cart },
      ]);
      toast.info('Current order held automatically to avoid losing it');
    } else {
      setHeldCarts((prev) => prev.filter((h) => h.id !== held.id));
    }
    setCart(held.lines);
  }

  function toggleFavorite(productId: string) {
    setFavorites((prev) => {
      const next = new Set(prev);
      if (next.has(productId)) {
        next.delete(productId);
      } else {
        next.add(productId);
      }
      try {
        localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(Array.from(next)));
      } catch {
        // localStorage unavailable (private mode, etc.) -- favorites just
        // won't persist across reloads, not worth surfacing an error for.
      }
      return next;
    });
  }

  async function handleCharge() {
    if (!user) return;
    if (cart.length === 0) {
      toast.error('Cart is empty');
      return;
    }
    if (orderType === 'dine_in' && !tableNumber.trim()) {
      toast.error('Table number is required for dine-in orders');
      return;
    }
    setSubmitting(true);
    try {
      const transaction = await createTransaction({
        employee_id: user.id,
        items: cart.map((l) => ({
          product_size_id: l.size.id,
          quantity: l.quantity,
          held_ingredients: l.held_ingredients,
          addons: l.addons.map((a) => ({ addon_id: a.addon_id, quantity: a.quantity })),
        })),
        discount_type_id: discountTypeId === 'none' ? undefined : discountTypeId,
        is_owner_request: !!ownerRequestConfirmed,
        owner_request_employee_number: ownerRequestConfirmed?.employeeNumber,
        owner_request_pin: ownerRequestConfirmed?.pin,
        owner_request_note: ownerRequestConfirmed?.note || undefined,
        order_type: orderType,
        table_number: orderType === 'dine_in' ? Number(tableNumber) : null,
        guest_count: orderType === 'dine_in' ? guestCount : null,
        payment_method: paymentMethod ?? undefined,
      });
      toast.success(
        `Sale complete -- total ${formatCurrency(transaction.total_amount)} (discount ${formatCurrency(
          transaction.discount_amount
        )}, tax ${formatCurrency(transaction.tax_amount)})`
      );
      clearOrder();
      setTableNumber('');
      setPaymentMethod(null);
    } catch (e) {
      if (e instanceof QueuedOfflineError) {
        // A real network failure, not a rejection -- the sale is safely
        // queued in localStorage and will replay automatically once the
        // connection returns (see SyncContext/offlineQueue.ts). The
        // cashier's mental model is "this sale happened," so clear the cart
        // like a normal charge -- but skip clearOwnerRequest()'s PIN-reset:
        // a transient WiFi blip shouldn't force PIN re-entry.
        toast.warning(e.message);
        setCart([]);
        setDiscountTypeId('none');
        setTableNumber('');
        setPaymentMethod(null);
      } else {
        toast.error(e instanceof Error ? e.message : 'Failed to create transaction');
        // A failed charge invalidates whatever was staged for Owner's Request --
        // force re-confirmation on retry rather than silently letting a stale
        // (possibly since-invalid) PIN confirmation be reused.
        clearOwnerRequest();
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <DashboardLayout title="POS Terminal">
      <div className="flex h-full overflow-hidden">
        <div className="flex-1 overflow-auto p-6">
          <div className="flex items-center gap-3 mb-3">
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                className="pl-8"
                placeholder="Search menu item..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>
            <div className="flex rounded-md overflow-hidden border shrink-0">
              <button
                type="button"
                onClick={() => setOrderType('dine_in')}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-sm ${
                  orderType === 'dine_in' ? 'bg-primary text-primary-foreground' : 'bg-card text-muted-foreground'
                }`}
              >
                <Users className="w-4 h-4" /> Dine In
              </button>
              <button
                type="button"
                onClick={() => setOrderType('takeout')}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-sm ${
                  orderType === 'takeout' ? 'bg-primary text-primary-foreground' : 'bg-card text-muted-foreground'
                }`}
              >
                <ShoppingBag className="w-4 h-4" /> Takeout
              </button>
            </div>
          </div>
          <div className="flex gap-2 overflow-x-auto pb-1 mb-3">
            {pillCategories.map((cat) => (
              <button
                key={cat}
                type="button"
                onClick={() => setSelectedCategory(cat)}
                className={`shrink-0 px-4 py-1.5 rounded-full text-sm border transition-colors ${
                  selectedCategory === cat
                    ? 'bg-primary text-primary-foreground border-transparent'
                    : 'bg-card text-muted-foreground border-border'
                }`}
              >
                {cat === 'Favorites' && (
                  <Star
                    className="inline w-3.5 h-3.5 mr-1 -mt-0.5"
                    fill={selectedCategory === 'Favorites' ? 'currentColor' : 'none'}
                  />
                )}
                {cat}
              </button>
            ))}
          </div>
          <div className="flex items-center justify-between gap-2 mb-3">
            <div className="flex flex-wrap gap-2">
              {(['all', 'available', 'low_stock', 'unavailable'] as const).map((key) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setAvailabilityFilter(key)}
                  className={`px-3 py-1 rounded-full text-xs border transition-colors ${
                    availabilityFilter === key
                      ? 'bg-primary text-primary-foreground border-transparent'
                      : 'bg-card text-muted-foreground border-border'
                  }`}
                >
                  {key === 'all' ? 'All' : key === 'available' ? 'Available' : key === 'low_stock' ? 'Low Stock' : 'Unavailable'}{' '}
                  ({availabilityCounts[key]})
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Select value={sortBy} onValueChange={(v) => setSortBy(v as typeof sortBy)}>
                <SelectTrigger className="w-28 h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="default">Sort</SelectItem>
                  <SelectItem value="price">Price</SelectItem>
                  <SelectItem value="name">Name</SelectItem>
                </SelectContent>
              </Select>
              <Button size="icon-sm" variant={viewMode === 'grid' ? 'default' : 'outline'} onClick={() => setViewMode('grid')}>
                <Grid2x2 className="w-4 h-4" />
              </Button>
              <Button size="icon-sm" variant={viewMode === 'list' ? 'default' : 'outline'} onClick={() => setViewMode('list')}>
                <ListIcon className="w-4 h-4" />
              </Button>
            </div>
          </div>
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading menu...</p>
          ) : (
            <div
              className={
                viewMode === 'grid'
                  ? 'grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3'
                  : 'flex flex-col gap-2'
              }
            >
              {visibleProducts.map((product) => {
                const cheapest = [...product.sizes].sort((a, b) => a.price - b.price)[0];
                const allUnavailable = product.sizes.every((s) => s.availability === 'unavailable');
                const priceLabel =
                  product.sizes.length > 1 && cheapest
                    ? `from ${formatCurrency(cheapest.price)}`
                    : cheapest
                      ? formatCurrency(cheapest.price)
                      : '';
                const favoriteButton = (
                  <button
                    type="button"
                    className={
                      viewMode === 'grid'
                        ? 'absolute top-1 right-1 z-10 p-1 rounded-full bg-background/80'
                        : 'shrink-0 p-1 rounded-full hover:bg-accent'
                    }
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleFavorite(product.id);
                    }}
                    aria-label={favorites.has(product.id) ? 'Remove favorite' : 'Add favorite'}
                  >
                    <Star
                      className="w-4 h-4"
                      fill={favorites.has(product.id) ? 'currentColor' : 'none'}
                      color={favorites.has(product.id) ? '#FFBF47' : 'currentColor'}
                    />
                  </button>
                );
                const image = (
                  <div className={viewMode === 'grid' ? 'aspect-square w-full bg-muted' : 'w-14 h-14 shrink-0 bg-muted rounded-md overflow-hidden'}>
                    {product.image_path ? (
                      <img
                        src={product.image_path}
                        alt={product.name}
                        className="w-full h-full object-cover"
                        loading="lazy"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-muted-foreground text-xs">
                        {viewMode === 'grid' ? 'No photo' : ''}
                      </div>
                    )}
                  </div>
                );

                if (viewMode === 'list') {
                  return (
                    <Card
                      key={product.id}
                      className={`cursor-pointer transition hover:border-primary ${allUnavailable ? 'opacity-50' : ''}`}
                      onClick={() => !allUnavailable && handleProductClick(product)}
                    >
                      <CardContent className="py-3 flex items-center gap-3">
                        {image}
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-corp-display font-medium truncate">{product.name}</p>
                          <p className="text-xs text-muted-foreground">{product.category}</p>
                          <div className="flex items-center gap-2 mt-0.5">
                            <span className="text-sm font-semibold">{priceLabel}</span>
                            {product.is_bundle && <Badge variant="gold">Bundle</Badge>}
                            {allUnavailable && <Badge variant="destructive">Unavailable</Badge>}
                          </div>
                        </div>
                        {favoriteButton}
                      </CardContent>
                    </Card>
                  );
                }

                return (
                  <Card
                    key={product.id}
                    className={`cursor-pointer overflow-hidden transition hover:border-primary relative ${
                      allUnavailable ? 'opacity-50' : ''
                    }`}
                    onClick={() => !allUnavailable && handleProductClick(product)}
                  >
                    {favoriteButton}
                    {image}
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm font-corp-display">{product.name}</CardTitle>
                    </CardHeader>
                    <CardContent className="pb-3 space-y-1">
                      <p className="text-xs text-muted-foreground">{product.category}</p>
                      <p className="text-sm font-semibold">{priceLabel}</p>
                      {product.is_bundle && (
                        <Badge
                          variant="gold"
                          title="Ingredient deduction for this bundle is logged by the kitchen at fulfillment time, not at checkout."
                        >
                          Bundle
                        </Badge>
                      )}
                      {allUnavailable && <Badge variant="destructive">Unavailable</Badge>}
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}

          {!loading && upsellItems.length > 0 && (
            <div className="mt-4">
              <p className="text-sm font-medium text-muted-foreground mb-2">You might also like</p>
              <div className="flex gap-2 overflow-x-auto pb-2">
                {upsellItems.map((product) => {
                  const cheapest = [...product.sizes].sort((a, b) => a.price - b.price)[0];
                  return (
                    <button
                      key={product.id}
                      className="shrink-0 w-32 text-left border rounded-md p-2 hover:border-primary transition"
                      onClick={() => handleProductClick(product)}
                    >
                      <p className="text-xs font-medium truncate">{product.name}</p>
                      {cheapest && <p className="text-xs text-muted-foreground">{formatCurrency(cheapest.price)}</p>}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <div className="w-96 border-l flex flex-col overflow-hidden">
          <div className="p-4 border-b space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h3 className="font-corp-display font-semibold">Current Order</h3>
            <div className="flex items-center gap-2">
              {orderType === 'dine_in' && (
                <Input
                  className="w-24 h-8 text-sm text-right"
                  placeholder="Table #"
                  value={tableNumber}
                  onChange={(e) => setTableNumber(e.target.value)}
                />
              )}
              <Popover>
                <PopoverTrigger asChild>
                  <Button size="sm" variant="outline">
                    Held ({heldCarts.length})
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-72">
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-medium">Held orders</p>
                      <Button size="sm" variant="ghost" onClick={handleHoldOrder} disabled={cart.length === 0}>
                        Hold current
                      </Button>
                    </div>
                    {heldCarts.length === 0 && (
                      <p className="text-xs text-muted-foreground">No held orders. (F4 to hold the current one.)</p>
                    )}
                    {heldCarts.map((held) => (
                      <button
                        key={held.id}
                        className="w-full text-left text-sm border rounded-md p-2 hover:bg-accent"
                        onClick={() => resumeHeldCart(held)}
                      >
                        <p>
                          {held.lines.length} item{held.lines.length === 1 ? '' : 's'}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          held {new Date(held.heldAt).toLocaleTimeString()}
                        </p>
                      </button>
                    ))}
                  </div>
                </PopoverContent>
              </Popover>
              <Button size="sm" variant="outline" disabled={cart.length === 0} onClick={openEditOrder}>
                Edit Order
              </Button>
            </div>
          </div>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            {orderType === 'dine_in' ? (
              <>
                <Users className="w-4 h-4" />
                <span>Dine In</span>
                <div className="ml-auto flex items-center gap-2">
                  <Button
                    size="icon"
                    variant="outline"
                    className="h-6 w-6"
                    onClick={() => setGuestCount((g) => Math.max(1, g - 1))}
                  >
                    -
                  </Button>
                  <span className="w-4 text-center">{guestCount}</span>
                  <Button size="icon" variant="outline" className="h-6 w-6" onClick={() => setGuestCount((g) => g + 1)}>
                    +
                  </Button>
                  <span>Guests</span>
                </div>
              </>
            ) : (
              <>
                <ShoppingBag className="w-4 h-4" />
                <span>Takeout</span>
              </>
            )}
          </div>
          </div>
          <div className="flex-1 overflow-auto p-4 space-y-2">
            {cart.length === 0 && <p className="text-sm text-muted-foreground">No items yet.</p>}
            {cart.map((line) => {
              const lineAddonsTotal = line.addons.reduce((s, a) => s + a.price * a.quantity, 0);
              return (
                <div key={line.key} className="text-sm border-b pb-2 space-y-1">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="font-medium">{line.product.name}</p>
                      <p className="text-xs text-muted-foreground">{line.size.size_label}</p>
                      {line.held_ingredients.length > 0 && (
                        <p className="text-xs text-destructive">-- hold: {line.held_ingredients.join(', ')}</p>
                      )}
                      {line.addons.length > 0 && (
                        <p className="text-xs text-muted-foreground">
                          +{' '}
                          {line.addons
                            .map((a) => `${a.name}${a.quantity > 1 ? ` x${a.quantity}` : ''}`)
                            .join(', ')}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <Button size="icon" variant="outline" className="h-6 w-6" onClick={() => updateQuantity(line.key, -1)}>
                        -
                      </Button>
                      <span>{line.quantity}</span>
                      <Button size="icon" variant="outline" className="h-6 w-6" onClick={() => updateQuantity(line.key, 1)}>
                        +
                      </Button>
                      <span className="w-14 text-right">
                        {formatCurrency(line.size.price * line.quantity + lineAddonsTotal)}
                      </span>
                    </div>
                  </div>
                  {addons.length > 0 && (
                    <Popover>
                      <PopoverTrigger asChild>
                        <Button size="sm" variant="ghost" className="h-6 px-2 text-xs text-muted-foreground">
                          + Add-ons
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent className="w-64">
                        <div className="space-y-2">
                          <p className="text-sm font-medium">Add-ons for {line.product.name}</p>
                          {addons.map((addon) => {
                            const current = line.addons.find((a) => a.addon_id === addon.id)?.quantity ?? 0;
                            return (
                              <div key={addon.id} className="flex items-center justify-between text-sm">
                                <span>
                                  {addon.name} <span className="text-muted-foreground">({formatCurrency(addon.price)})</span>
                                </span>
                                <div className="flex items-center gap-2">
                                  <Button
                                    size="icon"
                                    variant="outline"
                                    className="h-6 w-6"
                                    onClick={() => setLineAddonQuantity(line.key, addon, current - 1)}
                                    disabled={current === 0}
                                  >
                                    -
                                  </Button>
                                  <span className="w-4 text-center">{current}</span>
                                  <Button
                                    size="icon"
                                    variant="outline"
                                    className="h-6 w-6"
                                    onClick={() => setLineAddonQuantity(line.key, addon, current + 1)}
                                  >
                                    +
                                  </Button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </PopoverContent>
                    </Popover>
                  )}
                </div>
              );
            })}
          </div>

          <div className="p-4 border-t space-y-3">
            <div>
              <Label className="text-xs">Discount</Label>
              <div id="discount-chip-row" className="flex flex-wrap gap-2 mt-1">
                {discountTypes.map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    onClick={() => setDiscountTypeId((prev) => (prev === d.id ? 'none' : d.id))}
                    className={`px-3 py-1 rounded-full text-xs border transition-colors ${
                      discountTypeId === d.id
                        ? 'bg-primary text-primary-foreground border-transparent'
                        : 'bg-card text-muted-foreground border-border'
                    }`}
                  >
                    {d.name} ({d.percentage}%)
                  </button>
                ))}
                {discountTypes.length === 0 && (
                  <p className="text-xs text-muted-foreground">No discount types configured.</p>
                )}
              </div>
            </div>

            <div>
              <Label className="text-xs">Payment Method</Label>
              <div className="grid grid-cols-4 gap-1.5 mt-1">
                {(['cash', 'gcash', 'card', 'split'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setPaymentMethod((prev) => (prev === m ? null : m))}
                    className={`text-xs py-1.5 rounded border capitalize ${
                      paymentMethod === m
                        ? 'bg-primary text-primary-foreground border-transparent'
                        : 'bg-card text-muted-foreground border-border'
                    }`}
                  >
                    {m}
                  </button>
                ))}
              </div>
            </div>

            <Button
              variant={ownerRequestConfirmed ? 'default' : 'outline'}
              className="w-full"
              onClick={() => (ownerRequestConfirmed ? clearOwnerRequest() : setOwnerRequestOpen(true))}
            >
              {ownerRequestConfirmed ? "Owner's Request -- confirmed" : "Owner's Request"}
            </Button>

            <div className="grid grid-cols-3 gap-2">
              <Button
                variant="outline"
                size="sm"
                className="gap-1"
                onClick={() =>
                  document.getElementById('discount-chip-row')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
                }
              >
                <Percent className="w-3.5 h-3.5" /> Discount <kbd className="ml-auto text-[10px] opacity-60">F3</kbd>
              </Button>
              <Button variant="outline" size="sm" className="gap-1" onClick={handleHoldOrder}>
                <PauseCircle className="w-3.5 h-3.5" /> Hold <kbd className="ml-auto text-[10px] opacity-60">F4</kbd>
              </Button>
              <Button variant="destructive" size="sm" className="gap-1" onClick={clearOrder}>
                <X className="w-3.5 h-3.5" /> Clear <kbd className="ml-auto text-[10px] opacity-60">Esc</kbd>
              </Button>
            </div>

            <div className="text-sm space-y-1">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Subtotal</span>
                <span>{formatCurrency(subtotal)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Discount (preview)</span>
                <span>-{formatCurrency(previewDiscountAmount)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Tax (preview)</span>
                <span>{formatCurrency(previewTax)}</span>
              </div>
              <div className="flex justify-between font-semibold text-base">
                <span>Total (preview)</span>
                <span>{formatCurrency(previewTotal)}</span>
              </div>
            </div>

            <Button className="w-full" size="lg" disabled={submitting || cart.length === 0} onClick={handleCharge}>
              {submitting ? 'Charging...' : 'Charge'}
            </Button>
          </div>
        </div>
      </div>

      {/* Size picker */}
      <Dialog open={!!sizePickerProduct} onOpenChange={(open) => !open && setSizePickerProduct(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{sizePickerProduct?.name} -- choose a size</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            {sizePickerProduct?.sizes.map((size) => (
              <Button
                key={size.id}
                variant="outline"
                className="w-full justify-between"
                disabled={size.availability === 'unavailable'}
                onClick={() => {
                  addToCart(sizePickerProduct, size);
                  setSizePickerProduct(null);
                }}
              >
                <span>{size.size_label}</span>
                <span>{formatCurrency(size.price)}</span>
              </Button>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      {/* Owner's Request PIN re-auth */}
      <Dialog open={ownerRequestOpen} onOpenChange={setOwnerRequestOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Owner's Request</DialogTitle>
            <DialogDescription>
              Re-verify your own kiosk credentials to mark this sale as an Owner's Request.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Employee number</Label>
              <Input
                value={ownerRequestForm.employeeNumber}
                onChange={(e) => setOwnerRequestForm({ ...ownerRequestForm, employeeNumber: e.target.value })}
              />
            </div>
            <div>
              <Label>PIN</Label>
              <Input
                type="password"
                value={ownerRequestForm.pin}
                onChange={(e) => setOwnerRequestForm({ ...ownerRequestForm, pin: e.target.value })}
              />
            </div>
            <div>
              <Label>Note (optional)</Label>
              <Input
                value={ownerRequestForm.note}
                onChange={(e) => setOwnerRequestForm({ ...ownerRequestForm, note: e.target.value })}
              />
            </div>
          </div>
          <DialogFooter>
            <Button onClick={confirmOwnerRequest}>Confirm</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Order -- hold ingredients per line before checkout */}
      <Dialog open={editOrderOpen} onOpenChange={setEditOrderOpen}>
        <DialogContent className="max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit order</DialogTitle>
            <DialogDescription>Hold any ingredients the customer doesn't want, per item.</DialogDescription>
          </DialogHeader>
          {editLoading && <p className="text-sm text-muted-foreground">Loading ingredients...</p>}
          {!editLoading && (
            <div className="space-y-4">
              {cart.map((line) => {
                const recipe = editRecipes[line.size.id] ?? [];
                const selected = editSelections[line.key] ?? new Set<string>();
                return (
                  <div key={line.key} className="space-y-2">
                    <p className="text-sm font-medium">
                      {line.product.name} ({line.size.size_label})
                    </p>
                    {recipe.length === 0 && (
                      <p className="text-xs text-muted-foreground">No ingredients to hold for this item.</p>
                    )}
                    <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                      {recipe.map((ingredient) => (
                        <label key={ingredient.id} className="flex items-center gap-2 text-sm">
                          <Checkbox
                            checked={selected.has(ingredient.ingredient_name)}
                            onCheckedChange={() => toggleHeldIngredient(line.key, ingredient.ingredient_name)}
                          />
                          {ingredient.ingredient_name}
                        </label>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          <DialogFooter>
            <Button onClick={saveEditOrder}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
}
