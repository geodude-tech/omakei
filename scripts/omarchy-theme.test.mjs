import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  contrastRatio,
  loadOmarchyTheme,
  mapOmarchyColors,
  parseTomlScalars,
  renderOmarchyThemeCss,
} from "./omarchy-theme.mjs";

const RETRO_82 = `
mode = "dark"
accent = "#faa968"
selection = "#134e5a"
muted = "#2a6b78"
background = "#05182e"
dark_background = "#031222"
lighter_background = "#0a2540"
foreground = "#f6dcac"
red = "#f85525"
yellow = "#e97b3c"
orange = "#faa968"
green = "#028391"
cyan = "#8cbfb8"
blue = "#3f8f8a"
magenta = "#3f8f8a"
`;

const FLEXOKI_LIGHT = `
mode = "light"
accent = "#205EA6"
background = "#FFFCF0"
foreground = "#100F0F"
lighter_background = "#E6E4D9"
muted = "#B7B5AC"
red = "#D14D41"
green = "#879A39"
`;

test("parseTomlScalars reads quoted hex and ignores comments", () => {
  const raw = parseTomlScalars(RETRO_82);
  assert.equal(raw.mode, "dark");
  assert.equal(raw.background, "#05182e");
  assert.equal(raw.accent, "#faa968");
});

test("mapOmarchyColors maps Retro 82 onto Omakei tokens", () => {
  const theme = mapOmarchyColors(parseTomlScalars(RETRO_82));
  assert.ok(theme);
  assert.equal(theme.mode, "dark");
  assert.equal(theme.tokens.background, "#05182e");
  assert.equal(theme.tokens.foreground, "#f6dcac");
  assert.equal(theme.tokens.primary, "#faa968");
  assert.equal(theme.tokens["primary-foreground"], "#05182e");
  assert.equal(theme.tokens.card, "#0a2540");
  assert.equal(theme.tokens.border, "#2a6b78");
  assert.equal(theme.tokens.spend, "#f85525");
  assert.notEqual(theme.tokens.reserved, theme.tokens.spend);
  assert.notEqual(theme.tokens.reserved, theme.tokens.income);
  assert.ok(contrastRatio(theme.tokens.foreground, theme.tokens.background) >= 4.5);
  assert.ok(contrastRatio(theme.tokens["primary-foreground"], theme.tokens.primary) >= 3);
});

test("mapOmarchyColors keeps light themes light", () => {
  const theme = mapOmarchyColors(parseTomlScalars(FLEXOKI_LIGHT));
  assert.ok(theme);
  assert.equal(theme.mode, "light");
  assert.equal(theme.tokens.background, "#fffcf0");
  assert.equal(theme.tokens.primary, "#205ea6");
});

test("mapOmarchyColors returns null when required keys are missing", () => {
  assert.equal(mapOmarchyColors({ background: "#000000" }), null);
  assert.equal(mapOmarchyColors(parseTomlScalars("background = not-a-color\n")), null);
});

test("renderOmarchyThemeCss is empty-safe and emits :root when mapped", () => {
  assert.equal(renderOmarchyThemeCss(null), "");
  const css = renderOmarchyThemeCss(mapOmarchyColors(parseTomlScalars(RETRO_82)));
  assert.match(css, /:root \{/);
  assert.match(css, /--color-background: #05182e;/);
  assert.match(css, /--radius: 0px;/);
  assert.match(css, /color-scheme: dark;/);
  assert.match(css, /JetBrains Mono/);
});

test("loadOmarchyTheme falls back when the theme dir is missing or disabled", () => {
  assert.equal(loadOmarchyTheme({ OMAKEI_DISABLE_OMARCHY_THEME: "1" }), null);
  assert.equal(loadOmarchyTheme({ OMARCHY_THEME_DIR: "/tmp/omakei-no-such-theme" }), null);

  const dir = mkdtempSync(join(tmpdir(), "omakei-omarchy-"));
  writeFileSync(join(dir, "colors.toml"), RETRO_82);
  const theme = loadOmarchyTheme({ OMARCHY_THEME_DIR: dir });
  assert.ok(theme?.enabled);
  assert.equal(theme.tokens.background, "#05182e");
});
