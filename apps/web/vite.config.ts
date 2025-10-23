import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const resolveFrom = (relativePath: string) => fileURLToPath(new URL(relativePath, import.meta.url));
const dirname = resolveFrom(".");
const indexHtml = resolveFrom("./index.html");
const brandServiceWorker = resolveFrom("./src/sw/brand-sw.ts");

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  resolve: {
    alias: {
      "@": path.resolve(dirname, "src"),
      "@app": resolveFrom("./src/app"),
      "@pages": resolveFrom("./src/pages"),
      "@components": resolveFrom("./src/components"),
      "@hooks": resolveFrom("./src/hooks"),
      "@api": resolveFrom("./src/api"),
      "@utils": resolveFrom("./src/utils")
    }
  },
  build: {
    rollupOptions: {
      input: {
        main: indexHtml,
        "brand-sw": brandServiceWorker
      },
      output: {
        entryFileNames: (chunk) => (chunk.name === "brand-sw" ? "brand-sw.js" : "assets/[name].[hash].js"),
        chunkFileNames: "assets/[name].[hash].js",
        assetFileNames: "assets/[name].[hash][extname]"
      }
    }
  }
});
