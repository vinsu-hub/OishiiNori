import React, { useEffect, useMemo, useState, type CSSProperties } from 'react';
import {
  ArrowRight,
  ChevronDown,
  ChevronLeft,
  Coffee,
  Fish,
  Flame,
  Loader2,
  Menu as MenuIcon,
  Minus,
  Plus,
  Salad,
  Search,
  ShoppingBag,
  Soup,
  Sparkles,
  Truck,
  Users,
  Utensils,
  UtensilsCrossed,
  X,
} from 'lucide-react';
import {
  ApiAddon,
  ApiOnlinePaymentMethod,
  ApiProduct,
  ApiProductSize,
  ApiRecipeItem,
  DeliveryFee,
  DigitalOrderStatus,
  OrderChannel,
  PaymentMethod,
  fetchAddons,
  fetchDeliveryFees,
  fetchMenu,
  fetchOrderStatus,
  fetchPaymentMethods,
  fetchRecipe,
  submitOrder,
  uploadProofOfPayment,
} from '@/lib/api';
import ReservationView from '@/components/ReservationView';
import { isValidPhilippinePhone, PH_PHONE_HINT } from '@/lib/validators';

declare global {
  interface Window {
    toast?: (message: string, type?: 'success' | 'error' | 'info') => void;
  }
}

function toast(message: string, type: 'success' | 'error' | 'info' = 'info') {
  window.toast?.(message, type);
}

function peso(value: number) {
  return `₱${value.toLocaleString('en-PH', { minimumFractionDigits: 2 })}`;
}

function categoryIcon(category: string) {
  const c = category.toLowerCase();
  if (c.includes('ramen')) return Soup;
  if (c.includes('cafe')) return Coffee;
  if (c.includes('salad')) return Salad;
  if (c.includes('torched')) return Flame;
  if (c.includes('maki') || c.includes('roll')) return Fish;
  if (c.includes('rice')) return UtensilsCrossed;
  if (c.includes('platter') || c.includes('boat') || c.includes('bundle')) return Users;
  return Utensils;
}

function categoryJp(category: string) {
  const c = category.toLowerCase();
  if (c.includes('sushi')) return '鮨';
  if (c.includes('ramen')) return '麺';
  if (c.includes('cafe')) return '喫茶';
  if (c.includes('salad')) return 'サラダ';
  if (c.includes('rice')) return 'ご飯';
  if (c.includes('maki') || c.includes('roll')) return '巻き';
  if (c.includes('platter') || c.includes('bundle')) return '盛り合わせ';
  if (c.includes('torched')) return '炙り';
  return '';
}

interface CartLine {
  key: string; // product_size_id
  product: ApiProduct;
  size: ApiProductSize;
  quantity: number;
  held: string[];
}

interface AddonLine {
  addon: ApiAddon;
  quantity: number;
}

const STATUS_POLL_MS = 5_000;

