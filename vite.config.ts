import { defineConfig } from 'vite'

// STATIC=1 → a "manual refresh only" instance (no HMR / auto-reload) on :5174,
// so a human can watch progress without the page jumping while agents edit files.
const isStatic = !!process.env.STATIC

export default defineConfig({
  cacheDir: isStatic ? 'node_modules/.vite-static' : 'node_modules/.vite',
  server: {
    port: isStatic ? 5174 : 5173,
    strictPort: true,
    hmr: isStatic ? false : undefined,
    proxy: { '/api': 'http://localhost:8787' },
  },
})
