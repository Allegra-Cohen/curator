import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Dev: Vite serves the app on 5173 and proxies /api to the FastAPI backend on
// 8000. Prod: `npm run build` emits ui/dist, which api.py serves directly.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:8000' },
  },
})
