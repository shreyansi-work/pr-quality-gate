import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev:   npm run dev      -> http://localhost:5173 (calls to /api go to the Nest server on :3000)
// Build: npm run build    -> writes the finished site into ../api/public, which Nest already serves.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:3000' },
  },
  build: {
    outDir: '../api/public',
    emptyOutDir: true,
  },
});
