import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// Plain multi-input MV3 build. Each HTML page and the service worker is its
// own ES-module entry. Output is a flat, predictable dist/ that Chrome loads
// via "Load unpacked". manifest.json is copied verbatim from public/.
export default defineConfig({
  root: '.',
  publicDir: 'public',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // No hashed filenames: the manifest references stable paths.
    target: 'es2022',
    modulePreload: false,
    rollupOptions: {
      input: {
        gate: resolve(__dirname, 'src/gate/gate.html'),
        popup: resolve(__dirname, 'src/popup/popup.html'),
        settings: resolve(__dirname, 'src/settings/settings.html'),
        background: resolve(__dirname, 'src/background/index.ts'),
      },
      output: {
        // Service worker must be a single, stably-named file referenced by the
        // manifest. Keep entry names stable and predictable.
        entryFileNames: (chunk) =>
          chunk.name === 'background' ? 'background.js' : 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
});
