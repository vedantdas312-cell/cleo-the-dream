import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('.', import.meta.url)) } },
  build: {
    outDir: '../dist/landing', emptyOutDir: true, assetsDir: 'landing-assets',
    rolldownOptions: { onwarn(warning, warn) {
      // All components in this static browser bundle are client components.
      if (warning.code !== 'MODULE_LEVEL_DIRECTIVE') warn(warning);
    } },
  },
});
