/**
 * Fills index.html's placeholders on the dev server.
 *
 * A build leaves both `<!--omakei:head-->` and `<!--omakei:state-->` in place
 * for `scripts/omakei-serve.mjs` to fill per request, so the committed `dist/`
 * carries neither a machine's theme nor anyone's ledger.
 */
import { applyShell } from "./page-shell.mjs";
import { createLedgerApi } from "./ledger-api.mjs";
import { loadOmarchyTheme, omarchyThemePaths } from "./omarchy-theme.mjs";

export function omakeiHtmlPlugin() {
  let isBuild = false;
  const api = createLedgerApi();
  return {
    name: "omakei:html",
    configResolved(config) {
      isBuild = config.command === "build";
    },
    async transformIndexHtml(html) {
      if (isBuild) return html;
      return applyShell(html, loadOmarchyTheme(), await api.stateBody());
    },
    configureServer(server) {
      const paths = omarchyThemePaths();
      if (!paths) return;
      const reload = (file) => {
        if (file !== paths.colors && file !== paths.name) return;
        server.ws.send({ type: "full-reload" });
      };
      try {
        server.watcher.add(paths.colors);
        server.watcher.add(paths.name);
      } catch {
        return;
      }
      server.watcher.on("change", reload);
      server.watcher.on("add", reload);
    },
  };
}
