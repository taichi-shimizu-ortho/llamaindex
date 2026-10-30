import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    // 50_article-json の viewer が 5173 を使うので、同時に起動できるよう 5175 にする。
    port: 5175,
    strictPort: true,
    open: true, // 起動時にデフォルトブラウザで自動的に開く
    proxy: {
      "/api": `http://localhost:${process.env.PORT ?? 5174}`,
      "/raw_html": `http://localhost:${process.env.PORT ?? 5174}`,
    },
  },
  build: {
    outDir: "dist",
  },
});
