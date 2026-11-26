import test from "node:test";
import assert from "node:assert/strict";
import { runCli, TOP_LEVEL_HANDLERS } from "../src/cli.js";
import {
  TOP_LEVEL_COMMANDS,
  TOP_LEVEL_COMMAND_NAMES,
  completionScript,
  findTopLevelCommand,
  renderTopLevelUsage,
} from "../src/command-registry.js";

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

function usageLines(command) {
  return Array.isArray(command.usage) ? command.usage : [command.usage];
}

test("the registry and the dispatch table contain exactly the same commands", () => {
  const names = TOP_LEVEL_COMMANDS.map((command) => command.name);
  assert.equal(new Set(names).size, names.length, "duplicate top-level command name");
  assert.deepEqual([...TOP_LEVEL_COMMAND_NAMES], names);

  const referenced = new Set();
  for (const command of TOP_LEVEL_COMMANDS) {
    assert.equal(typeof command.handler, "string", `${command.name} has no handler key`);
    assert.equal(
      typeof TOP_LEVEL_HANDLERS[command.handler],
      "function",
      `${command.name} names missing handler ${command.handler}`,
    );
    referenced.add(command.handler);
  }

  // A handler that no registry entry reaches is either dead code or a command
  // that was removed from the table but is still dispatchable.
  const orphaned = Object.keys(TOP_LEVEL_HANDLERS).filter((key) => !referenced.has(key));
  assert.deepEqual(
    orphaned,
    [],
    `handlers not reachable from the registry: ${orphaned.join(", ")}`,
  );
});

test("help and completion are generated from the registry", () => {
  const usage = renderTopLevelUsage();

  for (const command of TOP_LEVEL_COMMANDS) {
    if (command.aliasOf || command.hidden) continue;
    const lines = usageLines(command);
    assert.ok(lines.length > 0, `${command.name} has no usage line`);
    for (const line of lines) {
      assert.ok(usage.includes(`  coderax ${line}`), `${command.name} is missing from help`);
    }
    assert.equal(typeof command.summary, "string", `${command.name} has no help summary`);
    assert.ok(usage.includes(command.summary), `${command.name} summary is missing from help`);
  }

  for (const command of TOP_LEVEL_COMMANDS.filter((entry) => entry.aliasOf)) {
    const parent = findTopLevelCommand(command.aliasOf);
    assert.ok(parent, `${command.name} aliases unknown command ${command.aliasOf}`);
    if (command.hidden) {
      assert.ok(!usage.includes(command.name), `hidden alias ${command.name} leaked into help`);
    } else {
      assert.ok(
        usageLines(parent).join(" ").includes(command.name),
        `${command.name} is dispatchable but not named in help`,
      );
    }
  }

  const script = completionScript("bash");
  for (const name of TOP_LEVEL_COMMAND_NAMES) {
    assert.ok(script.includes(name), `${name} missing from generated completion`);
  }
});

test("--help prints the registry usage section", async () => {
  const io = capture();
  const code = await runCli(["--help"], { env: {}, stdout: io.stdout, stderr: io.stderr });
  assert.equal(code, 0);
  assert.ok(io.out().includes(renderTopLevelUsage()));
  assert.equal(io.err(), "");
});

test("dispatch reaches registry commands and rejects unknown ones", async () => {
  const io = capture();
  const code = await runCli(["products", "--json"], {
    env: {},
    stdout: io.stdout,
    stderr: io.stderr,
  });
  assert.equal(code, 0, io.err());
  assert.ok(JSON.parse(io.out()).products.length > 0);

  const unknown = capture();
  assert.equal(
    await runCli(["not-a-command"], { env: {}, stdout: unknown.stdout, stderr: unknown.stderr }),
    2,
  );
  assert.match(unknown.err(), /unknown command/);
});
