/**
 * `omakei-open` starts the server with its output appended to `server.log`.
 * That output can quote a request that carried the ledger, so the log has to
 * be the user's alone even under the default umask. The browser, `curl`, and
 * `setsid` are stand-ins: nothing here starts a server or opens a window.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const OPEN = fileURLToPath(new URL("./omakei-open", import.meta.url));

function launch(before = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), "omakei-open-"));
  const bin = join(dir, "bin");
  const state = join(dir, "state");
  mkdirSync(bin);
  // Not serving on the first check, serving on the next, so it launches once.
  const seen = join(dir, "checked");
  writeFileSync(
    join(bin, "curl"),
    `#!/bin/sh\n[ -e '${seen}' ] && exit 0\n: > '${seen}'\nexit 1\n`,
  );
  writeFileSync(join(bin, "setsid"), "#!/bin/sh\nexit 0\n");
  writeFileSync(join(bin, "omarchy"), "#!/bin/sh\nexit 0\n");
  for (const f of ["curl", "setsid", "omarchy"]) chmodSync(join(bin, f), 0o755);
  before(join(state, "omakei"));

  const previous = process.umask(0o022);
  try {
    const result = spawnSync(OPEN, [], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, XDG_STATE_HOME: state },
    });
    return { dir, log: join(state, "omakei", "server.log"), result };
  } finally {
    process.umask(previous);
  }
}

test("the server log is created readable by its owner only", () => {
  const { dir, log, result } = launch();
  try {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(statSync(log).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a server log left world-readable by an older version is tightened", () => {
  const { dir, log, result } = launch((stateDir) => {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "server.log"), "earlier output\n");
    chmodSync(join(stateDir, "server.log"), 0o644);
  });
  try {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(statSync(log).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
