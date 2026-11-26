import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    // jsdom for every test: the component tests need it and g711.test.ts does not mind it.
    environment: 'jsdom',
  },
});
