import NotFound from "@/pages/NotFound";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import { Toaster } from "./components/ui/Toaster";
import Home from "./pages/Home";

function Router() {
  return (
    <Switch>
      <Route path={"/"}>{() => <Home />}</Route>
      <Route path={"/404"} component={NotFound} />
      {/* Final fallback route */}
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="light">
        <Toaster position="top-right" />
        <Router />
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
