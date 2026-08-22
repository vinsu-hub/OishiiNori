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

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL as string;

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

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

export type KitchenStatus = 'queued' | 'preparing' | 'ready' | 'completed';
export type TransactionStatus = 'open' | 'closed' | 'voided';

export interface CreateTransactionItem {
  product_size_id: string;
  quantity: number;
  held_ingredients?: string[];
}

export interface CreateTransactionRequest {
  employee_id: string;
  items: CreateTransactionItem[];
  discount_type_id?: string | null;
  is_owner_request?: boolean;
  owner_request_employee_number?: string | null;
  owner_request_pin?: string | null;
  owner_request_note?: string | null;
}

export interface ApiTransactionItem {
  id: string;
  transaction_id: string;
  product_size_id: string;
  quantity: number;
  unit_price: number;
  held_ingredients: string[];
  bundle_fulfilled: boolean;
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
  items: ApiTransactionItem[];
}

export function createTransaction(body: CreateTransactionRequest): Promise<ApiTransaction> {
  return request('/transactions', { method: 'POST', body: JSON.stringify(body) });
}

export function fetchTransactions(): Promise<ApiTransaction[]> {
  return request('/transactions');
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
}

export function fetchInventory(): Promise<ApiIngredient[]> {
  return request('/inventory');
}

export function fetchIngredient(id: string): Promise<ApiIngredient> {
  return request(`/inventory/${id}`);
}

export function countStock(
  ingredientId: string,
  body: { employee_id: string; counted_stock: number }
): Promise<{ ingredient: ApiIngredient; movement: unknown; variance: number }> {
  return request(`/inventory/${ingredientId}/count`, { method: 'POST', body: JSON.stringify(body) });
}

export type MovementType = 'trans_in' | 'trans_out' | 'delivery' | 'transfer_in' | 'transfer_out' | 'count_adjustment';

export interface CreateInventoryMovementRequest {
  ingredient_id: string;
  type: MovementType;
  department?: Department | null;
  quantity: number;
  reason?: string | null;
  reference_id?: string | null;
  employee_id: string;
  unit_cost_snapshot?: number | null;
}

export interface ApiInventoryMovement {
  id: string;
  ingredient_id: string;
  type: MovementType;
  department: Department | null;
  quantity: number;
  reason: string | null;
  reference_id: string | null;
  employee_id: string;
  unit_cost_snapshot: number | null;
  created_at: string;
}

export function createInventoryMovement(body: CreateInventoryMovementRequest): Promise<ApiInventoryMovement> {
  return request('/inventory-movements', { method: 'POST', body: JSON.stringify(body) });
}

export function fetchInventoryMovements(params?: { ingredient_id?: string; type?: MovementType; limit?: number }): Promise<ApiInventoryMovement[]> {
  const qs = new URLSearchParams();
  if (params?.ingredient_id) qs.set('ingredient_id', params.ingredient_id);
  if (params?.type) qs.set('type', params.type);
  if (params?.limit) qs.set('limit', String(params.limit));
  const query = qs.toString();
  return request(`/inventory-movements${query ? `?${query}` : ''}`);
}

// ---------------------------------------------------------------------------
// Loss records
// ---------------------------------------------------------------------------

export type LossReason = 'spoilage' | 'breakage' | 'comp' | 'prep_error' | 'shrinkage';

export interface CreateLossRecordRequest {
  ingredient_id: string;
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
  ingredient_id: string;
  product_id: string | null;
  employee_id: string;
  reason: LossReason;
  quantity: number;
  cost_impact: number;
  photo_url: string | null;
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
