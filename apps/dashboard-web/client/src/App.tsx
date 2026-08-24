import { lazy, Suspense } from 'react';
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
const Home = lazy(() => import('./pages/Home'));
const POSTerminal = lazy(() => import('./pages/POSTerminal'));
const OrderQueue = lazy(() => import('./pages/OrderQueue'));
const PendingOrders = lazy(() => import('./pages/PendingOrders'));
const KitchenDisplay = lazy(() => import('./pages/KitchenDisplay'));
const Reservations = lazy(() => import('./pages/Reservations'));
const POSManagement = lazy(() => import('./pages/POSManagement'));
const CommandCenter = lazy(() => import('./pages/CommandCenter'));
const TrendAnalysis = lazy(() => import('./pages/TrendAnalysis'));
const MenuEditing = lazy(() => import('./pages/MenuEditing'));
const PnL = lazy(() => import('./pages/PnL'));
const OishiAi = lazy(() => import('./pages/OishiAi'));
const Help = lazy(() => import('./pages/Help'));
const Stock = lazy(() => import('./pages/Stock'));
const StockOverview = lazy(() => import('./pages/StockOverview'));
const StockAlerts = lazy(() => import('./pages/StockAlerts'));
const StockVarianceLog = lazy(() => import('./pages/StockVarianceLog'));
const InventoryMovements = lazy(() => import('./pages/InventoryMovements'));
const LossLog = lazy(() => import('./pages/LossLog'));
const UtilityLog = lazy(() => import('./pages/UtilityLog'));
const HRAttendance = lazy(() => import('./pages/HRAttendance'));
const HRPayroll = lazy(() => import('./pages/HRPayroll'));
const HolidayCalendar = lazy(() => import('./pages/HolidayCalendar'));
const PayrollSettings = lazy(() => import('./pages/PayrollSettings'));
const Employees = lazy(() => import('./pages/Employees'));
const Settings = lazy(() => import('./pages/Settings'));
const NotFound = lazy(() => import('./pages/NotFound'));

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
