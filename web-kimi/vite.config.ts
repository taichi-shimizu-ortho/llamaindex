import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5273,
    strictPort: true,
    open: true, // 起動時にデフォルトブラウザで自動的に開く
    proxy: {
      "/api": `http://localhost:${process.env.PORT ?? 5176}`,
      "/raw_html": `http://localhost:${process.env.PORT ?? 5176}`,
    },
  },
  build: {
    outDir: "dist",
  },
});
