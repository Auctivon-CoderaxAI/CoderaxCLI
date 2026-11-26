import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KNOWN_COMMANDS, runCli } from "../src/cli.js";
import {
  COMPLETION_COMMANDS,
  COMPLETION_FLAGS,
  COMPLETION_SHELLS,
  completionScript,
} from "../src/completion.js";

function capture() {
  const out = [];
  const err = [];
  return {
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

test("the completion table covers every known command", () => {
  assert.deepEqual(
    COMPLETION_COMMANDS.map(([name]) => name).sort(),
    [...KNOWN_COMMANDS].sort(),
  );
});

test("every supported shell gets a marker, every command, and every flag", () => {
  for (const shell of COMPLETION_SHELLS) {
    const script = completionScript(shell);
    assert.match(script, /coderax-cli shell completion/, `${shell} lacks the ownership marker`);
    assert.doesNotMatch(script, /undefined/, `${shell} contains an unresolved value`);
    for (const [command] of COMPLETION_COMMANDS) {
      assert.match(script, new RegExp(`\\b${command}\\b`), `${shell} omits ${command}`);
    }
    for (const [flag] of COMPLETION_FLAGS) {
      const name = flag.replace(/^--/, "");
      assert.match(script, new RegExp(`\\b${name}\\b`), `${shell} omits ${flag}`);
    }
  }
});

test("each shell script uses its own completion mechanism", () => {
  assert.match(completionScript("bash"), /complete -F _coderax_complete coderax/);
  assert.match(completionScript("zsh"), /^#compdef coderax/m);
  assert.match(completionScript("zsh"), /_arguments -C/);
  // Every option spec must continue the `_arguments` command; a missing
  // backslash turns the specs into separate (harmless but useless) commands.
  const zsh = completionScript("zsh");
  const specs = zsh.split("\n").filter((line) => line.trimStart().startsWith("'--"));
  assert.ok(specs.length > 0);
  for (const line of specs) assert.match(line, / \\$/, `zsh option spec lacks a continuation: ${line}`);
  assert.match(completionScript("fish"), /complete -c coderax/);
  assert.match(completionScript("powershell"), /Register-ArgumentCompleter -Native -CommandName coderax/);
});

test("an unknown shell has no script", () => {
  assert.equal(completionScript("tcsh"), null);
});

test("completion works without configuration and on a corrupt config", async () => {
  const plain = capture();
  assert.equal(
    await runCli(["completion", "bash"], { env: {}, stdout: plain.stdout, stderr: plain.stderr }),
    0,
  );
  assert.match(plain.out(), /complete -F _coderax_complete coderax/);
  assert.equal(plain.err(), "");

  const directory = await mkdtemp(join(tmpdir(), "coderax-completion-"));
  const file = join(directory, "config.json");
  await writeFile(file, "{not json");

  const broken = capture();
  assert.equal(
    await runCli(["completion", "zsh"], {
      env: { CODERAX_CONFIG: file },
      stdout: broken.stdout,
      stderr: broken.stderr,
    }),
    0,
  );
  assert.match(broken.out(), /#compdef coderax/);
});

test("a missing or unsupported shell is a usage error", async () => {
  const missing = capture();
  assert.equal(
    await runCli(["completion"], { env: {}, stdout: missing.stdout, stderr: missing.stderr }),
    2,
  );
  assert.match(missing.err(), /requires a shell: bash, zsh, fish, powershell/);

  const unsupported = capture();
  assert.equal(
    await runCli(["completion", "tcsh"], { env: {}, stdout: unsupported.stdout, stderr: unsupported.stderr }),
    2,
  );
  assert.match(unsupported.err(), /unsupported shell: tcsh/);

  const extra = capture();
  assert.equal(
    await runCli(["completion", "bash", "extra"], { env: {}, stdout: extra.stdout, stderr: extra.stderr }),
    2,
  );
  assert.match(extra.err(), /exactly one shell/);
});
