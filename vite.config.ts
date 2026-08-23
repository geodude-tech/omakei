import { defineConfig } from "vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
// @ts-expect-error JS plugin alongside the TS vite config
import { localStatementsPlugin } from "./scripts/local-statements-plugin.mjs";
// @ts-expect-error JS plugin alongside the TS vite config
import { omakeiHtmlPlugin } from "./scripts/omakei-html-plugin.mjs";

export default defineConfig({
  // Loopback only: this serves a personal ledger.
  server: { host: "127.0.0.1", port: 8080, strictPort: true },
  preview: { host: "127.0.0.1", port: 8081, strictPort: true },
  resolve: { tsconfigPaths: true },
  build: { outDir: "dist", emptyOutDir: true },
  plugins: [
    localStatementsPlugin(),
    omakeiHtmlPlugin(),
    tanstackRouter({ target: "react", autoCodeSplitting: false }),
    tailwindcss(),
    viteReact(),
  ],
});
