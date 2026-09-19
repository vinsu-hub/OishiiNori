import { Suspense } from 'react';
import { lazyWithReload } from '@/lib/lazyWithReload';
import { Loader2 } from 'lucide-react';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Route, Switch } from 'wouter';
import ErrorBoundary from './components/ErrorBoundary';
import { ThemeProvider } from './contexts/ThemeContext';
import { AuthProvider } from './contexts/AuthContext';
import { SyncProvider } from './contexts/SyncContext';
import { InventoryAlertsProvider } from './contexts/InventoryAlertsContext';

// Login is kept as a static import -- it's the first thing an unauthenticated
// user sees, so it shouldn't wait on an extra chunk fetch + Suspense frame.
// Every other route is lazy so a given session only ever downloads the page
// code its role can actually reach (e.g. an employee never fetches P&L,
// Command Center, Menu Editing, or Oishii AI's chunk).
import Login from './pages/Login';
// lazyWithReload (not bare React.lazy): a chunk fetch that fails because a new
// deploy replaced the old hashed filenames triggers one full reload to pick up
// the current index.html, instead of dropping to the ErrorBoundary.
const Home = lazyWithReload(() => import('./pages/Home'), 'Home');
const POSTerminal = lazyWithReload(() => import('./pages/POSTerminal'), 'POSTerminal');
const OrderQueue = lazyWithReload(() => import('./pages/OrderQueue'), 'OrderQueue');
const PendingOrders = lazyWithReload(() => import('./pages/PendingOrders'), 'PendingOrders');
const KitchenDisplay = lazyWithReload(() => import('./pages/KitchenDisplay'), 'KitchenDisplay');
const Reservations = lazyWithReload(() => import('./pages/Reservations'), 'Reservations');
const POSManagement = lazyWithReload(() => import('./pages/POSManagement'), 'POSManagement');
const CommandCenter = lazyWithReload(() => import('./pages/CommandCenter'), 'CommandCenter');
const TrendAnalysis = lazyWithReload(() => import('./pages/TrendAnalysis'), 'TrendAnalysis');
const MenuEditing = lazyWithReload(() => import('./pages/MenuEditing'), 'MenuEditing');
const PnL = lazyWithReload(() => import('./pages/PnL'), 'PnL');
const OishiAi = lazyWithReload(() => import('./pages/OishiAi'), 'OishiAi');
const Help = lazyWithReload(() => import('./pages/Help'), 'Help');
const Stock = lazyWithReload(() => import('./pages/Stock'), 'Stock');
const StockOverview = lazyWithReload(() => import('./pages/StockOverview'), 'StockOverview');
const StockAlerts = lazyWithReload(() => import('./pages/StockAlerts'), 'StockAlerts');
const StockVarianceLog = lazyWithReload(() => import('./pages/StockVarianceLog'), 'StockVarianceLog');
const InventoryMovements = lazyWithReload(() => import('./pages/InventoryMovements'), 'InventoryMovements');
const LossLog = lazyWithReload(() => import('./pages/LossLog'), 'LossLog');
const UtilityLog = lazyWithReload(() => import('./pages/UtilityLog'), 'UtilityLog');
const HRAttendance = lazyWithReload(() => import('./pages/HRAttendance'), 'HRAttendance');
const HRPayroll = lazyWithReload(() => import('./pages/HRPayroll'), 'HRPayroll');
const HolidayCalendar = lazyWithReload(() => import('./pages/HolidayCalendar'), 'HolidayCalendar');
const PayrollSettings = lazyWithReload(() => import('./pages/PayrollSettings'), 'PayrollSettings');
const Employees = lazyWithReload(() => import('./pages/Employees'), 'Employees');
const BusinessDayReport = lazyWithReload(() => import('./pages/BusinessDayReport'), 'BusinessDayReport');
const RefundApproval = lazyWithReload(() => import('./pages/RefundApproval'), 'RefundApproval');
const Reviews = lazyWithReload(() => import('./pages/Reviews'), 'Reviews');
const Delivery = lazyWithReload(() => import('./pages/Delivery'), 'Delivery');
const DeliveryRequests = lazyWithReload(() => import('./pages/DeliveryRequests'), 'DeliveryRequests');
const OnlineOrders = lazyWithReload(() => import('./pages/OnlineOrders'), 'OnlineOrders');
const ScheduledOrders = lazyWithReload(() => import('./pages/ScheduledOrders'), 'ScheduledOrders');
const StockVS = lazyWithReload(() => import('./pages/StockVS'), 'StockVS');
const Settings = lazyWithReload(() => import('./pages/Settings'), 'Settings');
const NotFound = lazyWithReload(() => import('./pages/NotFound'), 'NotFound');

