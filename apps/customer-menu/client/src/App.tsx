import React, { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { ShoppingCart, Plus, Minus, X, Loader2, CheckCircle2, XCircle, Clock } from 'lucide-react';
import {
  ApiProduct,
  ApiProductSize,
  DigitalOrderStatus,
  PaymentMethod,
  fetchMenu,
  fetchOrderStatus,
  submitOrder,
} from '@/lib/api';

declare global {
  interface Window {
    toast?: (message: string, type?: 'success' | 'error' | 'info') => void;
  }
}

function toast(message: string, type: 'success' | 'error' | 'info' = 'info') {
  window.toast?.(message, type);
}

type Stage = 'menu' | 'checkout' | 'confirmation';

interface CartLine {
  key: string;
  product: ApiProduct;
  size: ApiProductSize;
  quantity: number;
}

const STATUS_POLL_MS = 5_000;

export default function App() {
  const [tableNumber] = useState<number | null>(() => {
    const raw = new URLSearchParams(window.location.search).get('table');
    const n = raw ? parseInt(raw, 10) : NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
  });

  const [stage, setStage] = useState<Stage>('menu');
  const [products, setProducts] = useState<ApiProduct[]>([]);
  const [loadingMenu, setLoadingMenu] = useState(true);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [sizePickerProduct, setSizePickerProduct] = useState<ApiProduct | null>(null);

  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('cash');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const [order, setOrder] = useState<DigitalOrderStatus | null>(null);

  useEffect(() => {
    fetchMenu()
      .then(setProducts)
      .catch((e) => toast(e instanceof Error ? e.message : 'Failed to load menu', 'error'))
      .finally(() => setLoadingMenu(false));
  }, []);

  // Once an order is placed, poll for staff approval/rejection so the
  // customer sees a live status without refreshing.
  useEffect(() => {
    if (stage !== 'confirmation' || !order || order.status !== 'pending') return;
    const interval = setInterval(() => {
      fetchOrderStatus(order.id)
        .then((updated) => setOrder(updated))
        .catch(() => {});
    }, STATUS_POLL_MS);
    return () => clearInterval(interval);
  }, [stage, order]);

  const subtotal = useMemo(() => cart.reduce((sum, line) => sum + line.size.price * line.quantity, 0), [cart]);
  const cartCount = useMemo(() => cart.reduce((sum, line) => sum + line.quantity, 0), [cart]);

  function addToCart(product: ApiProduct, size: ApiProductSize) {
    if (size.availability === 'unavailable') {
      toast(`${product.name} (${size.size_label}) is out of stock`, 'error');
      return;
    }
    setCart((prev) => {
      const existing = prev.find((l) => l.key === size.id);
      if (existing) {
        return prev.map((l) => (l.key === size.id ? { ...l, quantity: l.quantity + 1 } : l));
      }
      return [...prev, { key: size.id, product, size, quantity: 1 }];
    });
    toast(`Added ${product.name}`, 'success');
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
      prev.map((l) => (l.key === key ? { ...l, quantity: l.quantity + delta } : l)).filter((l) => l.quantity > 0)
    );
  }

  async function handlePlaceOrder() {
    if (!tableNumber) {
      toast('Missing table number -- please rescan the QR code at your table', 'error');
      return;
    }
    if (cart.length === 0) return;
    setSubmitting(true);
    try {
      const result = await submitOrder({
        table_number: tableNumber,
        items: cart.map((l) => ({ product_size_id: l.size.id, quantity: l.quantity })),
        payment_method: paymentMethod,
        customer_note: note.trim() || undefined,
      });
      setOrder(result);
      setStage('confirmation');
      setCart([]);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Failed to place order', 'error');
    } finally {
      setSubmitting(false);
    }
  }

  function startNewOrder() {
    setOrder(null);
    setNote('');
    setPaymentMethod('cash');
    setStage('menu');
  }

  if (!tableNumber) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <Card className="w-full max-w-sm">
          <CardContent className="py-8 text-center space-y-3">
            <img src="/logo.jpg" alt="Oishii Nori" className="w-16 h-16 rounded-full object-cover mx-auto shadow-l2-raised" />
            <p className="font-corp-display text-lg">No table detected</p>
            <p className="text-sm text-muted-foreground">
              Please scan the QR code on your table to start ordering.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen pb-24">
      <header className="bg-card border-b border-[--color-border] px-4 py-3 shadow-l2-raised sticky top-0 z-20">
        <div className="max-w-lg mx-auto flex items-center gap-3">
          <img src="/logo.jpg" alt="Oishii Nori" className="w-9 h-9 rounded-full object-cover shadow-l1-hover" />
          <div className="min-w-0">
            <h1 className="font-corp-display text-base truncate">Oishii Nori</h1>
            <p className="text-xs text-muted-foreground">Table {tableNumber}</p>
          </div>
        </div>
      </header>

      <main className="max-w-lg mx-auto p-4">
        {stage === 'menu' && (
          <MenuStage
            products={products}
            loading={loadingMenu}
            onProductClick={handleProductClick}
          />
        )}
        {stage === 'checkout' && (
          <CheckoutStage
            cart={cart}
            subtotal={subtotal}
            paymentMethod={paymentMethod}
            note={note}
            submitting={submitting}
            onPaymentMethodChange={setPaymentMethod}
            onNoteChange={setNote}
            onBack={() => setStage('menu')}
            onSubmit={handlePlaceOrder}
            onUpdateQuantity={updateQuantity}
          />
        )}
        {stage === 'confirmation' && order && (
          <ConfirmationStage order={order} onNewOrder={startNewOrder} />
        )}
      </main>

      {stage === 'menu' && cart.length > 0 && (
        <div className="fixed bottom-0 left-0 right-0 p-4 bg-card border-t border-[--color-border] shadow-l3-modal z-20">
          <div className="max-w-lg mx-auto">
            <Button className="w-full" size="lg" onClick={() => setStage('checkout')}>
              <ShoppingCart className="w-5 h-5" />
              View order -- {cartCount} item{cartCount === 1 ? '' : 's'} -- ₱{subtotal.toFixed(2)}
            </Button>
          </div>
        </div>
      )}

      {sizePickerProduct && (
        <div className="fixed inset-0 z-30 flex items-end sm:items-center justify-center bg-black/40 p-4">
          <Card className="w-full max-w-sm overflow-hidden">
            {sizePickerProduct.image_path && (
              <img
                src={sizePickerProduct.image_path}
                alt={sizePickerProduct.name}
                className="w-full h-40 object-cover"
              />
            )}
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle>{sizePickerProduct.name} -- choose a size</CardTitle>
              <button onClick={() => setSizePickerProduct(null)} aria-label="Close">
                <X className="w-5 h-5" />
              </button>
            </CardHeader>
            <CardContent className="space-y-2">
              {sizePickerProduct.sizes.map((size) => (
                <button
                  key={size.id}
                  disabled={size.availability === 'unavailable'}
                  className="btn-outline w-full justify-between disabled:opacity-40"
                  onClick={() => {
                    addToCart(sizePickerProduct, size);
                    setSizePickerProduct(null);
                  }}
                >
                  <span>{size.size_label}</span>
                  <span>₱{size.price.toFixed(2)}</span>
                </button>
              ))}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}

function MenuStage({
  products,
  loading,
  onProductClick,
}: {
  products: ApiProduct[];
  loading: boolean;
  onProductClick: (product: ApiProduct) => void;
}) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="w-6 h-6 animate-spin mr-2" /> Loading menu...
      </div>
    );
  }

  const byCategory = products.reduce<Record<string, ApiProduct[]>>((acc, p) => {
    (acc[p.category] ||= []).push(p);
    return acc;
  }, {});

  return (
    <div className="space-y-6">
      {Object.entries(byCategory).map(([category, items]) => (
        <section key={category}>
          <h2 className="font-corp-display text-sm uppercase tracking-wide text-muted-foreground mb-2">
            {category}
          </h2>
          <div className="space-y-2">
            {items.map((product) => {
              const cheapest = [...product.sizes].sort((a, b) => a.price - b.price)[0];
              const allUnavailable = product.sizes.every((s) => s.availability === 'unavailable');
              return (
                <Card
                  key={product.id}
                  className={`cursor-pointer overflow-hidden ${allUnavailable ? 'opacity-50' : ''}`}
                  onClick={() => !allUnavailable && onProductClick(product)}
                >
                  <div className="flex items-center gap-3 p-2">
                    {product.image_path ? (
                      <img
                        src={product.image_path}
                        alt={product.name}
                        className="w-16 h-16 rounded-lg object-cover shrink-0"
                        loading="lazy"
                      />
                    ) : (
                      <div className="w-16 h-16 rounded-lg bg-muted shrink-0" />
                    )}
                    <div className="min-w-0 flex-1 flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-medium truncate">{product.name}</p>
                        {product.is_bundle && <p className="text-xs text-[--color-warning] font-medium">Bundle</p>}
                        {allUnavailable && <p className="text-xs text-destructive">Unavailable</p>}
                      </div>
                      <div className="shrink-0 font-corp-mono text-sm">
                        {product.sizes.length > 1 ? `from ₱${cheapest?.price.toFixed(2)}` : `₱${cheapest?.price.toFixed(2)}`}
                      </div>
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

function CheckoutStage({
  cart,
  subtotal,
  paymentMethod,
  note,
  submitting,
  onPaymentMethodChange,
  onNoteChange,
  onBack,
  onSubmit,
  onUpdateQuantity,
}: {
  cart: CartLine[];
  subtotal: number;
  paymentMethod: PaymentMethod;
  note: string;
  submitting: boolean;
  onPaymentMethodChange: (m: PaymentMethod) => void;
  onNoteChange: (v: string) => void;
  onBack: () => void;
  onSubmit: () => void;
  onUpdateQuantity: (key: string, delta: number) => void;
}) {
  if (cart.length === 0) {
    return (
      <div className="text-center py-12 space-y-3">
        <p className="text-muted-foreground">Your cart is empty.</p>
        <Button variant="outline" onClick={onBack}>Back to menu</Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <button className="text-sm text-muted-foreground" onClick={onBack}>&larr; Back to menu</button>

      <Card>
        <CardHeader><CardTitle>Your order</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {cart.map((line) => (
            <div key={line.key} className="flex items-center justify-between gap-2 text-sm">
              <div className="flex items-center gap-2 min-w-0">
                {line.product.image_path ? (
                  <img
                    src={line.product.image_path}
                    alt={line.product.name}
                    className="w-10 h-10 rounded-md object-cover shrink-0"
                  />
                ) : (
                  <div className="w-10 h-10 rounded-md bg-muted shrink-0" />
                )}
                <div className="min-w-0">
                  <p className="font-medium truncate">{line.product.name}</p>
                  <p className="text-xs text-muted-foreground">{line.size.size_label}</p>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button className="btn-outline p-1.5" onClick={() => onUpdateQuantity(line.key, -1)}><Minus className="w-3.5 h-3.5" /></button>
                <span className="w-5 text-center">{line.quantity}</span>
                <button className="btn-outline p-1.5" onClick={() => onUpdateQuantity(line.key, 1)}><Plus className="w-3.5 h-3.5" /></button>
                <span className="w-16 text-right font-corp-mono">₱{(line.size.price * line.quantity).toFixed(2)}</span>
              </div>
            </div>
          ))}
          <div className="pt-2 border-t border-[--color-border] flex justify-between font-corp-display text-base">
            <span>Subtotal</span>
            <span>₱{subtotal.toFixed(2)}</span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>How will you pay?</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {(['cash', 'gcash'] as PaymentMethod[]).map((method) => (
            <button
              key={method}
              className={`w-full text-left px-4 py-3 rounded-lg border ${
                paymentMethod === method ? 'border-primary bg-accent' : 'border-[--color-border]'
              }`}
              onClick={() => onPaymentMethodChange(method)}
            >
              {method === 'cash' ? 'Cash (pay staff directly)' : 'GCash'}
            </button>
          ))}
          <textarea
            className="input mt-2"
            placeholder="Add a note for the kitchen (optional)"
            value={note}
            onChange={(e) => onNoteChange(e.target.value)}
            rows={2}
          />
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground text-center">
        Staff will confirm your order and payment before it's prepared.
      </p>

      <Button className="w-full" size="lg" disabled={submitting} onClick={onSubmit}>
        {submitting ? 'Placing order...' : `Place order -- ₱${subtotal.toFixed(2)}`}
      </Button>
    </div>
  );
}

function ConfirmationStage({ order, onNewOrder }: { order: DigitalOrderStatus; onNewOrder: () => void }) {
  return (
    <div className="py-8 text-center space-y-4">
      {order.status === 'pending' && (
        <>
          <Clock className="w-12 h-12 mx-auto text-warning" />
          <p className="font-corp-display text-xl">Order #{order.order_number}</p>
          <p className="text-muted-foreground">Waiting for staff to confirm your order and payment...</p>
        </>
      )}
      {order.status === 'approved' && (
        <>
          <CheckCircle2 className="w-12 h-12 mx-auto text-success" />
          <p className="font-corp-display text-xl">Order #{order.order_number} confirmed!</p>
          <p className="text-muted-foreground">Your order is being prepared. Thank you!</p>
        </>
      )}
      {order.status === 'rejected' && (
        <>
          <XCircle className="w-12 h-12 mx-auto text-destructive" />
          <p className="font-corp-display text-xl">Order #{order.order_number} declined</p>
          <p className="text-muted-foreground">
            {order.rejected_reason || 'Please ask staff at your table for help.'}
          </p>
          <Button className="mt-2" onClick={onNewOrder}>Start a new order</Button>
        </>
      )}
    </div>
  );
}
