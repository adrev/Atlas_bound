import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Vite config.
 *
 * `manualChunks` keeps the heaviest third-party deps (konva + react-konva,
 * the react runtime, socket.io-client, zustand) in their own long-lived
 * chunks. That way edits to app code only invalidate the AppShell chunk,
 * and the browser can cache the big immutable vendor chunks across deploys.
 */
export default defineConfig({
  plugins: [react()],
  build: {
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('/konva/') || id.includes('/react-konva/')) return 'vendor-konva';
          if (id.includes('/react/') || id.includes('/react-dom/') || id.includes('/react-router')) return 'vendor-react';
          if (id.includes('/socket.io-client/') || id.includes('/engine.io-')) return 'vendor-socket';
          if (id.includes('/zustand/')) return 'vendor-state';
          if (id.includes('/lucide-react/')) return 'vendor-icons';
          // Three.js + React-Three-Fiber live in the dice overlay,
          // which is lazy-imported. Splitting them out here keeps the
          // initial boot chunk free of ~500 KB of 3D runtime until the
          // first roll.
          if (id.includes('/three/') || id.includes('/@react-three/')) return 'vendor-three';
          return 'vendor-misc';
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      '/socket.io': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        ws: true,
      },
      '/uploads': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
});
