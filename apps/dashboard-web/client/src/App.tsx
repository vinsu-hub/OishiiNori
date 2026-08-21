import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Route, Switch } from 'wouter';
import ErrorBoundary from './components/ErrorBoundary';
import { ThemeProvider } from './contexts/ThemeContext';
import { AuthProvider } from './contexts/AuthContext';
import { SyncProvider } from './contexts/SyncContext';

import Login from './pages/Login';
import Home from './pages/Home';
import POSTerminal from './pages/POSTerminal';
import OrderQueue from './pages/OrderQueue';
import KitchenDisplay from './pages/KitchenDisplay';
import InventoryCount from './pages/InventoryCount';
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
      <Route path={'/kitchen-display'} component={KitchenDisplay} />
      <Route path={'/inventory-count'} component={InventoryCount} />
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
            <TooltipProvider>
              <Toaster />
              <Router />
            </TooltipProvider>
          </SyncProvider>
        </AuthProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
