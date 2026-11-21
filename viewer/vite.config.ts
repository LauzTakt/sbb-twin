import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  optimizeDeps: { exclude: ["maplibre-gl"] },
  build: { outDir: "dist", emptyOutDir: true },
});
