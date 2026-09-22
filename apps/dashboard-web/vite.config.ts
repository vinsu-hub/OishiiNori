import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  // Served at oishiinori.com/dashboard via apps/landing-page's vercel.json
  // rewrite -- every asset reference needs this prefix baked in, or the
  // browser (sitting on oishiinori.com) requests them at the wrong path.
  // This is an absolute, fixed prefix: the standalone
  // oishii-nori-dashboard.vercel.app URL is not expected to keep working
  // after this (see the plan this shipped under).
  base: "/dashboard/",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "client", "src"),
      "@shared": path.resolve(import.meta.dirname, "shared"),
    },
  },
  envDir: path.resolve(import.meta.dirname),
  root: path.resolve(import.meta.dirname, "client"),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
  },
  server: {
    port: 3000,
    strictPort: false,
    host: true,
  },
});
