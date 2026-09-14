import React from 'react';
import ReactDOM from 'react-dom/client';
import { Toaster } from '@/components/ui/Toaster';
import App from './App';
import OfflineBanner from '@/components/OfflineBanner';
import { initOfflineQueue } from '@/lib/offlineQueue';
import './index.css';

initOfflineQueue();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <OfflineBanner />
    <App />
    <Toaster position="top-right" />
  </React.StrictMode>
);
