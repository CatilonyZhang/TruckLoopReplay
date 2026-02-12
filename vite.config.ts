import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    host: true,
    port: 6677,
    strictPort: true
  },
  preview: {
    host: true,
    port: 6677,
    strictPort: true
  }
})