function RouteFallback() {
  return (
    <div className="flex items-center justify-center min-h-screen text-muted-foreground">
      <Loader2 className="w-6 h-6 animate-spin" />
    </div>
  );
}

function Router() {
  return (
    <Suspense fallback={<RouteFallback />}>
      <Switch>
        <Route path={'/login'} component={Login} />
        <Route path={'/'} component={Home} />
        <Route path={'/pos'} component={POSTerminal} />
        <Route path={'/order-queue'} component={OrderQueue} />
        <Route path={'/pending-orders'} component={PendingOrders} />
        <Route path={'/kitchen-display'} component={KitchenDisplay} />
        <Route path={'/reservations'} component={Reservations} />
        <Route path={'/pos-management'} component={POSManagement} />
        <Route path={'/command-center'} component={CommandCenter} />
        <Route path={'/trends'} component={TrendAnalysis} />
        <Route path={'/menu-editing'} component={MenuEditing} />
        <Route path={'/pnl'} component={PnL} />
        <Route path={'/oishii-ai'} component={OishiAi} />
        <Route path={'/help'} component={Help} />
        <Route path={'/stock/overview'} component={StockOverview} />
        <Route path={'/stock/alerts'} component={StockAlerts} />
        <Route path={'/stock/variance-log'} component={StockVarianceLog} />
        <Route path={'/stock'} component={Stock} />
        {/* Legacy paths -- Stock.tsx reads the pathname to land on the right tab */}
        <Route path={'/inventory-count'} component={Stock} />
        <Route path={'/stock-count'} component={Stock} />
        <Route path={'/inventory-movements'} component={InventoryMovements} />
        <Route path={'/business-day-report'} component={BusinessDayReport} />
        <Route path={'/refund-approval'} component={RefundApproval} />
        <Route path={'/reviews'} component={Reviews} />
        <Route path={'/delivery'} component={Delivery} />
        <Route path={'/delivery-requests'} component={DeliveryRequests} />
        <Route path={'/online-orders'} component={OnlineOrders} />
        <Route path={'/scheduled-orders'} component={ScheduledOrders} />
        <Route path={'/stock/vs'} component={StockVS} />
        <Route path={'/loss-log'} component={LossLog} />
        <Route path={'/utility-log'} component={UtilityLog} />
        <Route path={'/hr/attendance'} component={HRAttendance} />
        <Route path={'/hr/payroll'} component={HRPayroll} />
        <Route path={'/hr/holiday-calendar'} component={HolidayCalendar} />
        <Route path={'/hr/payroll-settings'} component={PayrollSettings} />
        <Route path={'/employees'} component={Employees} />
        <Route path={'/settings'} component={Settings} />
        <Route path={'/404'} component={NotFound} />
        <Route component={NotFound} />
      </Switch>
    </Suspense>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="light">
        <AuthProvider>
          <SyncProvider>
            <InventoryAlertsProvider>
              <TooltipProvider>
                <Toaster />
                <Router />
              </TooltipProvider>
            </InventoryAlertsProvider>
          </SyncProvider>
        </AuthProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
