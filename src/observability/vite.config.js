import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const clientRoot = fileURLToPath(new URL('./client/', import.meta.url));
const publicRoot = fileURLToPath(new URL('./public/', import.meta.url));

export default defineConfig({
  root: clientRoot,
  publicDir: false,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': clientRoot },
  },
  server: {
    host: '0.0.0.0',
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true },
    },
  },
  build: {
    outDir: publicRoot,
    emptyOutDir: true,
    rollupOptions: {
      output: {
        entryFileNames: 'app.js',
        assetFileNames: (asset) => asset.name?.endsWith('.css') ? 'styles.css' : '[name][extname]',
        chunkFileNames: 'chunks/[name]-[hash].js',
      },
    },
  },
});
