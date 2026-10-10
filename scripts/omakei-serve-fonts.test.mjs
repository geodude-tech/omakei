/**
 * The served dashboard must load nothing from another host, fonts included,
 * with Omakei's own look and with an Omarchy theme.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const home = mkdtempSync(join(tmpdir(), "omakei-fonts-"));
after(() => rmSync(home, { recursive: true, force: true }));

function freePort() {
  return new Promise((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function serve(extraEnv) {
  const port = await freePort();
  const child = spawn(process.execPath, [join(ROOT, "scripts", "omakei-serve.mjs")], {
    env: {
      PATH: process.env.PATH,
      HOME: home,
      XDG_STATE_HOME: join(home, "state"),
      OMAKEI_PORT: String(port),
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise((resolve) => child.stdout.once("data", resolve));
  return { base: `http://127.0.0.1:${port}`, stop: () => child.kill() };
}

const refs = (text, pattern) => [...text.matchAll(pattern)].map((m) => m[1]);

async function pageRefs(base) {
  const html = await (await fetch(`${base}/`)).text();
  const htmlRefs = refs(html, /(?:href|src)="([^"]+)"/g);
  const cssRefs = [];
  for (const href of htmlRefs.filter((r) => r.endsWith(".css"))) {
    cssRefs.push(...refs(await (await fetch(base + href)).text(), /url\(["']?([^)"']+)/g));
  }
  return { html, refs: [...htmlRefs, ...cssRefs] };
}

const THEMES = {
  "Omakei's own look": { OMAKEI_DISABLE_OMARCHY_THEME: "1" },
  "an Omarchy theme": (() => {
    const dir = mkdtempSync(join(home, "theme-"));
    writeFileSync(
      join(dir, "colors.toml"),
      'background = "#101010"\nforeground = "#eeeeee"\naccent = "#3399ff"\n',
    );
    return { OMARCHY_THEME_DIR: dir };
  })(),
};

for (const [name, env] of Object.entries(THEMES)) {
  test(`with ${name}, the page and its CSS reference only this server, and the fonts are served`, async () => {
    const { base, stop } = await serve(env);
    try {
      const { html, refs: all } = await pageRefs(base);
      assert.doesNotMatch(html, /fonts\.googleapis\.com|fonts\.gstatic\.com/);
      assert.deepEqual(
        all.filter((r) => !r.startsWith("/")),
        [],
        "every reference is a path on this server",
      );
      const fonts = all.filter((r) => r.endsWith(".woff2"));
      assert.deepEqual(fonts.map((r) => r.replace(/^\/assets\/|-[\w-]{8}\.woff2$/g, "")).sort(), [
        "fraunces-italic-latin",
        "fraunces-latin",
        "jetbrains-mono-italic-latin",
        "jetbrains-mono-latin",
        "source-sans-3-latin",
      ]);
      for (const font of fonts) {
        const res = await fetch(base + font);
        assert.equal(res.status, 200, font);
        assert.equal(res.headers.get("content-type"), "font/woff2", font);
        assert.equal(
          Buffer.from(await res.arrayBuffer())
            .subarray(0, 4)
            .toString(),
          "wOF2",
          font,
        );
      }
    } finally {
      stop();
    }
  });
}
