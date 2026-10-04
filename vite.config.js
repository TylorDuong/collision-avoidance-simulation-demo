import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'web',
  base: '/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    chunkSizeWarningLimit: 800, // three.js
    rollupOptions: {
      input: {
        dashboard: resolve('web/dashboard/index.html'),
      },
    },
  },
  server: {
    fs: { allow: ['..'] }, // shared/ lives outside the web root
  },
});
