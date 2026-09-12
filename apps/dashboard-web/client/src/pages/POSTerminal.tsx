import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useSearch } from 'wouter';
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
  CheckCircle2,
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Lock,
  Play,
  Square,
} from 'lucide-react';
import {
  ApiDiscountType,
  ApiMenuAddon,
  ApiProduct,
  ApiProductSize,
  ApiRecipeItem,
  BusinessDayStatus,
  OrderType,
  PosTableOverview,
  PosTableStatus,
  TransactionPaymentMethod,
  TransactionCardType,
  closeBusinessDay,
  createTransaction,
  QueuedOfflineError,
  fetchAddons,
  fetchBusinessSettings,
  fetchDiscountTypes,
  fetchPosTablesOverview,
  fetchProducts,
  fetchRecipe,
  fetchTodayBusinessDay,
  openBusinessDay,
  overrideTableBlock,
  posTableStatus,
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

  // WS-13: Business Day cycle -- the POS is locked (overlay below) until
  // businessDay.is_open. null while the initial status fetch is in flight,
  // so the overlay doesn't flash open-then-locked on every page load.
  const [businessDay, setBusinessDay] = useState<BusinessDayStatus | null>(null);
  const [businessDayLoading, setBusinessDayLoading] = useState(true);
  const loadBusinessDay = React.useCallback(() => {
    fetchTodayBusinessDay()
      .then(setBusinessDay)
      .catch((e) => toast.error(e instanceof Error ? e.message : 'Failed to load business day status'))
      .finally(() => setBusinessDayLoading(false));
  }, []);
  useEffect(() => {
    loadBusinessDay();
  }, [loadBusinessDay]);

  const [startDayOpen, setStartDayOpen] = useState(false);
  const [startDayStep, setStartDayStep] = useState<'credentials' | 'menu-check'>('credentials');
  const [startDayForm, setStartDayForm] = useState({ employeeNumber: '', pin: '' });
  const [startDaySubmitting, setStartDaySubmitting] = useState(false);

  const [endDayOpen, setEndDayOpen] = useState(false);
  const [endDayStep, setEndDayStep] = useState<'register-total' | 'credentials'>('register-total');
  const [endDayForm, setEndDayForm] = useState({ cashRegisterTotal: '', employeeNumber: '', pin: '' });
  const [endDaySubmitting, setEndDaySubmitting] = useState(false);

  // WS-13: the backend 403s with a terse "did not match your logged-in
  // account" detail whenever the entered Employee Number + PIN belong to a
  // DIFFERENT account than whoever is currently logged into the dashboard
  // (Start/End Business Day always re-verifies against the caller's own
  // profile, not just any valid kiosk credential). That's easy to trigger
  // by accident -- e.g. typing a cashier's number while still logged in as
  // a manager/executive -- so it gets its own explanatory dialog instead of
  // a generic toast that's easy to misread as a typo or a bad PIN.
  const [credentialMismatchOpen, setCredentialMismatchOpen] = useState(false);

  function handleBusinessDayError(e: unknown) {
    const message = e instanceof Error ? e.message : 'Failed to update business day status';
    if (message.includes('did not match your logged-in account')) {
      setCredentialMismatchOpen(true);
    } else {
      toast.error(message);
    }
  }

  function resetStartDayDialog() {
    setStartDayOpen(false);
    setStartDayStep('credentials');
    setStartDayForm({ employeeNumber: '', pin: '' });
  }

  function resetEndDayDialog() {
    setEndDayOpen(false);
    setEndDayStep('register-total');
    setEndDayForm({ cashRegisterTotal: '', employeeNumber: '', pin: '' });
  }

  async function submitStartDay(menuConfirmed: boolean) {
    setStartDaySubmitting(true);
    try {
      const status = await openBusinessDay({
        employee_number: startDayForm.employeeNumber.trim(),
        pin: startDayForm.pin.trim(),
        menu_confirmed: menuConfirmed,
      });
      setBusinessDay(status);
      resetStartDayDialog();
      toast.success('Business day started');
    } catch (e) {
      handleBusinessDayError(e);
    } finally {
      setStartDaySubmitting(false);
    }
  }

  async function submitEndDay() {
    const total = Number(endDayForm.cashRegisterTotal);
    if (!Number.isFinite(total) || total < 0) {
      toast.error('Enter the counted cash register total');
      return;
    }
    setEndDaySubmitting(true);
    try {
      const status = await closeBusinessDay({
        employee_number: endDayForm.employeeNumber.trim(),
        pin: endDayForm.pin.trim(),
        cash_register_total: total,
      });
      setBusinessDay(status);
      resetEndDayDialog();
      toast.success('Business day closed');
    } catch (e) {
      handleBusinessDayError(e);
    } finally {
      setEndDaySubmitting(false);
    }
  }

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
  // Floor-plan tables for the Dine In picker (label + live occupied/reserved).
  const [tableOptions, setTableOptions] = useState<PosTableOverview[]>([]);
  const [guestCount, setGuestCount] = useState(2);
  const [paymentMethod, setPaymentMethod] = useState<TransactionPaymentMethod | null>(null);
  const [cardType, setCardType] = useState<TransactionCardType | null>(null);
  const [cardTypePromptOpen, setCardTypePromptOpen] = useState(false);
  // Independent of any discount's own vat_exempt -- lets a cashier book an
  // order non-VAT with no VAT-exempt discount applied.
  const [vatOverride, setVatOverride] = useState<'vat' | 'non_vat'>('vat');

  // Reservation block: when the typed table has a live confirmed reservation
  // the POS shows it as reserved and blocks the charge until a manager
  // overrides (mirrors the Owner's Request PIN re-auth). overrideId is the
  // single-use token returned by that override, passed to createTransaction.
  const [tableStatus, setTableStatus] = useState<PosTableStatus | null>(null);
  // Set when the Floor Plan sent us here to seat a specific reservation
  // (/pos?...&reservation=<id>). Linked to the sale at charge time so the
  // reservation is marked seated; cleared after a successful charge.
  const [reservationId, setReservationId] = useState<string | null>(null);
  const [overrideId, setOverrideId] = useState<string | null>(null);
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [overrideForm, setOverrideForm] = useState({ employeeNumber: '', pin: '', reason: '' });
  const [overrideBusy, setOverrideBusy] = useState(false);
  const tableBlocked = !!tableStatus?.blocked && !overrideId;

  // Pre-seat from the Floor Plan: /pos?table=<posNumber>&guests=<n>. Applied
  // once on mount, then the params are stripped so a refresh doesn't re-seat.
  const search = useSearch();
  const [, navigate] = useLocation();
  useEffect(() => {
    const params = new URLSearchParams(search);
    const t = params.get('table');
    const g = params.get('guests');
    const r = params.get('reservation');
    if (!t && !g && !r) return;
    if (t && /^\d+$/.test(t)) {
      setOrderType('dine_in');
      setTableNumber(t);
    }
    if (g && /^\d+$/.test(g)) setGuestCount(Math.max(1, Number(g)));
    if (r) setReservationId(r);
    navigate('/pos', { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [searchQuery, setSearchQuery] = useState('');
  const [availabilityFilter, setAvailabilityFilter] = useState<
    'all' | 'available' | 'low_stock' | 'unavailable'
  >('all');
  // No Popularity/Stock sort options -- this catalog has no ranking data,
  // and a labeled sort that silently does nothing would be dead UI, the
  // same thing the "persist payment method for real" decision avoided.
  const [sortBy, setSortBy] = useState<'default' | 'price' | 'name'>('default');
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');

  // WS-1: grid view is a fixed 2-row, non-scrolling tap area on a tablet --
  // overflow pages instead of scrolling. Columns are measured off the actual
  // container width (not a CSS breakpoint guess) so pageSize always matches
  // what's really rendered per row.
  const GRID_TILE_WIDTH = 176;
  const GRID_GAP = 12;
  const productGridRef = useRef<HTMLDivElement>(null);
  const [gridCols, setGridCols] = useState(4);
  useEffect(() => {
    const el = productGridRef.current;
    if (!el || viewMode !== 'grid') return;
    const compute = () => {
      const width = el.clientWidth;
      setGridCols(Math.max(1, Math.floor((width + GRID_GAP) / (GRID_TILE_WIDTH + GRID_GAP))));
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [viewMode]);

  const [gridPage, setGridPage] = useState(0);
  // Page resets whenever the visible set could change shape.
  useEffect(() => {
    setGridPage(0);
  }, [selectedCategory, availabilityFilter, searchQuery, sortBy, viewMode]);

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

  // Dine In table picker options -- refreshed on mount, whenever the order
  // type returns to Dine In, and after a charge (a just-seated table should
  // immediately read as occupied).
  const loadTableOptions = React.useCallback(() => {
    fetchPosTablesOverview()
      .then(setTableOptions)
      .catch(() => {
        // Leave the picker empty rather than blocking Dine In; the charge-time
        // reservation check still runs regardless.
        toast.error('Could not load the table list -- pick the table on the Floor Plan or retry.');
      });
  }, []);

  useEffect(() => {
    if (orderType === 'dine_in') loadTableOptions();
  }, [orderType, loadTableOptions]);

  // Check the typed table against confirmed reservations. Debounced so a
  // cashier typing "12" doesn't fire a request for "1" first. Any change to
  // the table number invalidates a previously granted override.
  useEffect(() => {
    setOverrideId(null);
    const raw = tableNumber.trim();
    const n = Number(raw);
    if (orderType !== 'dine_in' || raw === '' || !Number.isInteger(n) || n <= 0) {
      setTableStatus(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      posTableStatus(n)
        .then((s) => {
          if (!cancelled) setTableStatus(s);
        })
        .catch(() => {
          if (!cancelled) setTableStatus(null);
        });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [tableNumber, orderType]);

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
        if (sizePickerProduct || ownerRequestOpen || editOrderOpen || cardTypePromptOpen) return;
        clearOrder();
      }
    }
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cart, sizePickerProduct, ownerRequestOpen, editOrderOpen]);

  const selectedDiscount = discountTypes.find((d) => d.id === discountTypeId) || null;

  // Dine In table selection -- surfaced as an explicit confirmation line so a
  // cashier can verify at a glance they assigned the order to the right table.
  const selectedTable =
    tableOptions.find((o) => String(o.pos_table_number) === tableNumber) ?? null;
  const selectedTableLabel =
    selectedTable?.label ?? (tableNumber ? `Table ${tableNumber}` : null);
  const overCapacity = selectedTable != null && guestCount > selectedTable.capacity_max;

  // Everything that must be true before a sale can be charged. Discount, guest
  // count, and Owner's Request are deliberately not here -- they're optional.
  const chargeBlockers = useMemo(() => {
    const b: string[] = [];
    if (cart.length === 0) b.push('Add at least one item');
    if (orderType === 'dine_in' && !tableNumber.trim()) b.push('Pick a table');
    if (tableBlocked) b.push('Table is reserved — manager override required');
    if (!paymentMethod) b.push('Select a payment method');
    if (paymentMethod === 'card' && !cardType) b.push('Select debit or credit');
    return b;
  }, [cart.length, orderType, tableNumber, tableBlocked, paymentMethod, cardType]);

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

  // Category strip is a fixed 2-row, non-scrolling tap area (same posture as
  // the WS-1 product grid). Pill widths vary by label length, so columns
  // can't be measured off a fixed tile width like the product grid -- instead
  // a hidden, zero-height clone of the full pill list is rendered at the same
  // width to let the browser's own flex-wrap tell us which row each pill
  // lands on, then rows are paged two at a time.
  const pillRowRef = useRef<HTMLDivElement>(null);
  const pillButtonRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const [pillPageByCategory, setPillPageByCategory] = useState<Record<string, number>>({});
  const [pillPage, setPillPage] = useState(0);

  useEffect(() => {
    const container = pillRowRef.current;
    if (!container) return;
    const compute = () => {
      const rowTops: number[] = [];
      const pageOf: Record<string, number> = {};
      for (const cat of pillCategories) {
        const el = pillButtonRefs.current.get(cat);
        if (!el) continue;
        const top = el.offsetTop;
        let rowIndex = rowTops.findIndex((t) => Math.abs(t - top) < 4);
        if (rowIndex === -1) {
          rowTops.push(top);
          rowIndex = rowTops.length - 1;
        }
        pageOf[cat] = Math.floor(rowIndex / 2);
      }
      setPillPageByCategory(pageOf);
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(container);
    return () => ro.disconnect();
  }, [pillCategories]);

  useEffect(() => {
    setPillPage(0);
  }, [pillCategories]);

  const pillMaxPage = Math.max(0, ...Object.values(pillPageByCategory));
  const clampedPillPage = Math.min(pillPage, pillMaxPage);
  const visiblePillCategories = pillCategories.filter(
    (cat) => (pillPageByCategory[cat] ?? 0) === clampedPillPage
  );

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

  const gridPageSize = gridCols * 2;
  const gridMaxPage = Math.max(0, Math.ceil(visibleProducts.length / gridPageSize) - 1);
  const clampedGridPage = Math.min(gridPage, gridMaxPage);
  const pagedGridProducts = useMemo(
    () => visibleProducts.slice(clampedGridPage * gridPageSize, clampedGridPage * gridPageSize + gridPageSize),
    [visibleProducts, clampedGridPage, gridPageSize]
  );

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
  const previewTax = selectedDiscount?.vat_exempt || vatOverride === 'non_vat' ? 0 : previewTaxable * vatRate;
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
    setOwnerRequestConfirmed({
      ...ownerRequestForm,
      employeeNumber: ownerRequestForm.employeeNumber.trim(),
      pin: ownerRequestForm.pin.trim(),
    });
    setOwnerRequestOpen(false);
  }

  async function submitTableOverride() {
    if (!overrideForm.employeeNumber || !overrideForm.pin || !overrideForm.reason.trim()) {
      toast.error('Employee number, PIN, and a reason are required');
      return;
    }
    setOverrideBusy(true);
    try {
      const { override_id } = await overrideTableBlock({
        table_number: Number(tableNumber),
        employee_number: overrideForm.employeeNumber.trim(),
        pin: overrideForm.pin.trim(),
        reason: overrideForm.reason.trim(),
      });
      setOverrideId(override_id);
      setOverrideOpen(false);
      setOverrideForm({ employeeNumber: '', pin: '', reason: '' });
      toast.success('Reservation override applied');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Override failed');
    } finally {
      setOverrideBusy(false);
    }
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
    setVatOverride('vat');
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
    if (chargeBlockers.length > 0) {
      toast.error(`Can't charge yet: ${chargeBlockers[0]}`);
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
        payment_method: paymentMethod ?? undefined, // guaranteed set past chargeBlockers
        card_type: cardType ?? undefined,
        force_vat_exempt: vatOverride === 'non_vat',
        reservation_override_id: overrideId ?? undefined,
        reservation_id: orderType === 'dine_in' ? reservationId ?? undefined : undefined,
      });
      toast.success(
        `${transaction.order_number != null ? `Order #${transaction.order_number} -- ` : ''}Sale complete -- total ${formatCurrency(
          transaction.total_amount
        )} (discount ${formatCurrency(transaction.discount_amount)}, tax ${formatCurrency(transaction.tax_amount)})`
      );
      clearOrder();
      setTableNumber('');
      setTableStatus(null);
      setOverrideId(null);
      setReservationId(null);
      setPaymentMethod(null);
      setCardType(null);
      loadTableOptions();
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
        setVatOverride('vat');
        setTableNumber('');
        setPaymentMethod(null);
        setCardType(null);
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

  // WS-13: Business Day cycle -- one button, two modes, rendered in the
  // header beside "Synced" (via DashboardLayout's headerExtra) instead of
  // floating over the POS canvas.
  const businessDayButton = businessDay?.is_open ? (
    <Button variant="destructive" size="sm" className="gap-2" onClick={() => setEndDayOpen(true)}>
      <Square className="w-4 h-4" /> End Business Day
    </Button>
  ) : (
    <Button size="sm" className="gap-2" onClick={() => setStartDayOpen(true)} disabled={businessDayLoading}>
      <Play className="w-4 h-4" /> Start Business Day
    </Button>
  );

  return (
    <DashboardLayout title="POS Terminal" headerExtra={businessDayButton}>
      <div className="relative flex h-full overflow-hidden">
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
          <div className="mb-3">
            {/* Hidden measuring clone -- full pill list, real classes, clipped
                to zero height so flex-wrap still lays it out at the visible
                container's width without taking any visual space. */}
            <div ref={pillRowRef} className="flex flex-wrap gap-2 h-0 overflow-hidden invisible" aria-hidden="true">
              {pillCategories.map((cat) => (
                <button
                  key={cat}
                  ref={(el) => {
                    if (el) pillButtonRefs.current.set(cat, el);
                  }}
                  type="button"
                  tabIndex={-1}
                  className="shrink-0 px-6 py-3.5 rounded-full text-base font-semibold border-2"
                >
                  {cat === 'Favorites' && <Star className="inline w-3.5 h-3.5 mr-1 -mt-0.5" />}
                  {cat}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              {visiblePillCategories.map((cat) => (
                <button
                  key={cat}
                  type="button"
                  onClick={() => setSelectedCategory(cat)}
                  className={`shrink-0 px-6 py-3.5 rounded-full text-base font-semibold border-2 transition-colors ${
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
            {pillMaxPage > 0 && (
              <div className="flex items-center justify-center gap-3 mt-2">
                <Button
                  size="icon"
                  variant="outline"
                  className="h-9 w-9"
                  disabled={clampedPillPage === 0}
                  onClick={() => setPillPage((p) => Math.max(0, p - 1))}
                  aria-label="Previous categories"
                >
                  <ChevronLeft className="w-4 h-4" />
                </Button>
                <span className="text-xs text-muted-foreground">
                  Page {clampedPillPage + 1} / {pillMaxPage + 1}
                </span>
                <Button
                  size="icon"
                  variant="outline"
                  className="h-9 w-9"
                  disabled={clampedPillPage === pillMaxPage}
                  onClick={() => setPillPage((p) => Math.min(pillMaxPage, p + 1))}
                  aria-label="Next categories"
                >
                  <ChevronRight className="w-4 h-4" />
                </Button>
              </div>
            )}
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
          ) : viewMode === 'list' ? (
            <div className="flex flex-col gap-2">
              {visibleProducts.map((product) => {
                const cheapest = [...product.sizes].sort((a, b) => a.price - b.price)[0];
                const allUnavailable = product.sizes.every((s) => s.availability === 'unavailable');
                const priceLabel = cheapest ? formatCurrency(cheapest.price) : '';
                return (
                  <Card
                    key={product.id}
                    className={`cursor-pointer transition hover:border-primary ${allUnavailable ? 'opacity-50' : ''}`}
                    onClick={() => !allUnavailable && handleProductClick(product)}
                  >
                    <CardContent className="py-3 flex items-center gap-3">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-menu-title font-bold truncate">{product.name}</p>
                        <p className="text-xs font-light text-muted-foreground">{product.category}</p>
                        <div className="flex items-center gap-2 mt-0.5">
                          <span className="text-sm font-semibold">{priceLabel}</span>
                          {product.is_bundle && <Badge variant="gold">Bundle</Badge>}
                          {allUnavailable && <Badge variant="destructive">Unavailable</Badge>}
                        </div>
                      </div>
                      <button
                        type="button"
                        className="shrink-0 p-1 rounded-full hover:bg-accent"
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
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          ) : (
            <div>
              <div
                ref={productGridRef}
                className="grid gap-3"
                style={{ gridTemplateColumns: `repeat(${gridCols}, minmax(0, 1fr))` }}
              >
                {pagedGridProducts.map((product) => {
                  const cheapest = [...product.sizes].sort((a, b) => a.price - b.price)[0];
                  const allUnavailable = product.sizes.every((s) => s.availability === 'unavailable');
                  const priceLabel = cheapest ? formatCurrency(cheapest.price) : '';
                  return (
                    <Card
                      key={product.id}
                      className={`cursor-pointer transition hover:border-primary relative ${
                        allUnavailable ? 'opacity-50' : ''
                      }`}
                      onClick={() => !allUnavailable && handleProductClick(product)}
                    >
                      <button
                        type="button"
                        className="absolute top-1 right-1 z-10 p-1 rounded-full bg-background/80"
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
                      <CardHeader className="pb-2 pt-4">
                        <CardTitle className="text-sm font-menu-title font-bold pr-6">{product.name}</CardTitle>
                      </CardHeader>
                      <CardContent className="pb-4 space-y-1">
                        <p className="text-xs font-light text-muted-foreground">{product.category}</p>
                        <p className="text-base font-semibold">{priceLabel}</p>
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
              {gridMaxPage > 0 && (
                <div className="flex items-center justify-center gap-3 mt-3">
                  <Button
                    size="icon"
                    variant="outline"
                    className="h-10 w-10"
                    disabled={clampedGridPage === 0}
                    onClick={() => setGridPage((p) => Math.max(0, p - 1))}
                    aria-label="Previous page"
                  >
                    <ChevronLeft className="w-4 h-4" />
                  </Button>
                  <span className="text-sm text-muted-foreground">
                    Page {clampedGridPage + 1} / {gridMaxPage + 1}
                  </span>
                  <Button
                    size="icon"
                    variant="outline"
                    className="h-10 w-10"
                    disabled={clampedGridPage === gridMaxPage}
                    onClick={() => setGridPage((p) => Math.min(gridMaxPage, p + 1))}
                    aria-label="Next page"
                  >
                    <ChevronRight className="w-4 h-4" />
                  </Button>
                </div>
              )}
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
          {orderType === 'dine_in' && (
            <Select value={tableNumber} onValueChange={setTableNumber}>
              <SelectTrigger className="w-full h-8 text-sm font-bold bg-red-600 text-white border-red-600 hover:bg-red-700 focus:ring-red-600">
                <SelectValue placeholder="Pick a table" />
              </SelectTrigger>
              <SelectContent>
                {tableOptions.length === 0 && (
                  <SelectItem value="__none" disabled>
                    No tables
                  </SelectItem>
                )}
                {tableOptions.map((o) => {
                  const seats =
                    o.capacity_min && o.capacity_min !== o.capacity_max
                      ? `${o.capacity_min}–${o.capacity_max}`
                      : `${o.capacity_max}`;
                  const status = o.occupied ? ' · Occupied' : o.reserved ? ' · Reserved' : '';
                  return (
                    <SelectItem key={o.pos_table_number} value={String(o.pos_table_number)} disabled={o.occupied}>
                      {o.label} · seats {seats}
                      {status}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          )}
          {orderType === 'dine_in' && (
            selectedTableLabel ? (
              <div
                className={`flex items-center gap-2 rounded-md border p-2 text-xs ${
                  overCapacity
                    ? 'border-amber-300 bg-amber-50 text-amber-800'
                    : 'border-green-300 bg-green-50 text-green-800'
                }`}
              >
                {overCapacity ? (
                  <AlertTriangle className="h-4 w-4 shrink-0" />
                ) : (
                  <CheckCircle2 className="h-4 w-4 shrink-0" />
                )}
                <span>
                  Seated at <span className="font-semibold">{selectedTableLabel}</span>
                  {selectedTable ? ` · ${selectedTable.capacity_max} seats · ${guestCount} guests` : ''}
                  {overCapacity ? ' — over capacity' : ''}
                </span>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">Pick a table to assign this order.</p>
            )
          )}
          {orderType === 'dine_in' && tableStatus?.blocked && tableStatus.reservation && (
            <div
              className={`rounded-md border p-2 text-xs ${
                overrideId
                  ? 'border-amber-300 bg-amber-50 text-amber-800'
                  : 'border-destructive/40 bg-destructive/10 text-destructive'
              }`}
            >
              {overrideId ? (
                <p>Override applied -- seating on reserved table {tableStatus.pos_table_number}.</p>
              ) : (
                <div className="flex items-center justify-between gap-2">
                  <span>
                    Table {tableStatus.pos_table_number} is reserved for {tableStatus.reservation.customer_name} (party
                    of {tableStatus.reservation.party_size}) until {tableStatus.reservation.end_time.slice(0, 5)}.
                  </span>
                  <Button size="sm" variant="outline" className="h-7 shrink-0" onClick={() => setOverrideOpen(true)}>
                    Override
                  </Button>
                </div>
              )}
            </div>
          )}
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            {orderType === 'dine_in' ? (
              <>
                <Users className="w-4 h-4" />
                <span>Dine In</span>
                {selectedTableLabel && (
                  <Badge variant="secondary" className="font-normal">
                    {selectedTableLabel}
                  </Badge>
                )}
                <div className="ml-auto flex items-center gap-2">
                  <Button
                    size="icon"
                    variant="outline"
                    className="h-10 w-10"
                    onClick={() => setGuestCount((g) => Math.max(1, g - 1))}
                  >
                    -
                  </Button>
                  <span className="w-4 text-center">{guestCount}</span>
                  <Button size="icon" variant="outline" className="h-10 w-10" onClick={() => setGuestCount((g) => g + 1)}>
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
                      <Button size="icon" variant="outline" className="h-10 w-10" onClick={() => updateQuantity(line.key, -1)}>
                        -
                      </Button>
                      <span>{line.quantity}</span>
                      <Button size="icon" variant="outline" className="h-10 w-10" onClick={() => updateQuantity(line.key, 1)}>
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
                                    className="h-10 w-10"
                                    onClick={() => setLineAddonQuantity(line.key, addon, current - 1)}
                                    disabled={current === 0}
                                  >
                                    -
                                  </Button>
                                  <span className="w-4 text-center">{current}</span>
                                  <Button
                                    size="icon"
                                    variant="outline"
                                    className="h-10 w-10"
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
                    className={`px-4 py-2 rounded-full text-xs border transition-colors ${
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
              <Label className="text-xs">VAT</Label>
              <div className="grid grid-cols-2 gap-2 mt-1">
                {(['vat', 'non_vat'] as const).map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setVatOverride(v)}
                    className={`text-sm py-2 rounded border ${
                      vatOverride === v
                        ? 'bg-primary text-primary-foreground border-transparent'
                        : 'bg-card text-muted-foreground border-border'
                    }`}
                  >
                    {v === 'vat' ? 'VAT' : 'Non-VAT'}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <Label className="text-xs">
                Payment Method <span className="text-destructive">*</span>
              </Label>
              <div
                className={`grid grid-cols-3 gap-2 mt-1 ${
                  cart.length > 0 && !paymentMethod ? 'rounded ring-1 ring-destructive/50 p-1' : ''
                }`}
              >
                {(['cash', 'gcash', 'card'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => {
                      if (paymentMethod === m) {
                        setPaymentMethod(null);
                        setCardType(null);
                        return;
                      }
                      if (m === 'card') {
                        setCardTypePromptOpen(true);
                        return;
                      }
                      setPaymentMethod(m);
                      setCardType(null);
                    }}
                    className={`text-sm py-3 rounded border capitalize ${
                      paymentMethod === m
                        ? 'bg-primary text-primary-foreground border-transparent'
                        : 'bg-card text-muted-foreground border-border'
                    }`}
                  >
                    {m}
                    {m === 'card' && paymentMethod === 'card' && cardType && (
                      <span className="block text-[10px] font-normal capitalize opacity-90">{cardType}</span>
                    )}
                  </button>
                ))}
              </div>
              {cart.length > 0 && !paymentMethod && (
                <p className="mt-1 text-xs text-destructive">Required before charging.</p>
              )}
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

            {cart.length > 0 && chargeBlockers.length > 0 && (
              <p className="text-xs text-muted-foreground">
                Before charging: {chargeBlockers.join(' · ')}
              </p>
            )}
            <Button
              className="w-full"
              size="lg"
              disabled={submitting || chargeBlockers.length > 0}
              onClick={handleCharge}
            >
              {submitting
                ? 'Charging...'
                : chargeBlockers.length > 0
                  ? chargeBlockers[0]
                  : 'Charge'}
            </Button>
          </div>
        </div>

        {user?.role !== 'executive' && !businessDayLoading && !businessDay?.is_open && (
          <div className="absolute inset-0 z-20 bg-background/85 backdrop-blur-sm flex items-center justify-center">
            <div className="text-center max-w-sm px-6">
              <Lock className="w-8 h-8 mx-auto mb-3 text-muted-foreground" />
              <p className="font-corp-display font-semibold mb-1">Business day not started</p>
              <p className="text-sm text-muted-foreground">
                Press "Start Business Day" above to unlock the POS.
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Start Business Day -- ID+PIN, then a menu-availability acknowledgement */}
      <Dialog open={startDayOpen} onOpenChange={(open) => !open && resetStartDayDialog()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Start Business Day</DialogTitle>
            <DialogDescription>
              {startDayStep === 'credentials'
                ? 'Confirm your own kiosk credentials to start today.'
                : 'Are all items available and up to date on today\'s menu?'}
            </DialogDescription>
          </DialogHeader>
          {startDayStep === 'credentials' ? (
            <>
              <div className="space-y-3">
                <div>
                  <Label>Employee number</Label>
                  <Input
                    value={startDayForm.employeeNumber}
                    onChange={(e) => setStartDayForm({ ...startDayForm, employeeNumber: e.target.value })}
                  />
                </div>
                <div>
                  <Label>PIN</Label>
                  <Input
                    type="password"
                    value={startDayForm.pin}
                    onChange={(e) => setStartDayForm({ ...startDayForm, pin: e.target.value })}
                  />
                </div>
              </div>
              <DialogFooter>
                <Button
                  onClick={() => {
                    if (!startDayForm.employeeNumber || !startDayForm.pin) {
                      toast.error('Employee number and PIN are required');
                      return;
                    }
                    setStartDayStep('menu-check');
                  }}
                >
                  Continue
                </Button>
              </DialogFooter>
            </>
          ) : (
            <DialogFooter className="flex-col sm:flex-col gap-2">
              <Button
                variant="outline"
                className="w-full gap-2"
                disabled={startDaySubmitting}
                onClick={() => {
                  resetStartDayDialog();
                  navigate('/menu-editing');
                }}
              >
                No -- go to Menu Editing
              </Button>
              <Button
                className="w-full"
                disabled={startDaySubmitting}
                onClick={() => submitStartDay(true)}
              >
                {startDaySubmitting ? 'Starting...' : 'Yes, start business day'}
              </Button>
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>

      {/* End Business Day -- cash-register total first, then ID+PIN. The
          cashier never sees the system's own EOD total at any point here. */}
      <Dialog open={endDayOpen} onOpenChange={(open) => !open && resetEndDayDialog()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>End Business Day</DialogTitle>
            <DialogDescription>
              {endDayStep === 'register-total'
                ? 'Enter the physically counted cash register total.'
                : 'Confirm your own kiosk credentials to close today.'}
            </DialogDescription>
          </DialogHeader>
          {endDayStep === 'register-total' ? (
            <>
              <div>
                <Label>Cash register total</Label>
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  value={endDayForm.cashRegisterTotal}
                  onChange={(e) => setEndDayForm({ ...endDayForm, cashRegisterTotal: e.target.value })}
                />
              </div>
              <DialogFooter>
                <Button
                  onClick={() => {
                    const total = Number(endDayForm.cashRegisterTotal);
                    if (!Number.isFinite(total) || total < 0) {
                      toast.error('Enter the counted cash register total');
                      return;
                    }
                    setEndDayStep('credentials');
                  }}
                >
                  Continue
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <div className="space-y-3">
                <div>
                  <Label>Employee number</Label>
                  <Input
                    value={endDayForm.employeeNumber}
                    onChange={(e) => setEndDayForm({ ...endDayForm, employeeNumber: e.target.value })}
                  />
                </div>
                <div>
                  <Label>PIN</Label>
                  <Input
                    type="password"
                    value={endDayForm.pin}
                    onChange={(e) => setEndDayForm({ ...endDayForm, pin: e.target.value })}
                  />
                </div>
              </div>
              <DialogFooter>
                <Button onClick={submitEndDay} disabled={endDaySubmitting}>
                  {endDaySubmitting ? 'Closing...' : 'Confirm and close day'}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* WS-13: explains the 403 mismatch instead of a generic toast --
          see handleBusinessDayError above. */}
      <Dialog open={credentialMismatchOpen} onOpenChange={setCredentialMismatchOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Employee ID doesn't match your login</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 text-sm">
            <p>
              You're currently logged into the dashboard as{' '}
              <strong>{user?.name}</strong>
              {user?.employeeNumber ? ` (${user.employeeNumber})` : ''}.
            </p>
            <p>
              Start/End Business Day only accepts <strong>this same account's</strong> Employee
              Number and PIN -- not any valid employee's credentials. The number and PIN you just
              entered belong to a different account.
            </p>
            <p className="text-muted-foreground">
              If you meant to use a different employee's credentials, log out and log back into
              the dashboard as that employee first, then try Start/End Business Day again.
            </p>
          </div>
          <DialogFooter>
            <Button onClick={() => setCredentialMismatchOpen(false)}>Got it</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Debit/Credit prompt -- shown when "Card" is picked as payment method. */}
      <Dialog open={cardTypePromptOpen} onOpenChange={(open) => !open && setCardTypePromptOpen(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Debit or credit?</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            {(['debit', 'credit'] as const).map((t) => (
              <Button
                key={t}
                variant="outline"
                className="w-full capitalize"
                onClick={() => {
                  setCardType(t);
                  setPaymentMethod('card');
                  setCardTypePromptOpen(false);
                }}
              >
                {t}
              </Button>
            ))}
          </div>
        </DialogContent>
      </Dialog>

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

      {/* Reservation override -- manager seats a walk-in on a reserved table */}
      <Dialog open={overrideOpen} onOpenChange={setOverrideOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Override reservation block</DialogTitle>
            <DialogDescription>
              {tableStatus?.reservation
                ? `Table ${tableStatus.pos_table_number} is reserved for ${tableStatus.reservation.customer_name} until ${tableStatus.reservation.end_time.slice(0, 5)}. A manager must re-enter their own kiosk credentials to seat here anyway.`
                : 'A manager must re-enter their own kiosk credentials to seat here anyway.'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Employee number</Label>
              <Input
                value={overrideForm.employeeNumber}
                onChange={(e) => setOverrideForm({ ...overrideForm, employeeNumber: e.target.value })}
              />
            </div>
            <div>
              <Label>PIN</Label>
              <Input
                type="password"
                value={overrideForm.pin}
                onChange={(e) => setOverrideForm({ ...overrideForm, pin: e.target.value })}
              />
            </div>
            <div>
              <Label>Reason</Label>
              <Input
                value={overrideForm.reason}
                onChange={(e) => setOverrideForm({ ...overrideForm, reason: e.target.value })}
              />
            </div>
          </div>
          <DialogFooter>
            <Button onClick={submitTableOverride} disabled={overrideBusy}>
              {overrideBusy ? 'Verifying...' : 'Override and continue'}
            </Button>
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
