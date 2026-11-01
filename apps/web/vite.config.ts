import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // GitHub Pages serves the app under /<repo>/.
  base: process.env.VITE_BASE ?? '/',
  plugins: [react()],
  server: {
    proxy: {
      '/socket.io': { target: process.env.SERVER_URL ?? 'http://localhost:3001', ws: true },
      '/api': { target: process.env.SERVER_URL ?? 'http://localhost:3001' },
    },
  },
});
