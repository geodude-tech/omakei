/**
 * Map the active Omarchy Quattro theme onto Omakei CSS tokens.
 * Returns null when Omarchy is missing or unreadable so the built-in
 * parchment style stays in effect.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HEX = /^#([0-9a-fA-F]{6})$/;

const FALLBACK = {
  enabled: false,
  mode: "light",
  name: "",
  background: "#f3efe7",
  foreground: "#1c1914",
  accent: "#2a4038",
};

export function omarchyThemePaths(env = process.env) {
  if (env.FOLIO_DISABLE_OMARCHY_THEME === "1") return null;
  const dir = env.OMARCHY_THEME_DIR || join(homedir(), ".local/state/omarchy/current/theme");
  return {
    dir,
    colors: join(dir, "colors.toml"),
    name: join(dir, "..", "theme.name"),
  };
}

export function parseTomlScalars(text) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("[")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    let value = line.slice(eq + 1).trim();
    if (value.startsWith('"')) {
      const end = value.indexOf('"', 1);
      if (end === -1) continue;
      value = value.slice(1, end);
    } else {
      const comment = value.indexOf("#");
      if (comment !== -1) value = value.slice(0, comment).trim();
      if (
        (value.startsWith("'") && value.endsWith("'") && value.length >= 2) ||
        (value.startsWith('"') && value.endsWith('"') && value.length >= 2)
      ) {
        value = value.slice(1, -1);
      }
    }
    out[key] = value;
  }
  return out;
}

function hexOr(value, fallback) {
  if (typeof value === "string" && HEX.test(value)) return `#${value.slice(1).toLowerCase()}`;
  return fallback;
}

/** @param {string} hex */
function rgb(hex) {
  const h = hex.slice(1);
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** @param {number[]} channels */
function toHex(channels) {
  return `#${channels
    .map((v) =>
      Math.max(0, Math.min(255, Math.round(v)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/**
 * @param {string} a
 * @param {string} b
 * @param {number} t
 */
export function mix(a, b, t) {
  const A = rgb(a);
  const B = rgb(b);
  return toHex(A.map((v, i) => v + (B[i] - v) * t));
}

/** @param {number} v */
function srgbLin(v) {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** @param {string} hex */
function lum(hex) {
  const [r, g, b] = rgb(hex);
  return 0.2126 * srgbLin(r) + 0.7152 * srgbLin(g) + 0.0722 * srgbLin(b);
}

/**
 * @param {string} a
 * @param {string} b
 */
export function contrastRatio(a, b) {
  const L1 = lum(a);
  const L2 = lum(b);
  const hi = Math.max(L1, L2);
  const lo = Math.min(L1, L2);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * @param {string} color
 * @param {string} bg
 * @param {string} toward
 */
function readableOn(color, bg, toward) {
  if (contrastRatio(color, bg) >= 3) return color;
  return mix(color, toward, 0.42);
}

function rgbDistance(a, b) {
  const A = rgb(a);
  const B = rgb(b);
  return Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2]);
}

/** Gold if it is distinct from in/out; otherwise cyan, then a sand mix. */
function pickReserved(gold, cyan, income, spend, card, foreground) {
  const sand = mix(gold, foreground, 0.55);
  for (const candidate of [sand, gold, cyan]) {
    const color = readableOn(candidate, card, foreground);
    if (rgbDistance(color, spend) >= 80 && rgbDistance(color, income) >= 80) return color;
  }
  return readableOn(mix(foreground, cyan, 0.35), card, foreground);
}

/**
 * @param {Record<string, string>} raw
 */
export function mapOmarchyColors(raw) {
  const background = hexOr(raw.background, null);
  const foreground = hexOr(raw.foreground, null);
  const accent = hexOr(raw.accent, hexOr(raw.blue, null));
  if (!background || !foreground || !accent) return null;

  const mode = String(raw.mode ?? "dark").toLowerCase() === "light" ? "light" : "dark";
  const muted = hexOr(raw.muted, mix(background, foreground, 0.22));
  const selection = hexOr(raw.selection, mix(background, accent, 0.35));
  const lighter = hexOr(raw.lighter_background, mix(background, foreground, 0.08));
  const darker = hexOr(raw.dark_background, mix(background, "#000000", 0.2));
  const red = hexOr(raw.red, "#c44b3a");
  const yellow = hexOr(raw.yellow, accent);
  const orange = hexOr(raw.orange, accent);
  const green = hexOr(raw.green, accent);
  const cyan = hexOr(raw.cyan, accent);
  const blue = hexOr(raw.blue, accent);
  const magenta = hexOr(raw.magenta, accent);

  const card = lighter;
  const income = readableOn(green, card, foreground);
  const spend = readableOn(red, card, foreground);
  const reserved = pickReserved(hexOr(raw.yellow, orange), cyan, income, spend, card, foreground);

  return {
    enabled: true,
    mode,
    name: "",
    background,
    foreground,
    accent,
    selection,
    tokens: {
      background,
      foreground,
      card,
      "card-foreground": foreground,
      popover: mix(card, foreground, 0.04),
      "popover-foreground": foreground,
      primary: accent,
      "primary-foreground": background,
      secondary: mix(background, foreground, 0.16),
      "secondary-foreground": foreground,
      muted: mix(background, foreground, 0.06),
      "muted-foreground": mix(foreground, background, 0.38),
      accent: mix(background, accent, 0.18),
      "accent-foreground": foreground,
      destructive: red,
      "destructive-foreground": background,
      border: muted,
      input: muted,
      ring: accent,
      income,
      spend,
      reserved,
      "chart-1": accent,
      "chart-2": green,
      "chart-3": cyan,
      "chart-4": yellow,
      "chart-5": blue,
      "chart-6": orange,
      "chart-7": magenta,
      sidebar: darker,
    },
  };
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function loadOmarchyTheme(env = process.env) {
  const paths = omarchyThemePaths(env);
  if (!paths) return null;
  try {
    if (!existsSync(paths.colors)) return null;
    const mapped = mapOmarchyColors(parseTomlScalars(readFileSync(paths.colors, "utf8")));
    if (!mapped) return null;
    try {
      mapped.name = readFileSync(paths.name, "utf8").trim();
    } catch {
      mapped.name = "";
    }
    return mapped;
  } catch {
    return null;
  }
}

const FONT_STACK = `"JetBrainsMono Nerd Font", "JetBrains Mono", ui-monospace, monospace`;

/**
 * @param {ReturnType<typeof mapOmarchyColors>} theme
 */
export function renderOmarchyThemeCss(theme) {
  if (!theme?.enabled) return "";
  const vars = Object.entries(theme.tokens)
    .map(([key, value]) => `  --color-${key}: ${value};`)
    .join("\n");
  return `:root {
${vars}
  --radius-xs: 0px;
  --radius-sm: 0px;
  --radius-md: 0px;
  --radius-lg: 0px;
  --radius-xl: 0px;
  --radius: 0px;
  --font-sans: ${FONT_STACK};
  --font-display: ${FONT_STACK};
  --font-mono: ${FONT_STACK};
  --shadow-border: 0px 0px 0px 1px color-mix(in srgb, ${theme.foreground} 22%, transparent);
  --shadow-border-hover: 0px 0px 0px 1px color-mix(in srgb, ${theme.accent} 55%, transparent);
}

html {
  color-scheme: ${theme.mode};
}

h1,
h2,
h3 {
  letter-spacing: 0;
}

::selection {
  background: ${theme.selection};
  color: ${theme.foreground};
}
`;
}
