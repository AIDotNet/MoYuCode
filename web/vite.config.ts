import path from "path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@animate-ui/components-buttons-theme-toggler": path.resolve(
        __dirname,
        "./src/components/animate-ui/components/buttons/theme-toggler",
      ),
      "@animate-ui/components-base-files": path.resolve(
        __dirname,
        "./src/components/animate-ui/components/radix/files",
      ),
    },
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:5210',
        changeOrigin: true,
        ws: true, // 启用 WebSocket 代理
        // 不重写路径，保持 /api 前缀
      },
      '/.well-known': {
        target: 'http://localhost:5210',
        changeOrigin: true,
      },
    }
  }
})
