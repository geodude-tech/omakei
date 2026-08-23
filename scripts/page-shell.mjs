/**
 * Injects the Omarchy theme into the built index.html.
 *
 * The bundle is theme-agnostic on purpose: `dist/` is committed and shipped to
 * every installer, so it cannot bake in whatever theme the build machine had.
 * The dev plugin and the runtime server both call this, so the page looks the
 * same either way.
 */
import { loadOmarchyTheme, renderOmarchyThemeCss } from "./omarchy-theme.mjs";
import { WIDGET_BOOT_SCRIPT } from "./widget-boot-script.mjs";

const MONO_FONT =
  "https://fonts.googleapis.com/css2?family=JetBrains+Mono:ital,wght@0,400;0,500;0,600;0,700;1,500&display=swap";
const SERIF_FONT =
  "https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,500;0,9..144,600;1,9..144,500&family=Source+Sans+3:ital,wght@0,400;0,500;0,600;0,700&display=swap";

export function renderHead(theme) {
  const on = Boolean(theme && theme.enabled !== false);
  const parts = [
    `<meta name="theme-color" content="${on ? theme.background : "#F3EFE7"}" />`,
    `<link rel="preconnect" href="https://fonts.googleapis.com" />`,
    `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />`,
    `<link rel="stylesheet" href="${on ? MONO_FONT : SERIF_FONT}" />`,
  ];
  const css = on ? renderOmarchyThemeCss(theme) : "";
  if (css) parts.push(`<style id="omarchy-theme">${css}</style>`);
  return parts.join("\n    ");
}

export function htmlClass(theme) {
  const dark = theme && theme.enabled !== false && theme.mode === "dark";
  return dark ? "dark antialiased" : "antialiased";
}

/** Static, so it is baked into `dist/index.html` at build time. */
export function injectBoot(html) {
  return html.replace("<!--omakei:boot-->", `<script>${WIDGET_BOOT_SCRIPT}</script>`);
}

/** Theme-dependent, so it happens per request. `theme` null means Omakei's own defaults. */
export function injectHead(html, theme) {
  return html
    .replace('<html lang="en">', `<html lang="en" class="${htmlClass(theme)}">`)
    .replace("<!--omakei:head-->", renderHead(theme));
}

/** Everything at once — the dev server has no separate build step. */
export function applyShell(html, theme) {
  return injectHead(injectBoot(html), theme);
}

export function renderShell(html, env = process.env) {
  return injectHead(html, loadOmarchyTheme(env));
}
