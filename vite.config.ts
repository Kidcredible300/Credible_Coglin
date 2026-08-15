import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { cloudflare } from '@cloudflare/vite-plugin';

export default defineConfig({
  // Pinned off Vite's default 5173, which the Inkubus dev server already uses
  // on this machine. strictPort so a clash fails loudly instead of drifting.
  server: { port: 5174, strictPort: true },
  plugins: [react(), tailwindcss(), cloudflare()],
});
