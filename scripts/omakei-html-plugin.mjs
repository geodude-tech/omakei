/**
 * Fills index.html's placeholders.
 *
 * Dev does the whole shell inline. A build only bakes in the boot script and
 * leaves `<!--omakei:head-->` for `scripts/omakei-serve.mjs` to fill per
 * request, so the committed `dist/` carries no machine's theme.
 */
import { applyShell, injectBoot } from "./page-shell.mjs";
import { loadOmarchyTheme, omarchyThemePaths } from "./omarchy-theme.mjs";

export function omakeiHtmlPlugin() {
  let isBuild = false;
  return {
    name: "omakei:html",
    configResolved(config) {
      isBuild = config.command === "build";
    },
    transformIndexHtml(html) {
      return isBuild ? injectBoot(html) : applyShell(html, loadOmarchyTheme());
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
