import { defineConfig } from "vite";
import { writeFileSync } from "node:fs";

export default defineConfig({
  base: "/static/",
  root: "internal/frontend",
  worker: {
    format: "es",
  },
  plugins: [
    {
      name: "review-static-placeholder",
      closeBundle() {
        writeFileSync(
          new URL("./internal/static/README.md", import.meta.url),
          "Generated frontend assets are written here by `pnpm build`.\n",
        );
      },
    },
  ],
  build: {
    outDir: "../static",
    emptyOutDir: true,
    assetsDir: "assets",
    chunkSizeWarningLimit: 1024,
  },
});
