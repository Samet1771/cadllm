// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/ws': {
        target: 'http://localhost:5170',
        ws: true,
      },
      '/mcp': {
        target: 'http://localhost:5170',
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
