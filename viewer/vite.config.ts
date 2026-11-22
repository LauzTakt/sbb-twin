import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const page = (p: string) => fileURLToPath(new URL(p, import.meta.url));
export default defineConfig({
  root: page("."),
  plugins: [react()],
  optimizeDeps: { exclude: ["maplibre-gl"] },
  // two pages: the console (index.html) and the forecast evidence for judges (forecasts.html, served at /forecasts)
  build: { outDir: "dist", emptyOutDir: true, rolldownOptions: { input: { main: page("index.html"), forecasts: page("forecasts.html") } } },
});
