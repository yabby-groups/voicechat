import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const apiPort = Number(process.env.VOICECHAT_API_PORT || 8787);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    host: '127.0.0.1',
    allowedHosts: true,
    proxy: { '/api': { target: `http://127.0.0.1:${apiPort}`, ws: true } },
  },
});
