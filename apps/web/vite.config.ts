import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const API_TARGET = process.env['API_URL'] ?? 'https://127.0.0.1:8090';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Dev server stays on this machine; use the built app for LAN viewing.
    host: '127.0.0.1',
    proxy: {
      // The API server uses a self-signed certificate.
      '/api': { target: API_TARGET, ws: true, secure: false },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
