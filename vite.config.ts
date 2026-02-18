import { resolve } from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: resolve(__dirname),
  plugins: [react()],
  resolve: {
    alias: { '@': resolve(__dirname, 'src') },
  },
  build: {
    outDir: 'dist-popup',
    emptyOutDir: true,
    base: './',
    rollupOptions: {
      input: { popup: resolve(__dirname, 'src/popup-react/popup.html') },
      output: {
        entryFileNames: 'popup.js',
        chunkFileNames: 'popup-[name].js',
        assetFileNames: (info) => (info.name?.endsWith('.css') ? 'popup.css' : 'popup-[name][extname]'),
      },
    },
  },
});
