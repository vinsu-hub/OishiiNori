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
import {
  ApiDiscountType,
  ApiProduct,
  ApiProductSize,
  createTransaction,
  fetchDiscountTypes,
  fetchProducts,
} from '@/lib/api';
import { formatCurrency } from '@/lib/utils';
import { VAT_RATE_PREVIEW } from '@/lib/constants';

interface CartLine {
  key: string;
  product: ApiProduct;
  size: ApiProductSize;
  quantity: number;
}

export default function POSTerminal() {
  const { user } = useAuth();
  const [products, setProducts] = useState<ApiProduct[]>([]);
  const [discountTypes, setDiscountTypes] = useState<ApiDiscountType[]>([]);
  const [loading, setLoading] = useState(true);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [discountTypeId, setDiscountTypeId] = useState<string>('none');
  const [submitting, setSubmitting] = useState(false);

  const [sizePickerProduct, setSizePickerProduct] = useState<ApiProduct | null>(null);

  const [ownerRequestOpen, setOwnerRequestOpen] = useState(false);
  const [ownerRequestForm, setOwnerRequestForm] = useState({ employeeNumber: '', pin: '', note: '' });
  const [ownerRequestConfirmed, setOwnerRequestConfirmed] = useState<typeof ownerRequestForm | null>(null);

  useEffect(() => {
    Promise.all([fetchProducts(true), fetchDiscountTypes(true)])
      .then(([p, d]) => {
        setProducts(p);
        setDiscountTypes(d);
      })
      .catch((e) => toast.error(`Failed to load menu: ${e.message}`))
      .finally(() => setLoading(false));
  }, []);

  const selectedDiscount = discountTypes.find((d) => d.id === discountTypeId) || null;

  const subtotal = useMemo(
    () => cart.reduce((sum, line) => sum + line.size.price * line.quantity, 0),
    [cart]
  );
  // Preview only -- the backend recomputes discount_amount/tax_amount
  // server-side from the live discount_type row; these numbers are for
  // display before charging, never sent as-is to the API.
  const previewDiscountAmount = selectedDiscount ? subtotal * (selectedDiscount.percentage / 100) : 0;
  const previewTaxable = subtotal - previewDiscountAmount;
  const previewTax = selectedDiscount?.vat_exempt ? 0 : previewTaxable * VAT_RATE_PREVIEW;
  const previewTotal = previewTaxable + previewTax;

  function addToCart(product: ApiProduct, size: ApiProductSize) {
    if (size.availability === 'unavailable') {
      toast.error(`${product.name} (${size.size_label}) is out of stock`);
      return;
    }
    setCart((prev) => {
      const key = size.id;
      const existing = prev.find((l) => l.key === key);
      if (existing) {
        return prev.map((l) => (l.key === key ? { ...l, quantity: l.quantity + 1 } : l));
      }
      return [...prev, { key, product, size, quantity: 1 }];
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

  async function handleCharge() {
    if (!user) return;
    if (cart.length === 0) {
      toast.error('Cart is empty');
      return;
    }
    setSubmitting(true);
    try {
      const transaction = await createTransaction({
        employee_id: user.id,
        items: cart.map((l) => ({ product_size_id: l.size.id, quantity: l.quantity })),
        discount_type_id: discountTypeId === 'none' ? undefined : discountTypeId,
        is_owner_request: !!ownerRequestConfirmed,
        owner_request_employee_number: ownerRequestConfirmed?.employeeNumber,
        owner_request_pin: ownerRequestConfirmed?.pin,
        owner_request_note: ownerRequestConfirmed?.note || undefined,
      });
      toast.success(
        `Sale complete -- total ${formatCurrency(transaction.total_amount)} (discount ${formatCurrency(
          transaction.discount_amount
        )}, tax ${formatCurrency(transaction.tax_amount)})`
      );
      setCart([]);
      setDiscountTypeId('none');
      clearOwnerRequest();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to create transaction');
      // A failed charge invalidates whatever was staged for Owner's Request --
      // force re-confirmation on retry rather than silently letting a stale
      // (possibly since-invalid) PIN confirmation be reused.
      clearOwnerRequest();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <DashboardLayout title="POS Terminal">
      <div className="flex h-full overflow-hidden">
        <div className="flex-1 overflow-auto p-6">
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading menu...</p>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
              {products.map((product) => {
                const cheapest = [...product.sizes].sort((a, b) => a.price - b.price)[0];
                const allUnavailable = product.sizes.every((s) => s.availability === 'unavailable');
                return (
                  <Card
                    key={product.id}
                    className={`cursor-pointer overflow-hidden transition hover:border-primary ${
                      allUnavailable ? 'opacity-50' : ''
                    }`}
                    onClick={() => !allUnavailable && handleProductClick(product)}
                  >
                    {product.image_path ? (
                      <img
                        src={product.image_path}
                        alt={product.name}
                        className="w-full h-24 object-cover"
                        loading="lazy"
                      />
                    ) : (
                      <div className="w-full h-24 bg-muted" />
                    )}
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm font-corp-display">{product.name}</CardTitle>
                    </CardHeader>
                    <CardContent className="pb-3 space-y-1">
                      <p className="text-xs text-muted-foreground">{product.category}</p>
                      <p className="text-sm font-semibold">
                        {product.sizes.length > 1 && cheapest ? `from ${formatCurrency(cheapest.price)}` : cheapest ? formatCurrency(cheapest.price) : ''}
                      </p>
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
        </div>

        <div className="w-96 border-l flex flex-col overflow-hidden">
          <div className="p-4 border-b">
            <h3 className="font-corp-display font-semibold">Current Order</h3>
          </div>
          <div className="flex-1 overflow-auto p-4 space-y-2">
            {cart.length === 0 && <p className="text-sm text-muted-foreground">No items yet.</p>}
            {cart.map((line) => (
              <div key={line.key} className="flex items-center justify-between text-sm border-b pb-2">
                <div>
                  <p className="font-medium">{line.product.name}</p>
                  <p className="text-xs text-muted-foreground">{line.size.size_label}</p>
                </div>
                <div className="flex items-center gap-2">
                  <Button size="icon" variant="outline" className="h-6 w-6" onClick={() => updateQuantity(line.key, -1)}>
                    -
                  </Button>
                  <span>{line.quantity}</span>
                  <Button size="icon" variant="outline" className="h-6 w-6" onClick={() => updateQuantity(line.key, 1)}>
                    +
                  </Button>
                  <span className="w-14 text-right">{formatCurrency(line.size.price * line.quantity)}</span>
                </div>
              </div>
            ))}
          </div>

          <div className="p-4 border-t space-y-3">
            <div>
              <Label className="text-xs">Discount</Label>
              <Select value={discountTypeId} onValueChange={setDiscountTypeId}>
                <SelectTrigger>
                  <SelectValue placeholder="No discount" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No discount</SelectItem>
                  {discountTypes.map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      {d.name} ({d.percentage}%)
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <Button
              variant={ownerRequestConfirmed ? 'default' : 'outline'}
              className="w-full"
              onClick={() => (ownerRequestConfirmed ? clearOwnerRequest() : setOwnerRequestOpen(true))}
            >
              {ownerRequestConfirmed ? "Owner's Request -- confirmed" : "Owner's Request"}
            </Button>

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
    </DashboardLayout>
  );
}
