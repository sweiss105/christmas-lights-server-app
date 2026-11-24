import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The engine is imported from TypeScript source ("source" export condition), so the browser
// preview runs exactly the code that drives the porch.
export default defineConfig({
  plugins: [react()],
  resolve: { conditions: ['source'] },
  server: {
    port: 5173,
    // During development the API comes from the running lights server.
    proxy: { '/api': process.env.XMAS_API ?? 'http://127.0.0.1:8090' },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
    // Big libraries that rarely change get their own files, so a deploy only re-downloads the app code.
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'three', test: /node_modules[\\/]three[\\/]/ },
            { name: 'react', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
            { name: 'r3f', test: /node_modules[\\/](@react-three|three-stdlib|camera-controls|troika-|maath|@monogrid|zustand|its-fine|suspend-react)/ },
            { name: 'wled', test: /engine[\\/]src[\\/]wled[\\/]/ },
          ],
        },
      },
    },
  },
});
