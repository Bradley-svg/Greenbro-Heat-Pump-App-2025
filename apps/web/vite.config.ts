import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

const indexHtml = fileURLToPath(new URL('./index.html', import.meta.url));
const brandServiceWorker = fileURLToPath(new URL('./src/sw/brand-sw.ts', import.meta.url));

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  resolve: {
    alias: {
      '@app': fileURLToPath(new URL('./src/app', import.meta.url)),
      '@pages': fileURLToPath(new URL('./src/pages', import.meta.url)),
      '@components': fileURLToPath(new URL('./src/components', import.meta.url)),
      '@hooks': fileURLToPath(new URL('./src/hooks', import.meta.url)),
      '@api': fileURLToPath(new URL('./src/api', import.meta.url)),
      '@utils': fileURLToPath(new URL('./src/utils', import.meta.url)),
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: indexHtml,
        'brand-sw': brandServiceWorker,
      },
      output: {
        entryFileNames: (chunk) => (chunk.name === 'brand-sw' ? 'brand-sw.js' : 'assets/[name].[hash].js'),
        chunkFileNames: 'assets/[name].[hash].js',
        assetFileNames: 'assets/[name].[hash][extname]',
      },
    },
  },
});
