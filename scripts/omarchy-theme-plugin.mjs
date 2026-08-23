import {
  loadOmarchyTheme,
  OMARCHY_THEME_JS_ID,
  omarchyThemePaths,
  renderOmarchyThemeJs,
} from "./omarchy-theme.mjs";

function watchThemeFiles(ctx) {
  const paths = omarchyThemePaths();
  if (!paths) return;
  try {
    ctx.addWatchFile(paths.colors);
    ctx.addWatchFile(paths.name);
  } catch {
    // Watch is optional; a missing theme just means Omakei defaults.
  }
}

export function omarchyThemePlugin() {
  const jsId = `\0${OMARCHY_THEME_JS_ID}`;

  return {
    name: "folio:omarchy-theme",
    resolveId(id) {
      if (id === OMARCHY_THEME_JS_ID) return jsId;
    },
    load(id) {
      if (id === jsId) {
        watchThemeFiles(this);
        return renderOmarchyThemeJs(loadOmarchyTheme());
      }
    },
    configureServer(server) {
      const paths = omarchyThemePaths();
      if (!paths) return;

      const reload = (file) => {
        if (file !== paths.colors && file !== paths.name) return;
        const mod = server.moduleGraph.getModuleById(jsId);
        if (mod) server.moduleGraph.invalidateModule(mod);
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
