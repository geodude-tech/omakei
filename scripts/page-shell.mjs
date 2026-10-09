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

/** Past this, inlining costs more than the round-trip it saves. */
const MAX_INLINE_STATE_BYTES = 4 * 1024 * 1024;

export function renderHead(theme) {
  const on = Boolean(theme && theme.enabled !== false);
  const parts = [`<meta name="theme-color" content="${on ? theme.background : "#F3EFE7"}" />`];
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
    .replace('<html lang="en">', () => `<html lang="en" class="${htmlClass(theme)}">`)
    .replace("<!--omakei:head-->", () => renderHead(theme));
}

/**
 * Hand the page its ledger. Omitting it is safe: the app falls back to
 * fetching `/__omakei/state`, which is what a too-large ledger relies on.
 */
export function injectState(html, state) {
  if (!state) return html.replace("<!--omakei:state-->", "");
  const encoded = encodeInlineJson(state);
  if (encoded.length > MAX_INLINE_STATE_BYTES) return html.replace("<!--omakei:state-->", "");
  // A function, not a string: a replacement string expands `$'`, `$\``, and
  // `$&`, and the ledger is bank text anyone can name a merchant -- one
  // description holding `$'` would paste raw page HTML into the payload.
  const script = `<script>window.__OMAKEI_STATE=${encoded}</script>`;
  return html.replace("<!--omakei:state-->", () => script);
}

export function applyShell(html, theme, state) {
  return injectState(injectHead(html, theme), state);
}

export function renderShell(html, state, env = process.env) {
  return applyShell(html, loadOmarchyTheme(env), state);
}
