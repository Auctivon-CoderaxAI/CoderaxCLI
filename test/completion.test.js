import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli.js";
import { CAPABILITY_COMMANDS } from "../src/capability-catalog.js";
import { completionScript } from "../src/completion.js";

async function run(argv) {
  const stdout = [];
  const stderr = [];
  const cwd = await mkdtemp(join(tmpdir(), "coderax-completion-"));
  const code = await runCli(argv, {
    env: { CODERAX_CONFIG_DIR: join(cwd, "config") },
    cwd,
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
    stdinIsTTY: true,
  });
  return { code, stdout: stdout.join(""), stderr: stderr.join("") };
}

test("bash completion lists every capability command", async () => {
  const result = await run(["completion", "bash"]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /complete -F _coderax_complete coderax/);
  for (const command of CAPABILITY_COMMANDS) {
    assert.ok(result.stdout.includes(command), `bash completion is missing ${command}`);
  }
  assert.ok(result.stdout.includes("--wait-timeout"));
});

test("zsh and fish completion are generated from the same dispatch set", async () => {
  const zsh = await run(["completion", "zsh"]);
  assert.equal(zsh.code, 0, zsh.stderr);
  assert.match(zsh.stdout, /^#compdef coderax/);
  assert.match(zsh.stdout, /create-document/);

  const fish = await run(["completion", "fish"]);
  assert.equal(fish.code, 0, fish.stderr);
  assert.match(fish.stdout, /complete -c coderax/);
  assert.match(fish.stdout, /create-presentation/);
});

test("completion is pure output and needs no deployment", async () => {
  const result = await run(["completion", "bash"]);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  assert.doesNotMatch(result.stdout, /CODERAX_TOKEN|Bearer/);
});

test("an unsupported shell is a usage error", async () => {
  const result = await run(["completion", "powershell"]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /unsupported shell/);
});

test("completionScript refuses an unknown shell directly", () => {
  assert.throws(() => completionScript("cmd", ["chat"]), { code: "USAGE" });
});
