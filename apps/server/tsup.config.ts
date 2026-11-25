import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    server: 'src/server.ts',
    discover: 'src/scripts/discover.ts',
    probe: 'src/scripts/probe.ts',
    'setup-camera': 'src/scripts/setupCamera.ts',
  },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  // Bundle the workspace package; keep real npm dependencies external.
  noExternal: ['@kasa/shared'],
});
