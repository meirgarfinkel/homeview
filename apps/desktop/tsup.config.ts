import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { main: 'src/main.ts' },
  format: ['esm'],
  outExtension: () => ({ js: '.mjs' }),
  target: 'node22',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  // Bundle the server and every dependency except Electron itself, so the
  // packaged app needs no node_modules. A plain /.*/ here would also pull in
  // the electron package, because noExternal wins over external.
  noExternal: [/^(?!electron$)/],
  external: ['electron'],
  // Bundled CommonJS packages call require; give them one.
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
});
