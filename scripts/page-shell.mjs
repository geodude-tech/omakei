/**
 * Fills in the two things the committed bundle cannot carry: the user's
 * Omarchy theme, and the ledger itself.
 *
 * `dist/` is built once and shipped to every installer, so it can bake in
 * neither the build machine's theme nor anyone's data. Both are injected per
 * request instead, which is also why the editor paints real numbers on the
 * first frame rather than a spinner and a fetch.
 */
import { loadOmarchyTheme, renderOmarchyThemeCss } from "./omarchy-theme.mjs";

const MONO_FONT =
  "https://fonts.googleapis.com/css2?family=JetBrains+Mono:ital,wght@0,400;0,500;0,600;0,700;1,500&display=swap";
const SERIF_FONT =
  "https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,500;0,9..144,600;1,9..144,500&family=Source+Sans+3:ital,wght@0,400;0,500;0,600;0,700&display=swap";

/** Past this, inlining costs more than the round-trip it saves. */
const MAX_INLINE_STATE_BYTES = 4 * 1024 * 1024;

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

/**
 * `</script>` inside JSON would close the tag early, and `<!--` would open an
 * HTML comment. Escaping the angle brackets keeps the payload inert.
 */
export function encodeInlineJson(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/** Theme-dependent, so it happens per request. `theme` null means Omakei's own defaults. */
export function injectHead(html, theme) {
  return html
    .replace('<html lang="en">', `<html lang="en" class="${htmlClass(theme)}">`)
    .replace("<!--omakei:head-->", renderHead(theme));
}

/**
 * Hand the page its ledger. Omitting it is safe: the app falls back to
 * fetching `/__omakei/state`, which is what a too-large ledger relies on.
 */
export function injectState(html, state) {
  if (!state) return html.replace("<!--omakei:state-->", "");
  const encoded = encodeInlineJson(state);
  if (encoded.length > MAX_INLINE_STATE_BYTES) return html.replace("<!--omakei:state-->", "");
  return html.replace(
    "<!--omakei:state-->",
    `<script>window.__OMAKEI_STATE=${encoded}</script>`,
  );
}

export function applyShell(html, theme, state) {
  return injectState(injectHead(html, theme), state);
}

export function renderShell(html, state, env = process.env) {
  return applyShell(html, loadOmarchyTheme(env), state);
}
