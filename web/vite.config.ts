import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development the API server runs on :8787; Vite proxies HTTP and WebSocket traffic to it.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8787',
      '/collab': { target: 'ws://localhost:8787', ws: true },
    },
  },
});
