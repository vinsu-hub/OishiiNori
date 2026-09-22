import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

export default defineConfig({
  // Served at oishiinori.com/staff-clock via apps/landing-page's vercel.json
  // rewrite -- see dashboard-web/vite.config.ts's comment for why this is
  // an absolute, fixed prefix (standalone URL not expected to keep working).
  base: '/staff-clock/',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'client', 'src'),
    },
  },
  envDir: path.resolve(__dirname),
  root: path.resolve(__dirname, 'client'),
  build: {
    outDir: path.resolve(__dirname, 'dist/public'),
    emptyOutDir: true,
  },
  server: {
    port: 5174,
    strictPort: false,
    host: true,
  },
});
