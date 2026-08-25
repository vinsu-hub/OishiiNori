/**
 * Typed FastAPI client for the Oishii Nori Command Suite backend
 * (services/api-fastapi). Every call attaches the signed-in Supabase
 * session's JWT as a bearer token, matching the backend's
 * `get_current_user` dependency (app/auth.py).
 *
 * Endpoint coverage grows milestone by milestone alongside the plan at
 * C:\Users\vinsu\.claude\plans\ancient-dreaming-lighthouse.md -- this file
 * currently covers Milestone 1's smoke-test surface plus the already-known
 * shapes for products/recipes/transactions/inventory/discounts/loss-records
 * (app/schemas.py), so later milestones mostly just consume what's here.
 */
import { supabase } from '@/lib/supabaseClient';
import { enqueue, isNetworkError, registerExecutor } from '@/lib/offlineQueue';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL as string;

// Thrown by createTransaction() in place of the raw network error when a
// sale is queued locally instead of failing outright -- POSTerminal's
// handleCharge() catches this specifically to clear the cart and show a
// "queued" toast, distinct from a real rejection (e.g. insufficient stock)
// which must surface immediately, unqueued.
export class QueuedOfflineError extends Error {
  constructor() {
    super('Offline -- order queued, will sync automatically');
    this.name = 'QueuedOfflineError';
  }
}

// ---------------------------------------------------------------------------
// Core request helper
// ---------------------------------------------------------------------------

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) {
    throw new Error('Not signed in');
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`,
    },
    ...init,
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`API ${path} failed: ${response.status} ${body}`);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return response.json() as Promise<T>;
}

async function requestMultipart<T>(path: string, formData: FormData, method = 'POST'): Promise<T> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) {
    throw new Error('Not signed in');
  }

  // Deliberately omits Content-Type -- the browser sets the multipart
  // boundary itself when given a FormData body; setting it manually breaks
  // the upload.
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method,
    headers: { Authorization: `Bearer ${session.access_token}` },
    body: formData,
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`API ${path} failed: ${response.status} ${body}`);
  }
  return response.json() as Promise<T>;
}

async function requestBlob(path: string): Promise<Blob> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) {
    throw new Error('Not signed in');
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${session.access_token}` },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`API ${path} failed: ${response.status} ${body}`);
  }
  return response.blob();
}

export function fetchHealth(): Promise<{ status: string }> {
  return fetch(`${API_BASE_URL}/health`).then((r) => r.json());
}

// ---------------------------------------------------------------------------
// Products / recipes
// ---------------------------------------------------------------------------

export type KitchenStation = 'sushi_bar' | 'sushi_bar_oven' | 'hot_line' | 'salad_cold_bar' | 'cafe_bar';
export type ProductAvailability = 'available' | 'low_stock' | 'unavailable';
export type Department = 'kitchen' | 'cafe';
export type UserRole = 'employee' | 'manager' | 'executive';

export interface ApiProductSize {
  id: string;
  product_id: string;
  size_label: string;
  price: number;
  scale_factor: number;
  sort_order: number;
  availability: ProductAvailability;
  total_pieces: number | null;
}

export interface ApiProduct {
  id: string;
  name: string;
  category: string;
  station: KitchenStation;
  department: Department;
  is_bundle: boolean;
  active: boolean;
  needs_station_review: boolean;
  image_path: string | null;
  sizes: ApiProductSize[];
}

export function fetchProducts(activeOnly = true, department?: Department): Promise<ApiProduct[]> {
  const params = new URLSearchParams({ active_only: String(activeOnly) });
  if (department) params.set('department', department);
  return request(`/products?${params.toString()}`);
}

export interface ApiRecipeItem {
  id: string;
  product_size_id: string;
  ingredient_id: string;
  ingredient_name: string;
  qty_per_serving: number;
  unit: string;
  prep_notes: string | null;
  needs_review: boolean;
}

export function fetchRecipe(productSizeId: string): Promise<ApiRecipeItem[]> {
  return request(`/product-sizes/${productSizeId}/recipe`);
}

// --- Menu Editing (executive-only product/size/recipe CRUD + image upload) ---

export interface CreateProductSizeInput {
  size_label: string;
  price: number;
  scale_factor?: number;
  sort_order?: number;
}

export interface CreateProductRequest {
  name: string;
  category: string;
  station: KitchenStation;
  department: Department;
  sizes: CreateProductSizeInput[];
}

export function createProduct(body: CreateProductRequest): Promise<ApiProduct> {
  return request('/products', { method: 'POST', body: JSON.stringify(body) });
}

