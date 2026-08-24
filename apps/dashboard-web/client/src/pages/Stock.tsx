import React, { useEffect, useState } from 'react';
import { useLocation, useSearch } from 'wouter';
import { DashboardLayout } from '@/components/DashboardLayout';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { IngredientsPanel } from '@/components/stock/IngredientsPanel';
import { StationsPanel } from '@/components/stock/StationsPanel';

type StockTab = 'ingredients' | 'stations';

// Reads the legacy /inventory-count and /stock-count paths (and a ?tab=
// query param) so existing bookmarks/links -- and the Sidebar's Stock group
// sub-links -- land on the right tab of this merged page instead of a 404.
// Re-evaluated on every location/search change (not just on mount), since
// wouter keeps this component instance mounted when only the query string
// changes (e.g. clicking "Station Items" while already on "Recipe
// Ingredients") -- a mount-only read would silently no-op on that click.
function resolveTab(pathname: string, search: string): StockTab {
  if (pathname === '/stock-count') return 'stations';
  if (new URLSearchParams(search).get('tab') === 'stations') return 'stations';
  return 'ingredients';
}

export default function Stock() {
  const [location] = useLocation();
  const search = useSearch();
  const [activeTab, setActiveTab] = useState<StockTab>(() => resolveTab(location, search));

  useEffect(() => {
    setActiveTab(resolveTab(location, search));
  }, [location, search]);

  return (
    <DashboardLayout title="Stock">
      <div className="p-6 space-y-4">
        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as StockTab)}>
          <TabsList>
            <TabsTrigger value="ingredients">Recipe Ingredients</TabsTrigger>
            <TabsTrigger value="stations">Station Items</TabsTrigger>
          </TabsList>
        </Tabs>

        {/* Both panels stay mounted (just hidden) so switching tabs is instant
            and doesn't lose in-progress work or re-fetch on every click --
            the whole point of merging these into one shell. */}
        <div className={activeTab === 'ingredients' ? '' : 'hidden'}>
          <IngredientsPanel onViewStations={() => setActiveTab('stations')} />
        </div>
        <div className={activeTab === 'stations' ? '' : 'hidden'}>
          <StationsPanel onViewIngredients={() => setActiveTab('ingredients')} />
        </div>
      </div>
    </DashboardLayout>
  );
}
