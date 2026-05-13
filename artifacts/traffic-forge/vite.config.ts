import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// API_PORT explicitly sets the backend port; fall back to 8080 for local dev.
// Do NOT use process.env.PORT — that var is owned by Vite's own dev server port.
const apiPort = process.env.API_PORT ?? '8080';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5000,
    allowedHosts: true,
    proxy: {
      '/api': {
        target: `http://localhost:${apiPort}`,
        changeOrigin: true,
      },
      '/ws': {
        target: `ws://localhost:${apiPort}`,
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist/public',
    emptyOutDir: true,
  },
});