export function updateProduct(
  id: string,
  body: Partial<{
    name: string;
    category: string;
    station: KitchenStation;
    department: Department;
    active: boolean;
  }>
): Promise<ApiProduct> {
  return request(`/products/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
}

export function createProductSize(productId: string, body: CreateProductSizeInput): Promise<ApiProductSize> {
  return request(`/products/${productId}/sizes`, { method: 'POST', body: JSON.stringify(body) });
}

export function updateProductSize(
  sizeId: string,
  body: Partial<{ size_label: string; price: number; scale_factor: number; sort_order: number }>
): Promise<ApiProductSize> {
  return request(`/product-sizes/${sizeId}`, { method: 'PATCH', body: JSON.stringify(body) });
}

export function deleteProductSize(sizeId: string): Promise<{ deleted: boolean }> {
  return request(`/product-sizes/${sizeId}`, { method: 'DELETE' });
}

export interface CreateRecipeItemInput {
  ingredient_id: string;
  qty_per_serving: number;
  unit: string;
  prep_notes?: string | null;
}

export function createRecipeItem(sizeId: string, body: CreateRecipeItemInput): Promise<ApiRecipeItem> {
  return request(`/product-sizes/${sizeId}/recipe-items`, { method: 'POST', body: JSON.stringify(body) });
}

export function updateRecipeItem(
  itemId: string,
  body: Partial<{ ingredient_id: string; qty_per_serving: number; unit: string; prep_notes: string | null }>
): Promise<ApiRecipeItem> {
  return request(`/recipe-items/${itemId}`, { method: 'PATCH', body: JSON.stringify(body) });
}

export function deleteRecipeItem(itemId: string): Promise<{ deleted: boolean }> {
  return request(`/recipe-items/${itemId}`, { method: 'DELETE' });
}

export function uploadProductImage(productId: string, file: File): Promise<ApiProduct> {
  const formData = new FormData();
  formData.append('file', file);
  return requestMultipart(`/products/${productId}/image`, formData);
}

// ---------------------------------------------------------------------------
// Discounts
// ---------------------------------------------------------------------------

export interface ApiDiscountType {
  id: string;
  name: string;
  percentage: number;
  vat_exempt: boolean;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export function fetchDiscountTypes(activeOnly = false): Promise<ApiDiscountType[]> {
  return request(`/discount-types?active_only=${activeOnly}`);
}

export function createDiscountType(body: { name: string; percentage: number; vat_exempt?: boolean }): Promise<ApiDiscountType> {
  return request('/discount-types', { method: 'POST', body: JSON.stringify(body) });
}

export function updateDiscountType(
  id: string,
  body: Partial<{ name: string; percentage: number; vat_exempt: boolean; active: boolean }>
): Promise<ApiDiscountType> {
  return request(`/discount-types/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
}

// menu_addons is the same shared price list the digital customer-menu app
// reads via this identical public endpoint (see digital_menu.py) -- POS
// Terminal reuses it rather than duplicating the addon catalog.
export function fetchAddons(): Promise<ApiMenuAddon[]> {
  return request('/public/addons');
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

export type KitchenStatus = 'queued' | 'preparing' | 'ready' | 'completed';
export type TransactionStatus = 'open' | 'closed' | 'voided';
export type OrderType = 'dine_in' | 'takeout';
// Distinct from any digital-order payment-method type -- POS supports two
// more values (card, split).
export type TransactionPaymentMethod = 'cash' | 'gcash' | 'card' | 'split';

export interface ApiMenuAddon {
  id: string;
  name: string;
  price: number;
  active: boolean;
}

export interface CreateTransactionItemAddon {
  addon_id: string;
  quantity: number;
}

export interface CreateTransactionItem {
  product_size_id: string;
  quantity: number;
  held_ingredients?: string[];
  addons?: CreateTransactionItemAddon[];
}

export interface CreateTransactionRequest {
  employee_id: string;
  items: CreateTransactionItem[];
  discount_type_id?: string | null;
  is_owner_request?: boolean;
  owner_request_employee_number?: string | null;
  owner_request_pin?: string | null;
  owner_request_note?: string | null;
  order_type?: OrderType | null;
  table_number?: number | null;
  guest_count?: number | null;
  payment_method?: TransactionPaymentMethod | null;
}

export interface ApiTransactionItemAddon {
  id: string;
  transaction_item_id: string;
  addon_id: string;
  addon_name: string | null;
  quantity: number;
  unit_price: number;
}

export interface ApiTransactionItem {
  id: string;
  transaction_id: string;
  product_size_id: string;
  quantity: number;
  unit_price: number;
  held_ingredients: string[];
  bundle_fulfilled: boolean;
  addons: ApiTransactionItemAddon[];
}

export interface ApiTransaction {
  id: string;
  employee_id: string;
  status: TransactionStatus;
  opened_at: string;
  closed_at: string | null;
  total_amount: number;
  discount_type_id: string | null;
  discount_amount: number;
  tax_amount: number;
  is_owner_request: boolean;
  owner_request_by: string | null;
  owner_request_note: string | null;
  voided_by: string | null;
  voided_at: string | null;
  void_reason: string | null;
  kitchen_status: KitchenStatus;
  kitchen_status_updated_at: string | null;
  order_type: OrderType | null;
  table_number: number | null;
  guest_count: number | null;
  payment_method: TransactionPaymentMethod | null;
  items: ApiTransactionItem[];
}

function _createTransactionRequest(body: CreateTransactionRequest): Promise<ApiTransaction> {
  return request('/transactions', { method: 'POST', body: JSON.stringify(body) });
}

registerExecutor((payload) => _createTransactionRequest(payload as unknown as CreateTransactionRequest));

export async function createTransaction(body: CreateTransactionRequest): Promise<ApiTransaction> {
  try {
    return await _createTransactionRequest(body);
  } catch (err) {
    if (isNetworkError(err)) {
      enqueue(body as unknown as Record<string, unknown>);
      throw new QueuedOfflineError();
    }
    throw err;
  }
}

export function fetchTransactions(params?: { date?: string; status?: TransactionStatus }): Promise<ApiTransaction[]> {
  const qs = new URLSearchParams();
  if (params?.date) qs.set('date', params.date);
  if (params?.status) qs.set('status', params.status);
  const query = qs.toString();
  return request(`/transactions${query ? `?${query}` : ''}`);
}

export function fetchTransaction(id: string): Promise<ApiTransaction> {
  return request(`/transactions/${id}`);
}

export function closeTransaction(id: string): Promise<ApiTransaction> {
  return request(`/transactions/${id}/close`, { method: 'POST' });
}

export function voidTransaction(id: string, reason: string): Promise<ApiTransaction> {
  return request(`/transactions/${id}/void`, { method: 'POST', body: JSON.stringify({ reason }) });
}

export function updateKitchenStatus(id: string, kitchen_status: KitchenStatus): Promise<ApiTransaction> {
  return request(`/transactions/${id}/kitchen-status`, {
    method: 'PATCH',
    body: JSON.stringify({ kitchen_status }),
  });
}

export function fulfillTransaction(id: string): Promise<ApiTransaction> {
  return request(`/transactions/${id}/fulfill`, { method: 'POST' });
}

export interface BundleFulfillmentLine {
  maki_roll_product_id: string;
  quantity: number;
}

export interface ApiBundleFulfillmentResult {
  transaction_item_id: string;
  total_pieces: number;
  lines: BundleFulfillmentLine[];
  ingredients_deducted: { ingredient_id: string; ingredient_name: string; quantity: number; unit: string }[];
}

export function submitBundleFulfillment(
  transactionId: string,
  itemId: string,
  lines: BundleFulfillmentLine[]
): Promise<ApiBundleFulfillmentResult> {
  return request(`/transactions/${transactionId}/items/${itemId}/bundle-fulfillment`, {
    method: 'POST',
    body: JSON.stringify({ lines }),
  });
}

// ---------------------------------------------------------------------------
// Digital menu (QR table ordering) -- staff-facing approval endpoints
// ---------------------------------------------------------------------------

export type DigitalOrderStatus = 'pending' | 'approved' | 'rejected';
export type PaymentMethod = 'gcash' | 'cash';

export interface ApiDigitalOrderItem {
  id: string;
  digital_order_id: string;
  product_size_id: string;
  quantity: number;
  unit_price: number;
  held_ingredients: string[];
}

export interface ApiDigitalOrderAddon {
  id: string;
  digital_order_id: string;
  addon_id: string;
  addon_name: string | null;
  quantity: number;
  unit_price: number;
}

export interface ApiDigitalOrder {
  id: string;
  order_number: number;
  table_number: number;
  status: DigitalOrderStatus;
  payment_method: PaymentMethod;
  customer_note: string | null;
  subtotal: number;
  approved_by: string | null;
  approved_at: string | null;
  rejected_reason: string | null;
  transaction_id: string | null;
  created_at: string;
  items: ApiDigitalOrderItem[];
  addons: ApiDigitalOrderAddon[];
}

export function fetchDigitalOrders(status?: DigitalOrderStatus): Promise<ApiDigitalOrder[]> {
  return request(`/digital-orders${status ? `?status=${status}` : ''}`);
}

export function approveDigitalOrder(id: string): Promise<ApiDigitalOrder> {
  return request(`/digital-orders/${id}/approve`, { method: 'POST' });
}

export function rejectDigitalOrder(id: string, reason?: string): Promise<ApiDigitalOrder> {
  return request(`/digital-orders/${id}/reject`, { method: 'POST', body: JSON.stringify({ reason }) });
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

export interface ApiIngredient {
  id: string;
  name: string;
  category: string | null;
  base_unit: string;
  suggested_reorder_unit: string | null;
  cost_volatility: string | null;
  cost_volatility_tier: string | null;
  shelf_life_note: string | null;
  used_in_note: string | null;
  current_stock: number;
  reorder_threshold: number;
  needs_review: boolean;
  unit_cost: number | null;
}

export function fetchInventory(): Promise<ApiIngredient[]> {
  return request('/inventory');
}

export function fetchIngredient(id: string): Promise<ApiIngredient> {
  return request(`/inventory/${id}`);
}

export interface ApiExpiringIngredient {
  ingredient_id: string;
  ingredient_name: string;
  base_unit: string;
  expiry_date: string;
  days_until_expiry: number;
}

export function fetchExpiringSoon(days = 7): Promise<ApiExpiringIngredient[]> {
  return request(`/inventory/expiring-soon?days=${days}`);
}

export interface ApiLowStockStockItem {
  id: string;
  name: string;
  station: StockStation;
  current_stock: number;
  reorder_threshold: number;
  unit: string | null;
}

export interface ApiLowStockSummary {
  ingredient_count: number;
  stock_item_count: number;
  ingredients: ApiLowStockIngredient[];
  stock_items: ApiLowStockStockItem[];
}

export function fetchLowStockSummary(): Promise<ApiLowStockSummary> {
  return request('/inventory/low-stock-summary');
}

export function countStock(
  ingredientId: string,
  body: { employee_id: string; counted_stock: number }
): Promise<{ ingredient: ApiIngredient; movement: unknown; variance: number }> {
  return request(`/inventory/${ingredientId}/count`, { method: 'POST', body: JSON.stringify(body) });
}

export type CostVolatilityTier = 'low' | 'low_medium' | 'medium' | 'medium_high' | 'high';

export interface UpdateIngredientRequest {
  name?: string;
  category?: string | null;
  base_unit?: string;
  suggested_reorder_unit?: string | null;
  reorder_threshold?: number;
  cost_volatility?: string | null;
  cost_volatility_tier?: CostVolatilityTier | null;
  shelf_life_note?: string | null;
  used_in_note?: string | null;
  unit_cost?: number | null;
}

export function updateIngredient(id: string, body: UpdateIngredientRequest): Promise<ApiIngredient> {
  return request(`/inventory/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
}

export interface ApiIngredientRecipeUsage {
  product_name: string;
  size_label: string;
  qty_per_serving: number;
  unit: string;
}

export function fetchIngredientRecipeUsage(id: string): Promise<ApiIngredientRecipeUsage[]> {
  return request(`/inventory/${id}/recipe-usage`);
}

// 0030: Ingredient Stock's New Stocks/Beginning/Usage/Ending, computed the
// same way Station Items' already is (0028) -- see
// services/api-fastapi/app/routers/inventory.py's module docstring.
export interface ApiIngredientDailySummary {
  ingredient_id: string;
  count_date: string;
  beginning: number;
  beginning_source: 'carry_forward' | 'fallback';
  new_stocks: number;
  usage: number;
  ending: number;
  notes: string | null;
  needs_verification: boolean;
  overrides: Partial<Record<StockSummaryField, FieldOverride>>;
}

export interface IngredientFieldOverrideRequest {
  field: StockSummaryField;
  corrected_value: number;
  reason: string;
  employee_id: string;
  count_date?: string;
}

export function fetchIngredientCountEntries(params?: { date?: string }): Promise<ApiIngredientDailySummary[]> {
  const qs = new URLSearchParams();
  if (params?.date) qs.set('date', params.date);
  const query = qs.toString();
  return request(`/inventory/count-entries${query ? `?${query}` : ''}`);
}

export function overrideIngredientField(
  ingredientId: string,
  body: IngredientFieldOverrideRequest
): Promise<ApiIngredientDailySummary> {
  return request(`/inventory/${ingredientId}/field-override`, { method: 'POST', body: JSON.stringify(body) });
}

// 0028 adds sale_consumption/sale_consumption_reversal (Station Items'
// auto-deduction on sale/void) alongside the pre-existing manual types.
export type MovementType =
  | 'trans_in'
  | 'trans_out'
  | 'delivery'
  | 'transfer_in'
  | 'transfer_out'
  | 'count_adjustment'
  | 'sale_consumption'
  | 'sale_consumption_reversal';

export interface CreateInventoryMovementRequest {
  // Exactly one of ingredient_id/stock_item_id (0028).
  ingredient_id?: string | null;
  stock_item_id?: string | null;
  type: MovementType;
  department?: Department | null;
  quantity: number;
  reason?: string | null;
  reference_id?: string | null;
  employee_id: string;
  unit_cost_snapshot?: number | null;
  expiry_date?: string | null;
}

export interface ApiInventoryMovement {
  id: string;
  ingredient_id: string | null;
  stock_item_id: string | null;
  type: MovementType;
  department: Department | null;
  quantity: number;
  reason: string | null;
  reference_id: string | null;
  employee_id: string;
  unit_cost_snapshot: number | null;
  expiry_date: string | null;
  created_at: string;
}

export function createInventoryMovement(body: CreateInventoryMovementRequest): Promise<ApiInventoryMovement> {
  return request('/inventory-movements', { method: 'POST', body: JSON.stringify(body) });
}

export function fetchInventoryMovements(params?: {
  ingredient_id?: string;
  stock_item_id?: string;
  type?: MovementType;
  limit?: number;
}): Promise<ApiInventoryMovement[]> {
  const qs = new URLSearchParams();
  if (params?.ingredient_id) qs.set('ingredient_id', params.ingredient_id);
  if (params?.stock_item_id) qs.set('stock_item_id', params.stock_item_id);
  if (params?.type) qs.set('type', params.type);
  if (params?.limit) qs.set('limit', String(params.limit));
  const query = qs.toString();
  return request(`/inventory-movements${query ? `?${query}` : ''}`);
}

// ---------------------------------------------------------------------------
// Physical stock count tool (4 stations)
// ---------------------------------------------------------------------------

export type StockStation = 'tako_snack' | 'cafe_drinks' | 'sushi_kitchen_main' | 'ramen_hot_line';

export interface ApiStockItem {
  id: string;
  name: string;
  station: StockStation;
  category: string | null;
  unit: string | null;
  ingredient_id: string | null;
  ingredient_name: string | null;
  ingredient_current_stock: number | null;
  current_stock: number;
  reorder_threshold: number | null;
  active: boolean;
  needs_review: boolean;
  created_at: string;
  updated_at: string;
}

// 0028: the four sheet fields are computed server-side (auto-filled from
// sales/losses/deliveries/carry-forward), not typed by hand -- see
// services/api-fastapi/app/routers/stock_items.py's module docstring.
// `overrides` holds any field a staff member has flagged-and-corrected for
// this count_date, keyed by field name.
export interface FieldOverride {
  value: number;
  reason: string;
  by: string;
  at: string;
}

export type StockSummaryField = 'beginning' | 'new_stocks' | 'usage' | 'ending';

export interface ApiStockItemDailySummary {
  stock_item_id: string;
  count_date: string;
  beginning: number;
  beginning_source: 'carry_forward' | 'fallback';
  new_stocks: number;
  usage: number;
  ending: number;
  notes: string | null;
  needs_verification: boolean;
  overrides: Partial<Record<StockSummaryField, FieldOverride>>;
}

export interface UpdateStockItemNotesRequest {
  recorded_by: string;
  count_date?: string;
  notes?: string | null;
  needs_verification?: boolean;
}

export interface StockItemFieldOverrideRequest {
  field: StockSummaryField;
  corrected_value: number;
  reason: string;
  employee_id: string;
  count_date?: string;
}

export function fetchStockItems(params?: { station?: StockStation; active_only?: boolean }): Promise<ApiStockItem[]> {
  const qs = new URLSearchParams();
  if (params?.station) qs.set('station', params.station);
  if (params?.active_only !== undefined) qs.set('active_only', String(params.active_only));
  const query = qs.toString();
  return request(`/stock-items${query ? `?${query}` : ''}`);
}

export function createStockItem(body: {
  name: string;
  station: StockStation;
  category?: string | null;
  unit?: string | null;
  ingredient_id?: string | null;
  reorder_threshold?: number | null;
}): Promise<ApiStockItem> {
  return request('/stock-items', { method: 'POST', body: JSON.stringify(body) });
}

export function updateStockItem(
  id: string,
  body: Partial<{
    name: string;
    category: string | null;
    unit: string | null;
    ingredient_id: string | null;
    reorder_threshold: number | null;
    active: boolean;
    needs_review: boolean;
  }>
): Promise<ApiStockItem> {
  return request(`/stock-items/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
}

export function fetchStockCountEntries(params: { station: StockStation; date?: string }): Promise<ApiStockItemDailySummary[]> {
  const qs = new URLSearchParams({ station: params.station });
  if (params.date) qs.set('date', params.date);
  return request(`/stock-items/count-entries?${qs.toString()}`);
}

export function updateStockItemNotes(stockItemId: string, body: UpdateStockItemNotesRequest): Promise<{ ok: true }> {
  return request(`/stock-items/${stockItemId}/notes`, { method: 'POST', body: JSON.stringify(body) });
}

export function overrideStockItemField(
  stockItemId: string,
  body: StockItemFieldOverrideRequest
): Promise<ApiStockItemDailySummary> {
  return request(`/stock-items/${stockItemId}/field-override`, { method: 'POST', body: JSON.stringify(body) });
}

// ---------------------------------------------------------------------------
// Stock consumption rules (0028) -- the recipe_items equivalent for stock
// items, authored from Station Items' Manage Catalog tab.
// ---------------------------------------------------------------------------

export type StockConsumptionTrigger = 'per_product_unit' | 'per_transaction';

export interface ApiStockConsumptionRule {
  id: string;
  stock_item_id: string;
  trigger_type: StockConsumptionTrigger;
  product_size_id: string | null;
  product_name: string | null;
  size_label: string | null;
  order_type: OrderType | null;
  qty_per_unit: number;
  scale_by_guest_count: boolean;
  active: boolean;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateStockConsumptionRuleRequest {
  stock_item_id: string;
  trigger_type: StockConsumptionTrigger;
  product_size_id?: string | null;
  order_type?: OrderType | null;
  qty_per_unit: number;
  scale_by_guest_count?: boolean;
  active?: boolean;
  notes?: string | null;
}

export interface UpdateStockConsumptionRuleRequest {
  qty_per_unit?: number;
  scale_by_guest_count?: boolean;
  active?: boolean;
  notes?: string | null;
}

export function fetchStockConsumptionRules(params?: { stock_item_id?: string }): Promise<ApiStockConsumptionRule[]> {
  const qs = new URLSearchParams();
  if (params?.stock_item_id) qs.set('stock_item_id', params.stock_item_id);
  const query = qs.toString();
  return request(`/stock-consumption-rules${query ? `?${query}` : ''}`);
}

export function createStockConsumptionRule(body: CreateStockConsumptionRuleRequest): Promise<ApiStockConsumptionRule> {
  return request('/stock-consumption-rules', { method: 'POST', body: JSON.stringify(body) });
}

export function updateStockConsumptionRule(
  id: string,
  body: UpdateStockConsumptionRuleRequest
): Promise<ApiStockConsumptionRule> {
  return request(`/stock-consumption-rules/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
}

export function deleteStockConsumptionRule(id: string): Promise<{ ok: true }> {
  return request(`/stock-consumption-rules/${id}`, { method: 'DELETE' });
}

// ---------------------------------------------------------------------------
// Loss records
// ---------------------------------------------------------------------------

export type LossReason = 'spoilage' | 'breakage' | 'comp' | 'prep_error' | 'shrinkage';

export interface CreateLossRecordRequest {
  // Exactly one of ingredient_id/stock_item_id (0028).
  ingredient_id?: string | null;
  stock_item_id?: string | null;
  product_id?: string | null;
  employee_id: string;
  reason: LossReason;
  quantity: number;
  unit_cost?: number | null;
  cost_impact?: number | null;
  photo_url?: string | null;
  skip_stock_deduction?: boolean;
}

export interface ApiLossRecord {
  id: string;
  ingredient_id: string | null;
  stock_item_id: string | null;
  product_id: string | null;
  employee_id: string;
  reason: LossReason;
  quantity: number;
  cost_impact: number;
  photo_url: string | null;
  skip_stock_deduction: boolean;
  created_at: string;
}

export function createLossRecord(body: CreateLossRecordRequest): Promise<ApiLossRecord> {
  return request('/loss-records', { method: 'POST', body: JSON.stringify(body) });
}

export function fetchLossRecords(limit = 50): Promise<ApiLossRecord[]> {
  return request(`/loss-records?limit=${limit}`);
}

// ---------------------------------------------------------------------------
// Utility logs
// ---------------------------------------------------------------------------

export type UtilityType = 'electricity' | 'water' | 'gas';

export interface CreateUtilityLogRequest {
  utility_type: UtilityType;
  business_date: string;
  reading_start?: number | null;
  reading_end?: number | null;
  quantity?: number | null;
  unit_label?: string | null;
  days_covered?: number | null;
  unit_cost: number;
  recorded_by: string;
}

export interface ApiUtilityLog {
  id: string;
  utility_type: UtilityType;
  business_date: string;
  reading_start: number | null;
  reading_end: number | null;
  quantity: number | null;
  unit_label: string | null;
  days_covered: number | null;
  unit_cost: number;
  recorded_by: string;
  created_at: string;
  updated_at: string;
}

export function createUtilityLog(body: CreateUtilityLogRequest): Promise<ApiUtilityLog> {
  return request('/utility-logs', { method: 'POST', body: JSON.stringify(body) });
}

export function fetchUtilityLogs(limit = 50): Promise<ApiUtilityLog[]> {
  return request(`/utility-logs?limit=${limit}`);
}

// ---------------------------------------------------------------------------
// Employees
// ---------------------------------------------------------------------------

export interface ApiEmployee {
  id: string;
  full_name: string | null;
  role: UserRole;
  department: Department | null;
  position: string | null;
  pay_rate: number;
  employee_number: string | null;
}

export function fetchEmployees(): Promise<ApiEmployee[]> {
  return request('/employees');
}

export interface CreateEmployeeRequest {
  full_name: string;
  role?: UserRole;
  department?: Department | null;
  position?: string | null;
  pay_rate?: number;
}

export interface ApiEmployeeCreated {
  id: string;
  full_name: string | null;
  role: UserRole;
  department: Department | null;
  position: string | null;
  pay_rate: number;
  employee_number: string | null;
  email: string;
  default_password: string;
  default_pin: string;
}

export function createEmployee(body: CreateEmployeeRequest): Promise<ApiEmployeeCreated> {
  return request('/employees', { method: 'POST', body: JSON.stringify(body) });
}

export function setEmployeePin(employeeId: string, pin: string): Promise<{ status: string }> {
  return request(`/employees/${employeeId}/pin`, { method: 'PATCH', body: JSON.stringify({ pin }) });
}

// ---------------------------------------------------------------------------
// HR: attendance, payroll, holidays, pay rules, overrides, audit log
// ---------------------------------------------------------------------------

export type DayScenario =
  | 'regular_day'
  | 'regular_holiday'
  | 'regular_holiday_rest_day'
  | 'special_non_working'
  | 'special_non_working_rest_day'
  | 'special_working'
  | 'rest_day';

export type HolidayType = 'regular_holiday' | 'special_non_working' | 'special_working';
export type AttendanceStatus = 'working' | 'completed';
export type PayrollOverrideField = 'regular_hours' | 'overtime_hours' | 'night_diff_hours' | 'day_scenario';

export interface ApiAttendanceLog {
  id: string;
  employee_id: string;
  kiosk_id: string | null;
  clock_in: string;
  clock_out: string | null;
  date: string;
  hours_worked: number | null;
  regular_hours: number | null;
  overtime_hours: number | null;
  night_diff_hours: number | null;
  is_rest_day: boolean;
  holiday_id: string | null;
  day_scenario: DayScenario | null;
  status: AttendanceStatus;
  auto_closed: boolean;
  created_at: string;
  updated_at: string;
}

export function fetchMyAttendance(): Promise<ApiAttendanceLog | null> {
  return request('/attendance/me');
}

export function fetchAttendance(params?: { date_from?: string; date_to?: string; employee_id?: string }): Promise<ApiAttendanceLog[]> {
  const qs = new URLSearchParams();
  if (params?.date_from) qs.set('date_from', params.date_from);
  if (params?.date_to) qs.set('date_to', params.date_to);
  if (params?.employee_id) qs.set('employee_id', params.employee_id);
  const query = qs.toString();
  return request(`/attendance${query ? `?${query}` : ''}`);
}

export interface ApiPayrollRow {
  employee_id: string;
  employee_name: string;
  position: string | null;
  hours_worked: number;
  pay_rate: number;
  regular_hours: number | null;
  overtime_hours: number | null;
  night_diff_hours: number | null;
  regular_pay: number | null;
  overtime_pay: number | null;
  holiday_pay: number | null;
  night_diff_pay: number | null;
  total_pay: number;
}

export interface ApiPayrollSummary {
  period_start: string;
  period_end: string;
  rows: ApiPayrollRow[];
  total_hours: number;
  total_pay: number;
  employee_count: number;
  validation: { attendance_complete: boolean; holiday_configured: boolean; pending_overrides: number };
}

export function fetchAttendanceSummary(params: { date_from: string; date_to: string }): Promise<ApiPayrollSummary> {
  return request(`/attendance/summary?date_from=${params.date_from}&date_to=${params.date_to}`);
}

export interface ApiPayrollRecord {
  id: string;
  period_start: string;
  period_end: string;
  total_hours: number;
  total_pay: number;
  employee_count: number;
  generated_by: string;
  created_at: string;
  items: unknown[];
}

export function generatePayroll(body: { period_start: string; period_end: string }): Promise<ApiPayrollRecord> {
  return request('/payroll', { method: 'POST', body: JSON.stringify(body) });
}

export function fetchPayrollRecords(limit = 50): Promise<ApiPayrollRecord[]> {
  return request(`/payroll?limit=${limit}`);
}

export function fetchPayrollRecord(id: string): Promise<ApiPayrollRecord> {
  return request(`/payroll/${id}`);
}

export function fetchPayrollReceiptPdf(employeeId: string, periodStart: string, periodEnd: string): Promise<Blob> {
  return requestBlob(
    `/payroll/receipt.pdf?employee_id=${employeeId}&period_start=${periodStart}&period_end=${periodEnd}`
  );
}

export function fetchPayrollReceiptsZip(periodStart: string, periodEnd: string): Promise<Blob> {
  return requestBlob(`/payroll/receipts.zip?period_start=${periodStart}&period_end=${periodEnd}`);
}

export interface ApiHoliday {
  id: string;
  holiday_date: string;
  name: string;
  holiday_type: HolidayType;
  is_recurring: boolean;
  created_at: string;
}

export function fetchHolidays(year: number): Promise<ApiHoliday[]> {
  return request(`/hr/holidays?year=${year}`);
}

export function createHoliday(body: { holiday_date: string; name: string; holiday_type: HolidayType; is_recurring?: boolean }): Promise<ApiHoliday> {
  return request('/hr/holidays', { method: 'POST', body: JSON.stringify(body) });
}

export function updateHoliday(
  id: string,
  body: Partial<{ holiday_date: string; name: string; holiday_type: HolidayType; is_recurring: boolean }>
): Promise<ApiHoliday> {
  return request(`/hr/holidays/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
}

export function deleteHoliday(id: string): Promise<{ deleted: boolean }> {
  return request(`/hr/holidays/${id}`, { method: 'DELETE' });
}

export interface ApiPayRule {
  id: string;
  scenario_key: DayScenario;
  not_worked_pct: number;
  first_8hr_pct: number;
  ot_addon_pct: number;
  night_diff_addon_pct: number;
  updated_at: string;
  updated_by: string | null;
}

export function fetchPayRules(): Promise<ApiPayRule[]> {
  return request('/hr/pay-rules');
}

export function updatePayRule(
  scenarioKey: DayScenario,
  body: Partial<{ not_worked_pct: number; first_8hr_pct: number; ot_addon_pct: number; night_diff_addon_pct: number }>
): Promise<ApiPayRule> {
  return request(`/hr/pay-rules/${scenarioKey}`, { method: 'PATCH', body: JSON.stringify(body) });
}

export interface ApiPayrollOverride {
  id: string;
  attendance_log_id: string;
  field: PayrollOverrideField;
  old_value: string | null;
  new_value: string;
  reason: string;
  requested_by: string;
  approved_by: string | null;
  created_at: string;
  approved_at: string | null;
}

export function createPayrollOverride(body: {
  attendance_log_id: string;
  field: PayrollOverrideField;
  new_value: string;
  reason: string;
}): Promise<ApiPayrollOverride> {
  return request('/hr/payroll-overrides', { method: 'POST', body: JSON.stringify(body) });
}

export function approvePayrollOverride(id: string): Promise<ApiPayrollOverride> {
  return request(`/hr/payroll-overrides/${id}/approve`, { method: 'PATCH' });
}

export interface ApiPayrollAuditLogEntry {
  id: string;
  actor_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  old_value: unknown;
  new_value: unknown;
  reason: string | null;
  created_at: string;
}

export function fetchPayrollAuditLog(params?: { entity_type?: string; limit?: number }): Promise<ApiPayrollAuditLogEntry[]> {
  const qs = new URLSearchParams();
  if (params?.entity_type) qs.set('entity_type', params.entity_type);
  if (params?.limit) qs.set('limit', String(params.limit));
  const query = qs.toString();
  return request(`/hr/payroll-audit-log${query ? `?${query}` : ''}`);
}

// ---------------------------------------------------------------------------
// Dashboard summary (Command Center) / analytics (Trend Analysis)
// ---------------------------------------------------------------------------

export interface ApiLowStockIngredient {
  id: string;
  name: string;
  current_stock: number;
  reorder_threshold: number;
  base_unit: string;
}

export interface ApiUtilityCostBreakdown {
  utility_type: UtilityType;
  cost: number;
}

export interface ApiDepartmentBreakdown {
  department: Department;
  item_revenue: number;
  item_count: number;
}

export interface ApiDashboardSummary {
  date: string;
  revenue: number;
  discount_total: number;
  tax_total: number;
  order_count: number;
  loss_total: number;
  low_stock_ingredients: ApiLowStockIngredient[];
  utility_cost_today: number;
  utility_breakdown: ApiUtilityCostBreakdown[];
  by_department: ApiDepartmentBreakdown[];
  staff_clocked_in: number | null;
  hr_available: boolean;
}

export function fetchDashboardSummary(onDate?: string): Promise<ApiDashboardSummary> {
  return request(`/dashboard/summary${onDate ? `?date=${onDate}` : ''}`);
}

export interface ApiSalesTrendPoint {
  date: string;
  revenue: number;
  order_count: number;
}

export interface ApiSalesTrend {
  date_from: string;
  date_to: string;
  points: ApiSalesTrendPoint[];
  total_revenue: number;
  total_orders: number;
}

export function fetchSalesTrend(params?: { date_from?: string; date_to?: string }): Promise<ApiSalesTrend> {
  const qs = new URLSearchParams();
  if (params?.date_from) qs.set('date_from', params.date_from);
  if (params?.date_to) qs.set('date_to', params.date_to);
  const query = qs.toString();
  return request(`/analytics/sales-trend${query ? `?${query}` : ''}`);
}

export interface ApiTopProductRow {
  product_id: string;
  product_name: string;
  quantity_sold: number;
  revenue: number;
}

export interface ApiTopProducts {
  date_from: string;
  date_to: string;
  products: ApiTopProductRow[];
}

export function fetchTopProducts(params?: { date_from?: string; date_to?: string; limit?: number }): Promise<ApiTopProducts> {
  const qs = new URLSearchParams();
  if (params?.date_from) qs.set('date_from', params.date_from);
  if (params?.date_to) qs.set('date_to', params.date_to);
  if (params?.limit) qs.set('limit', String(params.limit));
  const query = qs.toString();
  return request(`/analytics/top-products${query ? `?${query}` : ''}`);
}

// ---------------------------------------------------------------------------
// P&L (executive-only)
// ---------------------------------------------------------------------------

export type PnLPeriod = 'today' | 'week' | 'month';

export interface ApiPnLCostBreakdown {
  cogs: number;
  payroll: number;
  utilities: number;
  losses: number;
}

export interface ApiPnLDepartmentMargin {
  department: Department;
  revenue: number;
  cogs: number;
  margin: number;
  margin_pct: number | null;
}

export interface ApiPnLLossByReason {
  reason: LossReason;
  cost_impact: number;
}

export interface ApiPnL {
  period: PnLPeriod;
  date_from: string;
  date_to: string;
  revenue: number;
  discount_total: number;
  tax_total: number;
  order_count: number;
  gross_profit: number;
  net_profit: number;
  food_cost_pct: number | null;
  costs: ApiPnLCostBreakdown;
  losses_by_reason: ApiPnLLossByReason[];
  department_margins: ApiPnLDepartmentMargin[];
  ingredients_missing_cost: number;
  ingredients_total: number;
  unfulfilled_bundle_sales: number;
  payroll_employee_count: number;
}

export function fetchPnL(period: PnLPeriod): Promise<ApiPnL> {
  return request(`/pnl?period=${period}`);
}

// ---------------------------------------------------------------------------
// Oishii AI
// ---------------------------------------------------------------------------

export interface ApiOishiAiChartPoint {
  label: string;
  value: number;
}

export interface ApiOishiAiChartSeries {
  name: string;
  data: ApiOishiAiChartPoint[];
}

export interface ApiOishiAiChartSpec {
  type: 'bar' | 'line';
  title: string;
  series: ApiOishiAiChartSeries[];
}

export interface ApiOishiAiQueryResponse {
  answer: string;
  chart: ApiOishiAiChartSpec | null;
}

export function queryOishiAi(question: string): Promise<ApiOishiAiQueryResponse> {
  return request('/ai/query', { method: 'POST', body: JSON.stringify({ question }) });
}

// ---------------------------------------------------------------------------
// Business settings (VAT rate)
// ---------------------------------------------------------------------------

export interface ApiBusinessSettings {
  vat_rate: number;
  open_time: string;
  close_time: string;
  closed_weekdays: number[];
  updated_at: string;
  updated_by: string | null;
}

export function fetchBusinessSettings(): Promise<ApiBusinessSettings> {
  return request('/settings/business');
}

export function updateBusinessSettings(
  body: Partial<{ vat_rate: number; open_time: string; close_time: string; closed_weekdays: number[] }>
): Promise<ApiBusinessSettings> {
  return request('/settings/business', { method: 'PATCH', body: JSON.stringify(body) });
}

// ---------------------------------------------------------------------------
// Table reservations
// ---------------------------------------------------------------------------

export interface ApiTable {
  id: string;
  label: string;
  capacity: number;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export function fetchTables(): Promise<ApiTable[]> {
  return request('/tables');
}

export function createTable(body: { label: string; capacity: number }): Promise<ApiTable> {
  return request('/tables', { method: 'POST', body: JSON.stringify(body) });
}

export function updateTable(
  id: string,
  body: Partial<{ label: string; capacity: number; active: boolean }>
): Promise<ApiTable> {
  return request(`/tables/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
}

export type ReservationStatus = 'pending' | 'confirmed' | 'declined' | 'cancelled';

export interface ApiReservation {
  id: string;
  reservation_number: number;
  table_id: string;
  table_label: string | null;
  party_size: number;
  reservation_date: string;
  start_time: string;
  end_time: string;
  status: ReservationStatus;
  customer_name: string;
  customer_phone: string;
  customer_note: string | null;
  declined_reason: string | null;
  created_at: string;
}

export function fetchReservations(status?: ReservationStatus, date?: string): Promise<ApiReservation[]> {
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  if (date) params.set('date', date);
  const query = params.toString();
  return request(`/reservations${query ? `?${query}` : ''}`);
}

export function confirmReservation(id: string): Promise<ApiReservation> {
  return request(`/reservations/${id}/confirm`, { method: 'POST' });
}

export function declineReservation(id: string, reason: string): Promise<ApiReservation> {
  return request(`/reservations/${id}/decline`, { method: 'POST', body: JSON.stringify({ reason }) });
}

export function cancelReservation(id: string): Promise<ApiReservation> {
  return request(`/reservations/${id}/cancel`, { method: 'POST' });
}
