import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { gigachatProxy } from "./server/vite-plugin.ts";

export default defineConfig({
  // GitHub Pages открывает сайт из подпапки /severnaya-yagoda/: путь задаёт BASE_PATH в .github/workflows/pages.yml
  base: process.env.BASE_PATH || "/",
  plugins: [react(), tailwindcss(), gigachatProxy()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  test: { include: ["src/**/*.test.ts"] },
} as any);
