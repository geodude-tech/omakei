import { defineConfig } from "vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
// @ts-expect-error JS plugin alongside the TS vite config
import { ledgerApiPlugin } from "./scripts/ledger-api-plugin.mjs";
// @ts-expect-error JS plugin alongside the TS vite config
import { omakeiHtmlPlugin } from "./scripts/omakei-html-plugin.mjs";

export default defineConfig({
  // Loopback only: this serves a personal ledger.
  server: { host: "127.0.0.1", port: 8080, strictPort: true },
  preview: { host: "127.0.0.1", port: 8081, strictPort: true },
  resolve: { tsconfigPaths: true },
  build: { outDir: "dist", emptyOutDir: true },
  plugins: [
    ledgerApiPlugin(),
    omakeiHtmlPlugin(),
    tailwindcss(),
    viteReact(),
  ],
});
