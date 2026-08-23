import React, { useState } from 'react';
import { DashboardLayout } from '@/components/DashboardLayout';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { IngredientsPanel } from '@/components/stock/IngredientsPanel';
import { StationsPanel } from '@/components/stock/StationsPanel';

type StockTab = 'ingredients' | 'stations';

// Reads the legacy /inventory-count and /stock-count paths (and a ?tab=
// query param) so existing bookmarks/links still land on the right tab of
// this merged page instead of a 404 -- see App.tsx's route registration.
function getInitialTab(): StockTab {
  if (typeof window === 'undefined') return 'ingredients';
  if (window.location.pathname === '/stock-count') return 'stations';
  if (new URLSearchParams(window.location.search).get('tab') === 'stations') return 'stations';
  return 'ingredients';
}

export default function Stock() {
  const [activeTab, setActiveTab] = useState<StockTab>(getInitialTab);

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