export default function App() {
  const [tableNumber] = useState<number | null>(() => {
    const raw = new URLSearchParams(window.location.search).get('table');
    const n = raw ? parseInt(raw, 10) : NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
  });
  // ?reserve=1 is the landing page's deep-link into the reservation flow --
  // skips this welcome/choice screen entirely so "Reserve now" there is a
  // true one-click portal, not a redirect-then-click-again.
  const [landingMode, setLandingMode] = useState<'choice' | 'reserve' | 'order-channel'>(() =>
    new URLSearchParams(window.location.search).get('reserve') === '1' ? 'reserve' : 'choice'
  );
  // WS-7 (Phase 6): the general (non-table) link -- no ?table= param --
  // lets the visitor choose Delivery or Pickup instead of dine-in. `null`
  // means "not yet chosen" (still on the landing screen); dine_in_qr is
  // implicit whenever a real tableNumber is present.
  const [orderChannel, setOrderChannel] = useState<OrderChannel | null>(null);
  const effectiveChannel: OrderChannel | null = tableNumber ? 'dine_in_qr' : orderChannel;

  const [deliveryFees, setDeliveryFees] = useState<DeliveryFee[]>([]);
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [address, setAddress] = useState('');
  const [landmark, setLandmark] = useState('');
  const [barangay, setBarangay] = useState('');

  useEffect(() => {
    if (orderChannel === 'delivery' && deliveryFees.length === 0) {
      fetchDeliveryFees()
        .then(setDeliveryFees)
        .catch(() => {
          // The barangay dropdown just stays empty -- handlePlaceOrder's own
          // validation (barangay required for delivery) still blocks
          // checkout, so this doesn't silently let an unpriced order through.
        });
    }
  }, [orderChannel, deliveryFees.length]);

  const selectedFee = deliveryFees.find((f) => f.barangay === barangay)?.fee ?? null;

  const [products, setProducts] = useState<ApiProduct[]>([]);
  const [addonCatalog, setAddonCatalog] = useState<ApiAddon[]>([]);
  const [loadingMenu, setLoadingMenu] = useState(true);
  const [recipeCache, setRecipeCache] = useState<Record<string, ApiRecipeItem[]>>({});

  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [cart, setCart] = useState<CartLine[]>([]);
  const [addons, setAddons] = useState<AddonLine[]>([]);
  const [cartOpen, setCartOpen] = useState(false);
  const [itemOpen, setItemOpen] = useState<ApiProduct | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [language, setLanguage] = useState<'EN' | '日本語'>('EN');
  const [customizeMode, setCustomizeMode] = useState(false);
  const [editingLine, setEditingLine] = useState<CartLine | null>(null);
  const [draftHeld, setDraftHeld] = useState<string[]>([]);

  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod | null>(null);
  // Online payment verification (delivery/pickup only): choosing an
  // e-wallet/bank-transfer method shows its QR/account details, then an
  // upload-proof step, before the order actually submits. Cash and the
  // dine-in QR flow (waiter-mediated, unchanged) skip this entirely.
  const [onlinePaymentMethods, setOnlinePaymentMethods] = useState<ApiOnlinePaymentMethod[]>([]);
  const [selectedOnlineMethod, setSelectedOnlineMethod] = useState<ApiOnlinePaymentMethod | null>(null);
  const [checkoutStage, setCheckoutStage] = useState<'form' | 'qr' | 'upload'>('form');
  const [proofFile, setProofFile] = useState<File | null>(null);
  const [proofPreviewUrl, setProofPreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    if (effectiveChannel && effectiveChannel !== 'dine_in_qr' && onlinePaymentMethods.length === 0) {
      fetchPaymentMethods()
        .then(setOnlinePaymentMethods)
        .catch(() => {
          // Cash stays available either way -- an online method just won't
          // show up as an option if this fails.
        });
    }
  }, [effectiveChannel, onlinePaymentMethods.length]);
  const [customerNote, setCustomerNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [order, setOrder] = useState<DigitalOrderStatus | null>(null);

  useEffect(() => {
    Promise.all([fetchMenu(), fetchAddons()])
      .then(([p, a]) => {
        setProducts(p);
        setAddonCatalog(a);
        if (p.length > 0) setActiveCategory(p[0].category);
      })
      .catch((e) => toast(e instanceof Error ? e.message : 'Failed to load menu', 'error'))
      .finally(() => setLoadingMenu(false));
  }, []);

  useEffect(() => {
    if (!order || order.status !== 'pending') return;
    const interval = setInterval(() => {
      fetchOrderStatus(order.id)
        .then(setOrder)
        .catch(() => {});
    }, STATUS_POLL_MS);
    return () => clearInterval(interval);
  }, [order]);

  const sizeIndex = useMemo(() => {
    const map = new Map<string, { product: ApiProduct; size: ApiProductSize }>();
    for (const p of products) {
      for (const size of p.sizes) map.set(size.id, { product: p, size });
    }
    return map;
  }, [products]);

  const categories = useMemo(() => {
    const seen = new Map<string, { id: string; label: string; jp: string; icon: typeof Utensils }>();
    for (const p of products) {
      if (!seen.has(p.category)) {
        seen.set(p.category, { id: p.category, label: p.category, jp: categoryJp(p.category), icon: categoryIcon(p.category) });
      }
    }
    return [...seen.values()];
  }, [products]);

  const sections = useMemo(() => {
    const byCategory = new Map<string, ApiProduct[]>();
    for (const p of products) {
      const list = byCategory.get(p.category) || [];
      list.push(p);
      byCategory.set(p.category, list);
    }
    return categories.map((c) => ({ ...c, items: byCategory.get(c.id) || [] }));
  }, [categories, products]);

  const filteredSections = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return sections.filter((s) => s.id === activeCategory);
    return sections
      .map((s) => ({ ...s, items: s.items.filter((item) => item.name.toLowerCase().includes(needle)) }))
      .filter((s) => s.items.length > 0);
  }, [sections, query, activeCategory]);

  function getRecipe(sizeId: string): ApiRecipeItem[] {
    return recipeCache[sizeId] || [];
  }

  function ensureRecipeLoaded(sizeId: string) {
    if (recipeCache[sizeId]) return;
    fetchRecipe(sizeId)
      .then((items) => setRecipeCache((prev) => ({ ...prev, [sizeId]: items })))
      .catch(() => {});
  }

  function addToCart(product: ApiProduct, size: ApiProductSize) {
    if (size.availability === 'unavailable') {
      toast(`${product.name} (${size.size_label}) is out of stock`, 'error');
      return;
    }
    setCart((prev) => {
      const existing = prev.find((l) => l.key === size.id);
      if (existing) return prev.map((l) => (l.key === size.id ? { ...l, quantity: l.quantity + 1 } : l));
      return [...prev, { key: size.id, product, size, quantity: 1, held: [] }];
    });
    ensureRecipeLoaded(size.id);
    toast(`Added ${product.name}`, 'success');
  }

  function openItem(product: ApiProduct) {
    const cheapest = [...product.sizes].sort((a, b) => a.price - b.price)[0];
    if (cheapest) ensureRecipeLoaded(cheapest.id);
    setItemOpen(product);
  }

  function updateQuantity(key: string, delta: number) {
    setCart((prev) => prev.map((l) => (l.key === key ? { ...l, quantity: l.quantity + delta } : l)).filter((l) => l.quantity > 0));
  }

  function updateAddon(addon: ApiAddon, delta: number) {
    setAddons((prev) => {
      const existing = prev.find((l) => l.addon.id === addon.id);
      const quantity = (existing?.quantity ?? 0) + delta;
      if (quantity <= 0) return prev.filter((l) => l.addon.id !== addon.id);
      if (existing) return prev.map((l) => (l.addon.id === addon.id ? { ...l, quantity } : l));
      return [...prev, { addon, quantity }];
    });
  }

  function openRecipeEditor(line: CartLine) {
    setCartOpen(false);
    setEditingLine(line);
    setDraftHeld(line.held);
    ensureRecipeLoaded(line.size.id);
  }
  function closeRecipeEditor() {
    setEditingLine(null);
    setDraftHeld([]);
    if (cart.length > 0) setCartOpen(true);
  }
  function saveRecipeEdits() {
    if (!editingLine) return;
    setCart((prev) => prev.map((l) => (l.key === editingLine.key ? { ...l, held: draftHeld } : l)));
    closeRecipeEditor();
  }
  function startOrderEditing() {
    setCustomizeMode(true);
    if (cart[0]) openRecipeEditor(cart[0]);
  }
  function toggleDraftIngredient(name: string) {
    setDraftHeld((prev) => (prev.includes(name) ? prev.filter((v) => v !== name) : [...prev, name]));
  }

  const addonTotal = addons.reduce((sum, l) => sum + l.addon.price * l.quantity, 0);
  const cartSubtotal = cart.reduce((sum, l) => sum + l.size.price * l.quantity, 0);
  const cartTotal = cartSubtotal + addonTotal;
  const cartCount = cart.reduce((sum, l) => sum + l.quantity, 0) + addons.reduce((sum, l) => sum + l.quantity, 0);

  function validateDeliveryPickupForm(): boolean {
    if (!customerName.trim() || !customerPhone.trim()) {
      toast('Name and phone number are required', 'error');
      return false;
    }
    if (!isValidPhilippinePhone(customerPhone)) {
      toast(`Enter a valid Philippine phone number (${PH_PHONE_HINT})`, 'error');
      return false;
    }
    if (effectiveChannel === 'delivery' && (!address.trim() || !barangay)) {
      toast('Address and barangay are required for delivery', 'error');
      return false;
    }
    return true;
  }

  async function submitFinalOrder(method: string) {
    if (!effectiveChannel) return null;
    return submitOrder({
      table_number: tableNumber ?? undefined,
      order_channel: effectiveChannel,
      items: cart.map((l) => ({ product_size_id: l.size.id, quantity: l.quantity, held_ingredients: l.held })),
      addons: addons.map((l) => ({ addon_id: l.addon.id, quantity: l.quantity })),
      payment_method: method,
      customer_note: customerNote.trim() || undefined,
      ...(effectiveChannel !== 'dine_in_qr' && {
        customer_name: customerName.trim(),
        customer_phone: customerPhone.trim(),
        ...(effectiveChannel === 'delivery' && {
          address: address.trim(),
          landmark: landmark.trim() || undefined,
          barangay,
        }),
      }),
    });
  }

  // Main checkout CTA. Cash (any channel) and the dine-in QR flow (waiter-
  // mediated, unchanged) submit immediately. An online payment method on
  // delivery/pickup instead advances to the QR/account-details screen --
  // the order isn't created until proof of payment is uploaded.
  async function handlePlaceOrder() {
    if (!effectiveChannel || !paymentMethod || cart.length === 0) return;
    if (effectiveChannel === 'dine_in_qr' && !tableNumber) return;
    if (effectiveChannel !== 'dine_in_qr' && !validateDeliveryPickupForm()) return;

    if (effectiveChannel !== 'dine_in_qr' && selectedOnlineMethod) {
      setCheckoutStage('qr');
      return;
    }

    setSubmitting(true);
    try {
      const result = await submitFinalOrder(paymentMethod);
      if (!result) return;
      setOrder(result);
      setCartOpen(false);
      setCart([]);
      setAddons([]);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Failed to place order', 'error');
    } finally {
      setSubmitting(false);
    }
  }

  function handleProofFileChange(file: File | null) {
    setProofFile(file);
    setProofPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return file ? URL.createObjectURL(file) : null;
    });
  }

  async function handleSubmitWithProof() {
    if (!selectedOnlineMethod || !proofFile) {
      toast('Attach a screenshot of the transfer first', 'error');
      return;
    }
    setSubmitting(true);
    try {
      const result = await submitFinalOrder(selectedOnlineMethod.name);
      if (!result) return;
      try {
        const withProof = await uploadProofOfPayment(result.id, proofFile);
        setOrder(withProof);
      } catch (uploadError) {
        // The order itself was created successfully -- don't lose it, just
        // surface the upload failure so the customer knows to retry (the
        // order id/proof endpoint stays valid while the order is pending).
        setOrder(result);
        toast(
          uploadError instanceof Error
            ? `Order placed, but the proof upload failed: ${uploadError.message}`
            : 'Order placed, but the proof upload failed',
          'error'
        );
      }
      setCartOpen(false);
      setCart([]);
      setAddons([]);
      setCheckoutStage('form');
      handleProofFileChange(null);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Failed to place order', 'error');
    } finally {
      setSubmitting(false);
    }
  }

  function startNewOrder() {
    setOrder(null);
    setPaymentMethod(null);
    setSelectedOnlineMethod(null);
    setCheckoutStage('form');
    handleProofFileChange(null);
    setCustomerNote('');
  }

  function selectCategory(id: string) {
    setQuery('');
    setActiveCategory(id);
  }

  if (!effectiveChannel) {
    if (landingMode === 'reserve') {
      return <ReservationView onBack={() => setLandingMode('choice')} />;
    }
    if (landingMode === 'order-channel') {
      return (
        <div className="min-h-screen flex items-center justify-center p-4">
          <div className="item-modal" style={{ position: 'static', maxWidth: 380 }}>
            <div className="modal-body" style={{ textAlign: 'center' }}>
              <img src="/logo.jpg" alt="Oishii Nori" className="brand-logo" style={{ width: 64, height: 64, margin: '0 auto 14px' }} />
              <h2>Order Online</h2>
              <p>How would you like to receive your order?</p>
              <button
                className="primary-button"
                type="button"
                style={{ width: '100%', marginTop: 16 }}
                onClick={() => setOrderChannel('delivery')}
              >
                <Truck size={16} /> Delivery
              </button>
              <button
                className="primary-button"
                type="button"
                style={{ width: '100%', marginTop: 10 }}
                onClick={() => setOrderChannel('pickup')}
              >
                <ShoppingBag size={16} /> Pickup
              </button>
              <button
                className="ghost-button"
                type="button"
                style={{ width: '100%', marginTop: 10 }}
                onClick={() => setLandingMode('choice')}
              >
                Back
              </button>
            </div>
          </div>
        </div>
      );
    }
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="item-modal" style={{ position: 'static', maxWidth: 380 }}>
          <div className="modal-body" style={{ textAlign: 'center' }}>
            <img src="/logo.jpg" alt="Oishii Nori" className="brand-logo" style={{ width: 64, height: 64, margin: '0 auto 14px' }} />
            <h2>Welcome to Oishii Nori</h2>
            <p>Scan the QR code on your table to order, reserve a table for later, or order delivery/pickup.</p>
            <button
              className="primary-button"
              type="button"
              style={{ width: '100%', marginTop: 16 }}
              onClick={() => setLandingMode('order-channel')}
            >
              Order Delivery / Pickup <ArrowRight size={16} />
            </button>
            <button
              className="ghost-button"
              type="button"
              style={{ width: '100%', marginTop: 10 }}
              onClick={() => setLandingMode('reserve')}
            >
              Reserve a Table <ArrowRight size={16} />
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="menu-shell">
      <header className="site-header">
        <div className="header-inner">
          <a className="brand-lockup" href="#top" aria-label="Oishii Nori home">
            <img src="/logo.jpg" alt="Oishii Nori logo" className="brand-logo" />
            <span className="brand-copy">
              <strong>Oishii Nori</strong>
              <small>
                {effectiveChannel === 'delivery'
                  ? 'Delivery'
                  : effectiveChannel === 'pickup'
                    ? 'Pickup'
                    : `Table ${tableNumber}`}{' '}
                · simple. fresh. Japanese.
              </small>
            </span>
          </a>
          <div className="header-actions">
            <button
              className="language-button"
              type="button"
              aria-label="Change language"
              onClick={() => setLanguage((c) => (c === 'EN' ? '日本語' : 'EN'))}
            >
              <span>◎</span> {language} <ChevronDown size={15} />
            </button>
            <button
              className="icon-button menu-button"
              type="button"
              aria-label={menuOpen ? 'Close menu' : 'Open menu'}
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((o) => !o)}
            >
              <MenuIcon size={23} />
            </button>
          </div>
        </div>
      </header>

      {order ? (
        <main id="top" className="order-status-main">
          <OrderStatusView order={order} onNewOrder={startNewOrder} resolveItem={(sizeId) => sizeIndex.get(sizeId)} />
        </main>
      ) : (
        <main id="top">
          <section className="hero" aria-label="Oishii Nori introduction">
            <div className="hero-copy">
              <p className="eyebrow">
                <span className="seal-dot" /> OISHII NORI ·{' '}
                {effectiveChannel === 'delivery' ? 'DELIVERY' : effectiveChannel === 'pickup' ? 'PICKUP' : `TABLE ${tableNumber}`}
              </p>
              <h1>
                Simple.
                <br />
                <em>Fresh.</em>
                <br />
                Japanese.
              </h1>
              <p className="hero-note">
                Find your next favorite bite,
                <br />
                then make room for one more.
              </p>
            </div>
            <div className="hero-jp" aria-hidden="true">美味しい</div>
            <div className="hero-stamp">
              おいしい
              <br />
              <span>nori</span>
            </div>
          </section>

          <section className="menu-intro">
            <div>
              <p className="eyebrow ink-eyebrow">
                THE MENU <span>· お品書き</span>
              </p>
              <h2>
                Choose your
                <br />
                <em>comfort.</em>
              </h2>
            </div>
            <div className="intro-side">
              <span className="vertical-kana">一緒に食べよう</span>
              <p>Made for long lunches, late cravings, and tables that keep ordering.</p>
            </div>
          </section>

          <div className="category-wrap">
            <nav className="category-rail" aria-label="Menu categories">
              {categories.map(({ id, label, jp, icon: Icon }) => (
                <button
                  key={id}
                  className={`category-tab ${activeCategory === id && !query ? 'is-active' : ''}`}
                  onClick={() => selectCategory(id)}
                  type="button"
                >
                  <Icon size={19} strokeWidth={1.7} />
                  <span>{label}</span>
                  {jp && <small>{jp}</small>}
                </button>
              ))}
            </nav>
          </div>

          <section className="search-band">
            <div className="search-box">
              <Search size={17} />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search the menu" aria-label="Search the menu" />
              {query && (
                <button type="button" aria-label="Clear search" onClick={() => setQuery('')}>
                  <X size={15} />
                </button>
              )}
            </div>
            <span className="search-note">
              {query ? `${filteredSections.reduce((n, s) => n + s.items.length, 0)} found` : 'Tap a dish for details'}
            </span>
          </section>

          {loadingMenu ? (
            <div className="empty-state">
              <Loader2 size={20} className="animate-spin" />
              <p>Loading menu...</p>
            </div>
          ) : (
            <div className="sections">
              {filteredSections.map((section) => (
                <section className="menu-section" id={section.id} key={section.id}>
                  <div className="section-heading">
                    <div>
                      <p className="section-kicker">
                        <span className="seal-dot" /> {section.jp ? `${section.jp} · ` : ''}
                        {section.label.toUpperCase()}
                      </p>
                      <h3>{section.label}</h3>
                    </div>
                  </div>
                  <div className="item-list">
                    {section.items.map((item, index) => {
                      const cheapest = [...item.sizes].sort((a, b) => a.price - b.price)[0];
                      const allUnavailable = item.sizes.every((s) => s.availability === 'unavailable');
                      return (
                        <article
                          className="menu-item"
                          key={item.id}
                          style={{ '--delay': `${index * 35}ms` } as CSSProperties}
                        >
                          <button className="item-main" type="button" onClick={() => openItem(item)} disabled={allUnavailable}>
                            {item.image_path ? (
                              <img src={item.image_path} alt="" className="item-thumb" />
                            ) : (
                              <div className="item-index">{String(index + 1).padStart(2, '0')}</div>
                            )}
                            <div className="item-copy">
                              <div className="item-title-row">
                                <h4>{item.name}</h4>
                                {item.is_bundle && <span className="item-tag">Bundle</span>}
                                {allUnavailable && <span className="item-tag item-tag-unavailable">Unavailable</span>}
                              </div>
                              <p>{item.sizes.length > 1 ? `${item.sizes.length} sizes available` : ' '}</p>
                            </div>
                            <strong className="item-price">
                              {item.sizes.length > 1 ? `from ${peso(cheapest?.price ?? 0)}` : peso(cheapest?.price ?? 0)}
                            </strong>
                            <ChevronLeft className="item-chevron" size={19} />
                          </button>
                          {item.sizes.length === 1 && (
                            <button
                              className="add-button"
                              type="button"
                              disabled={allUnavailable}
                              onClick={() => addToCart(item, item.sizes[0])}
                              aria-label={`Add ${item.name} to order`}
                            >
                              <Plus size={17} />
                            </button>
                          )}
                        </article>
                      );
                    })}
                  </div>
                </section>
              ))}
              {filteredSections.length === 0 && (
                <div className="empty-state">
                  <Sparkles size={20} />
                  <p>No dishes found yet.</p>
                  <button type="button" onClick={() => setQuery('')}>
                    Return to the full menu
                  </button>
                </div>
              )}
            </div>
          )}

          <section className="about-band">
            <div className="about-line" />
            <div>
              <p className="eyebrow">A LITTLE NOTE · 小さな話</p>
              <h2>
                Good food
                <br />
                <em>takes its time.</em>
              </h2>
            </div>
            <p>
              From baked sushi to a bowl of ramen, Oishii Nori is made for the satisfying in-between: a familiar favorite, a new
              discovery, and the extra order you didn't plan on.
            </p>
          </section>
        </main>
      )}

      {!order && (
        <button className={`cart-bar ${cartCount ? 'has-items' : ''}`} type="button" onClick={() => setCartOpen(true)} aria-label="View order">
          <span className="cart-icon">
            <ShoppingBag size={18} />
          </span>
          <span className="cart-label">{cartCount ? `${cartCount} item${cartCount > 1 ? 's' : ''} · view order` : 'View order'}</span>
          <strong>{cartCount ? peso(cartTotal) : '0'}</strong>
        </button>
      )}

      {itemOpen && (
        <ItemModal
          product={itemOpen}
          recipeFor={(sizeId) => getRecipe(sizeId)}
          onClose={() => setItemOpen(null)}
          onAdd={(size) => {
            addToCart(itemOpen, size);
            setItemOpen(null);
            setCartOpen(true);
          }}
        />
      )}

      {menuOpen && (
        <div className="menu-popover" role="dialog" aria-label="Menu navigation">
          <div className="menu-popover-head">
            <div>
              <p className="eyebrow">QUICK NAVIGATION</p>
              <h2>Find your way.</h2>
            </div>
            <button className="modal-close" type="button" aria-label="Close menu" onClick={() => setMenuOpen(false)}>
              <X size={20} />
            </button>
          </div>
          <div className="menu-popover-links">
            {categories.map(({ id, label, jp }) => (
              <button
                key={id}
                type="button"
                onClick={() => {
                  selectCategory(id);
                  setMenuOpen(false);
                }}
              >
                <span>{jp}</span>
                {label}
                <ArrowRight size={16} />
              </button>
            ))}
          </div>
        </div>
      )}

      {editingLine && (
        <div className="modal-backdrop recipe-backdrop" role="presentation" onClick={closeRecipeEditor}>
          <div
            className="recipe-modal"
            role="dialog"
            aria-modal="true"
            aria-label={`Edit ${editingLine.product.name}`}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="recipe-modal-head">
              <div>
                <p className="eyebrow">EDIT RECIPE · 配置</p>
                <h2>{editingLine.product.name}</h2>
                <p>Choose what to hold for this dish.</p>
              </div>
              <button className="modal-close" type="button" onClick={closeRecipeEditor} aria-label="Cancel recipe edits">
                <X size={20} />
              </button>
            </div>
            <div className="recipe-ingredients">
              <p className="ingredient-label">Hold ingredients</p>
              {getRecipe(editingLine.size.id).length === 0 && (
                <p className="placeholder-note">No customizable ingredients for this item.</p>
              )}
              {getRecipe(editingLine.size.id).map((ingredient) => (
                <label
                  className={`recipe-ingredient ${draftHeld.includes(ingredient.ingredient_name) ? 'is-held' : ''}`}
                  key={ingredient.id}
                >
                  <input
                    type="checkbox"
                    checked={draftHeld.includes(ingredient.ingredient_name)}
                    onChange={() => toggleDraftIngredient(ingredient.ingredient_name)}
                  />
                  <span>
                    <strong>{ingredient.ingredient_name}</strong>
                    <small>{draftHeld.includes(ingredient.ingredient_name) ? 'Will be held' : 'Included'}</small>
                  </span>
                  <span className="ingredient-check">{draftHeld.includes(ingredient.ingredient_name) ? '✓' : ''}</span>
                </label>
              ))}
            </div>
            <div className="recipe-modal-actions">
              <button className="secondary-button" type="button" onClick={closeRecipeEditor}>
                Cancel
              </button>
              <button className="primary-button" type="button" onClick={saveRecipeEdits}>
                Save changes <ArrowRight size={16} />
              </button>
            </div>
          </div>
        </div>
      )}

      {cartOpen && (
        <div className="modal-backdrop cart-backdrop" role="presentation" onClick={() => setCartOpen(false)}>
          <aside className="cart-sheet" role="dialog" aria-modal="true" aria-label="Your order" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-head">
              <div>
                <p className="eyebrow">
                  {effectiveChannel === 'delivery'
                    ? 'YOUR DELIVERY'
                    : effectiveChannel === 'pickup'
                      ? 'YOUR PICKUP'
                      : 'YOUR TABLE'}{' '}
                  · ご注文
                </p>
                <h2>Your order</h2>
              </div>
              <div className="sheet-actions">
                {cart.length > 0 && (
                  <button className="edit-order-button" type="button" onClick={customizeMode ? () => setCustomizeMode(false) : startOrderEditing}>
                    {customizeMode ? 'Done editing' : 'Edit order'}
                  </button>
                )}
                <button className="modal-close" type="button" onClick={() => setCartOpen(false)} aria-label="Close">
                  <X size={20} />
                </button>
              </div>
            </div>

            {cart.length === 0 ? (
              <div className="cart-empty">
                <ShoppingBag size={27} />
                <p>Your order is waiting for its first bite.</p>
              </div>
            ) : (
              <>
                {customizeMode && (
                  <div className="customization-note">
                    Need to hold an ingredient? Tap <strong>Edit this recipe</strong> on any item below.
                  </div>
                )}

                <section className="addons-panel">
                  <div className="addons-heading">
                    <div>
                      <p className="eyebrow">MAKE IT YOURS · 追加</p>
                      <h3>Add extras</h3>
                    </div>
                    <span>Optional</span>
                  </div>
                  <div className="addon-options">
                    {addonCatalog.map((addon) => {
                      const selected = addons.find((l) => l.addon.id === addon.id)?.quantity ?? 0;
                      return (
                        <div className={`addon-row ${selected ? 'is-selected' : ''}`} key={addon.id}>
                          <div>
                            <strong>{addon.name}</strong>
                            <span>+ {peso(addon.price)}</span>
                          </div>
                          <div className="quantity">
                            <button type="button" onClick={() => updateAddon(addon, -1)} aria-label={`Remove ${addon.name}`}>
                              <Minus size={14} />
                            </button>
                            <span>{selected}</span>
                            <button type="button" onClick={() => updateAddon(addon, 1)} aria-label={`Add ${addon.name}`}>
                              <Plus size={14} />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </section>

                <div className="cart-lines">
                  {cart.map((line) => (
                    <div className="cart-line" key={line.key}>
                      <div className="cart-line-copy">
                        <strong>{line.product.name}</strong>
                        <span>
                          {line.size.size_label} · {peso(line.size.price)} each
                        </span>
                        {line.held.length > 0 && <small className="held-summary">Hold: {line.held.join(', ')}</small>}
                        {customizeMode && (
                          <button className="recipe-edit-link" type="button" onClick={() => openRecipeEditor(line)}>
                            Edit this recipe <ArrowRight size={14} />
                          </button>
                        )}
                      </div>
                      <div className="quantity">
                        <button type="button" onClick={() => updateQuantity(line.key, -1)} aria-label="Decrease quantity">
                          <Minus size={14} />
                        </button>
                        <span>{line.quantity}</span>
                        <button type="button" onClick={() => updateQuantity(line.key, 1)} aria-label="Increase quantity">
                          <Plus size={14} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>

                {addons.length > 0 && (
                  <div className="selected-addons">
                    <span>Add-ons</span>
                    <strong>{peso(addonTotal)}</strong>
                  </div>
                )}
                <div className="cart-total">
                  <span>Subtotal</span>
                  <strong>{peso(cartTotal)}</strong>
                </div>
                {effectiveChannel === 'delivery' && selectedFee != null && (
                  <div className="cart-total">
                    <span>Delivery fee</span>
                    <strong>{peso(selectedFee)}</strong>
                  </div>
                )}

                {effectiveChannel !== 'dine_in_qr' && (
                  <div className="payment-panel" style={{ marginBottom: 14 }}>
                    <div className="addons-heading">
                      <div>
                        <p className="eyebrow">
                          {effectiveChannel === 'delivery' ? 'DELIVERY DETAILS' : 'PICKUP DETAILS'}
                        </p>
                        <h3>Who's this for?</h3>
                      </div>
                    </div>
                    <input
                      className="input"
                      style={{ marginBottom: 10 }}
                      placeholder="Full name"
                      value={customerName}
                      onChange={(e) => setCustomerName(e.target.value)}
                    />
                    <input
                      className="input"
                      style={{ marginBottom: 10 }}
                      placeholder={`Phone number (${PH_PHONE_HINT})`}
                      value={customerPhone}
                      onChange={(e) => setCustomerPhone(e.target.value)}
                    />
                    {effectiveChannel === 'delivery' && (
                      <>
                        <input
                          className="input"
                          style={{ marginBottom: 10 }}
                          placeholder="Delivery address"
                          value={address}
                          onChange={(e) => setAddress(e.target.value)}
                        />
                        <input
                          className="input"
                          style={{ marginBottom: 10 }}
                          placeholder="Landmark (optional)"
                          value={landmark}
                          onChange={(e) => setLandmark(e.target.value)}
                        />
                        <select
                          className="input"
                          value={barangay}
                          onChange={(e) => setBarangay(e.target.value)}
                        >
                          <option value="">Select barangay...</option>
                          {deliveryFees.map((f) => (
                            <option key={f.barangay} value={f.barangay}>
                              {f.barangay} ({peso(f.fee)})
                            </option>
                          ))}
                        </select>
                      </>
                    )}
                  </div>
                )}

                <input
                  className="input"
                  style={{ marginBottom: 14 }}
                  placeholder="Anything else? (optional)"
                  value={customerNote}
                  onChange={(e) => setCustomerNote(e.target.value)}
                />

                {checkoutStage === 'qr' && selectedOnlineMethod ? (
                  <div className="payment-panel">
                    <div className="addons-heading">
                      <div>
                        <p className="eyebrow">PAYMENT · 支払い</p>
                        <h3>Pay via {selectedOnlineMethod.name}</h3>
                      </div>
                    </div>
                    {selectedOnlineMethod.qr_code_url && (
                      <img
                        src={selectedOnlineMethod.qr_code_url}
                        alt={`${selectedOnlineMethod.name} QR code`}
                        style={{ width: '100%', maxWidth: 260, borderRadius: 12, margin: '0 auto 12px', display: 'block' }}
                      />
                    )}
                    <p style={{ marginBottom: 4 }}>
                      <strong>Account name:</strong> {selectedOnlineMethod.account_name}
                    </p>
                    <p style={{ marginBottom: 14 }}>
                      <strong>Account number:</strong> {selectedOnlineMethod.account_number}
                    </p>
                    <p style={{ marginBottom: 14, color: 'var(--muted, #767676)' }}>
                      Send the exact order total, then continue to upload your proof of payment.
                    </p>
                    <button type="button" className="primary-button checkout-button" onClick={() => setCheckoutStage('upload')}>
                      I&apos;ve sent the payment -- proceed <ArrowRight size={16} />
                    </button>
                    <button
                      type="button"
                      className="input"
                      style={{ marginTop: 10, width: '100%', textAlign: 'center' }}
                      onClick={() => setCheckoutStage('form')}
                    >
                      Back
                    </button>
                  </div>
                ) : checkoutStage === 'upload' && selectedOnlineMethod ? (
                  <div className="payment-panel">
                    <div className="addons-heading">
                      <div>
                        <p className="eyebrow">PAYMENT · 支払い</p>
                        <h3>Upload proof of payment</h3>
                      </div>
                    </div>
                    <p style={{ marginBottom: 10, color: 'var(--muted, #767676)' }}>
                      Upload a screenshot of your {selectedOnlineMethod.name} transfer -- staff will confirm it
                      before your order is approved.
                    </p>
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      onChange={(e) => handleProofFileChange(e.target.files?.[0] ?? null)}
                      style={{ marginBottom: 10 }}
                    />
                    {proofPreviewUrl && (
                      <img
                        src={proofPreviewUrl}
                        alt="Proof of payment preview"
                        style={{ width: '100%', maxWidth: 260, borderRadius: 12, marginBottom: 14, display: 'block' }}
                      />
                    )}
                    <button
                      className="primary-button checkout-button"
                      type="button"
                      disabled={!proofFile || submitting}
                      onClick={handleSubmitWithProof}
                    >
                      {submitting ? 'Placing order...' : 'Submit order'} <ArrowRight size={16} />
                    </button>
                    <button
                      type="button"
                      className="input"
                      style={{ marginTop: 10, width: '100%', textAlign: 'center' }}
                      onClick={() => setCheckoutStage('qr')}
                    >
                      Back
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="payment-panel">
                      <div className="addons-heading">
                        <div>
                          <p className="eyebrow">PAYMENT · 支払い</p>
                          <h3>How will you pay?</h3>
                        </div>
                        <span>
                          {effectiveChannel === 'delivery'
                            ? 'On delivery'
                            : effectiveChannel === 'pickup'
                              ? 'At pickup'
                              : 'At your table'}
                        </span>
                      </div>
                      <div className="payment-options">
                        <button
                          type="button"
                          className={`payment-option ${paymentMethod === 'cash' ? 'is-selected' : ''}`}
                          onClick={() => {
                            setPaymentMethod('cash');
                            setSelectedOnlineMethod(null);
                          }}
                        >
                          <span>Cash</span>
                          <small>
                            {effectiveChannel === 'dine_in_qr'
                              ? 'Waiter will collect payment'
                              : effectiveChannel === 'delivery'
                                ? 'Pay the rider on arrival'
                                : 'Pay at pickup'}
                          </small>
                        </button>
                        {effectiveChannel === 'dine_in_qr' ? (
                          <button
                            type="button"
                            className={`payment-option ${paymentMethod === 'gcash' ? 'is-selected' : ''}`}
                            onClick={() => {
                              setPaymentMethod('gcash');
                              setSelectedOnlineMethod(null);
                            }}
                          >
                            <span>GCash</span>
                            <small>Waiter will bring the QR code</small>
                          </button>
                        ) : (
                          onlinePaymentMethods.map((m) => (
                            <button
                              key={m.id}
                              type="button"
                              className={`payment-option ${paymentMethod === m.name ? 'is-selected' : ''}`}
                              onClick={() => {
                                setPaymentMethod(m.name);
                                setSelectedOnlineMethod(m);
                              }}
                            >
                              <span>{m.name}</span>
                              <small>
                                {m.qr_code_url
                                  ? 'Show QR code, then upload proof of payment'
                                  : 'View account details, then upload proof of payment'}
                              </small>
                            </button>
                          ))
                        )}
                      </div>
                    </div>

                    <button
                      className="primary-button checkout-button"
                      type="button"
                      disabled={!paymentMethod || submitting}
                      onClick={handlePlaceOrder}
                    >
                      {submitting
                        ? 'Placing order...'
                        : paymentMethod
                          ? effectiveChannel === 'dine_in_qr'
                            ? 'Send to the counter'
                            : selectedOnlineMethod
                              ? 'View payment details'
                              : 'Place order'
                          : 'Choose payment first'}{' '}
                      <ArrowRight size={16} />
                    </button>
                  </>
                )}
              </>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}

function ItemModal({
  product,
  recipeFor,
  onClose,
  onAdd,
}: {
  product: ApiProduct;
  recipeFor: (sizeId: string) => ApiRecipeItem[];
  onClose: () => void;
  onAdd: (size: ApiProductSize) => void;
}) {
  const cheapest = [...product.sizes].sort((a, b) => a.price - b.price)[0];
  const ingredients = cheapest ? recipeFor(cheapest.id) : [];

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div className="item-modal" role="dialog" aria-modal="true" aria-label={product.name} onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" type="button" onClick={onClose} aria-label="Close">
          <X size={20} />
        </button>
        {product.image_path && (
          <div className="modal-art">
            <img src={product.image_path} alt="" />
          </div>
        )}
        <div className="modal-body">
          <p className="section-kicker">
            <span className="seal-dot" /> OISHII NORI
          </p>
          <h2>{product.name}</h2>
          <p>{product.category}</p>

          {ingredients.length > 0 && (
            <div className="placeholder-ingredients">
              <div>
                <span>What's inside</span>
              </div>
              <p>{ingredients.map((i) => i.ingredient_name).join(' · ')}</p>
            </div>
          )}

          {product.sizes.length > 1 ? (
            <div className="recipe-ingredients" style={{ paddingTop: 16 }}>
              <p className="ingredient-label">Choose a size</p>
              {product.sizes.map((size) => (
                <button
                  key={size.id}
                  className="btn-outline w-full justify-between"
                  style={{ marginBottom: 8 }}
                  disabled={size.availability === 'unavailable'}
                  onClick={() => onAdd(size)}
                >
                  <span>{size.size_label}</span>
                  <span>{peso(size.price)}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="modal-foot">
              <strong>{cheapest ? peso(cheapest.price) : ''}</strong>
              <button className="primary-button" type="button" onClick={() => cheapest && onAdd(cheapest)}>
                Add to order <ArrowRight size={16} />
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function OrderStatusView({
  order,
  onNewOrder,
  resolveItem,
}: {
  order: DigitalOrderStatus;
  onNewOrder: () => void;
  resolveItem: (sizeId: string) => { product: ApiProduct; size: ApiProductSize } | undefined;
}) {
  const statusLabel = order.status === 'pending' ? 'PENDING' : order.status === 'approved' ? 'CONFIRMED' : 'DECLINED';
  return (
    <section className="menu-intro" style={{ paddingTop: 40 }}>
      <div style={{ width: '100%' }}>
        <p className="eyebrow ink-eyebrow">
          ORDER TICKET <span>· 受付</span>
        </p>
        <h2>
          Order <em>#{order.order_number}</em>
        </h2>

        <div className="order-receipt">
          <div className="receipt-top">
            <div>
              <p className="eyebrow">
                {order.order_channel === 'delivery'
                  ? 'DELIVERY'
                  : order.order_channel === 'pickup'
                    ? 'PICKUP'
                    : `TABLE ${order.table_number}`}
              </p>
              <h3>
                {order.status === 'pending' && "We're preparing your ticket"}
                {order.status === 'approved' && 'Your order is confirmed'}
                {order.status === 'rejected' && 'This order was declined'}
              </h3>
            </div>
            <span className="receipt-status">{statusLabel}</span>
          </div>

          <div className="receipt-items">
            {order.items.map((item) => {
              const resolved = resolveItem(item.product_size_id);
              const name = resolved ? `${resolved.product.name} (${resolved.size.size_label})` : 'Item';
              return (
              <div className="receipt-row" key={item.id}>
                <span>
                  <strong>{item.quantity}× {name}</strong>
                  {item.held_ingredients.length > 0 && <small>Hold: {item.held_ingredients.join(', ')}</small>}
                </span>
                <strong>{peso(item.unit_price * item.quantity)}</strong>
              </div>
              );
            })}
            {order.addons.map((addon) => (
              <div className="receipt-row" key={addon.id}>
                <span>
                  <strong>
                    {addon.quantity}× {addon.addon_name || 'Add-on'}
                  </strong>
                </span>
                <strong>{peso(addon.unit_price * addon.quantity)}</strong>
              </div>
            ))}
          </div>

          {order.delivery?.address && (
            <p className="review-confirmation">
              Delivering to: {order.delivery.address}
              {order.delivery.landmark ? ` (${order.delivery.landmark})` : ''}
            </p>
          )}

          {order.delivery?.delivery_fee != null && (
            <div className="receipt-row">
              <span>Delivery fee</span>
              <strong>{peso(order.delivery.delivery_fee)}</strong>
            </div>
          )}

          <div className="receipt-total">
            <span>Total</span>
            <strong>{peso(order.subtotal + (order.delivery?.delivery_fee ?? 0))}</strong>
          </div>

          {order.status === 'pending' && (
            <p className="review-confirmation">Sit tight -- staff are confirming your order and payment. This updates automatically.</p>
          )}
          {order.status === 'approved' && (
            <p className="review-confirmation">Thank you! Your order is being prepared.</p>
          )}
          {order.status === 'rejected' && (
            <>
              <p className="review-confirmation" style={{ color: '#a51f26' }}>
                {order.rejected_reason ||
                  (order.order_channel === 'dine_in_qr'
                    ? 'Please ask staff at your table for help.'
                    : 'Please contact the restaurant for help.')}
              </p>
              <button className="primary-button" type="button" style={{ marginTop: 12 }} onClick={onNewOrder}>
                Start a new order <ArrowRight size={16} />
              </button>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
