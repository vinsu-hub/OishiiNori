import React from 'react';
import ReactDOM from 'react-dom/client';
import { Toaster } from '@/components/ui/Toaster';
import App from './App';
import TvDisplay from '@/components/TvDisplay';
import OfflineBanner from '@/components/OfflineBanner';
import { initOfflineQueue } from '@/lib/offlineQueue';
import './index.css';

initOfflineQueue();

// The restaurant TV board lives at /tv on the same deployment (vercel.json's
// catch-all rewrite already serves index.html for any path). A suffix check
// rather than an exact match, since this app is served at oishiinori.com/menu
// (apps/landing-page's vercel.json rewrite) -- the real path is /menu/tv,
// not /tv.
const isTvDisplay = window.location.pathname.replace(/\/+$/, '').endsWith('/tv');

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {isTvDisplay ? (
      <TvDisplay />
    ) : (
      <>
        <OfflineBanner />
        <App />
        <Toaster position="top-right" />
      </>
    )}
  </React.StrictMode>
);
