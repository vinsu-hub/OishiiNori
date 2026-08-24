import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Route, Switch } from 'wouter';
import ErrorBoundary from './components/ErrorBoundary';
import { ThemeProvider } from './contexts/ThemeContext';
import { AuthProvider } from './contexts/AuthContext';
import { SyncProvider } from './contexts/SyncContext';
import { InventoryAlertsProvider } from './contexts/InventoryAlertsContext';

import Login from './pages/Login';
import Home from './pages/Home';
import POSTerminal from './pages/POSTerminal';
import OrderQueue from './pages/OrderQueue';
import PendingOrders from './pages/PendingOrders';
import KitchenDisplay from './pages/KitchenDisplay';
import POSManagement from './pages/POSManagement';
import CommandCenter from './pages/CommandCenter';
import TrendAnalysis from './pages/TrendAnalysis';
import MenuEditing from './pages/MenuEditing';
import PnL from './pages/PnL';
import OishiAi from './pages/OishiAi';
import Help from './pages/Help';
import Stock from './pages/Stock';
import StockOverview from './pages/StockOverview';
import StockAlerts from './pages/StockAlerts';
import StockVarianceLog from './pages/StockVarianceLog';
import InventoryMovements from './pages/InventoryMovements';
import LossLog from './pages/LossLog';
import UtilityLog from './pages/UtilityLog';
import HRAttendance from './pages/HRAttendance';
import HRPayroll from './pages/HRPayroll';
import HolidayCalendar from './pages/HolidayCalendar';
import PayrollSettings from './pages/PayrollSettings';
import Employees from './pages/Employees';
import Settings from './pages/Settings';
import NotFound from './pages/NotFound';

function Router() {
  return (
    <Switch>
      <Route path={'/login'} component={Login} />
      <Route path={'/'} component={Home} />
      <Route path={'/pos'} component={POSTerminal} />
      <Route path={'/order-queue'} component={OrderQueue} />
      <Route path={'/pending-orders'} component={PendingOrders} />
      <Route path={'/kitchen-display'} component={KitchenDisplay} />
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
