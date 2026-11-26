import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { verifySecurePath, writeSecureFile } from "../src/secure-store.js";
import { displayWidth } from "../src/terminal/text.js";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));

test("Windows ACL verification accepts a private file and rejects broad access", async (t) => {
  if (process.platform !== "win32") {
    t.skip("runs on the Windows GitHub runner");
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), "coderax-win-"));
  const path = join(dir, "config.json");
  await writeFile(path, "{}", "utf8");
  const verification = await verifySecurePath(path);
  assert.equal(verification.ok, true, verification.detail);
  const written = join(dir, "history.json");
  await writeSecureFile(written, "{}");
  assert.equal((await verifySecurePath(written)).ok, true);
});

test("the CLI runs under the Windows console without a TTY", async (t) => {
  if (process.platform !== "win32") {
    t.skip("runs on the Windows GitHub runner");
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), "coderax-win-cli-"));
  const env = {
    ...process.env,
    CODERAX_CONFIG: join(dir, "config.json"),
    CODERAX_HISTORY: "off",
  };
  const result = spawnSync(process.execPath, [CLI, "--version"], { encoding: "utf8", env, shell: false });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /coderax-cli/);

  const interactive = spawnSync(process.execPath, [CLI, "chat", "--interactive"], {
    encoding: "utf8",
    env,
    input: "",
  });
  assert.equal(interactive.status, 2);
  assert.match(interactive.stderr, /terminal/);
});

test("wide characters are measured consistently on Windows", () => {
  assert.equal(displayWidth("世界"), 4);
  assert.equal(displayWidth("😀"), 2);
});
