import test from "node:test";
import assert from "node:assert/strict";
import { applyCompletion, commandHelp, COMMANDS, complete } from "../src/terminal/completion.js";

test("command completion filters by prefix", () => {
  const all = complete("/", 1);
  assert.equal(all.kind, "command");
  assert.equal(all.options.length, COMMANDS.length);
  const filtered = complete("/mo", 3);
  assert.deepEqual(filtered.options.map((option) => option.value), ["mode", "model"]);
});

test("completion applies only the command name, not the whole line", () => {
  const completion = complete("/mod", 4);
  const applied = applyCompletion("/mod", 4, completion, "mode");
  assert.deepEqual(applied, { text: "/mode", cursor: 5 });
});

test("mode, model, agent and history arguments complete", () => {
  assert.deepEqual(complete("/mode w", 8).options.map((option) => option.value), ["work"]);
  const models = complete("/model gp", 9, { models: ["gpt-4.1", "claude-3"] });
  assert.deepEqual(models.options.map((option) => option.value), ["gpt-4.1"]);
  const agents = complete("/agent re", 9, { agents: ["reviewer", "builder"] });
  assert.deepEqual(agents.options.map((option) => option.value), ["reviewer"]);
  const history = complete("/history c", 10);
  assert.deepEqual(history.options.map((option) => option.value), ["clear"]);
});

test("conversation ids complete from saved metadata", () => {
  const completion = complete("/resume a", 10, {
    conversations: [
      { id: "abc", mode: "chat", title: "First" },
      { id: "xyz", mode: "work", title: "Second" },
    ],
  });
  assert.deepEqual(completion.options.map((option) => option.value), ["abc"]);
  assert.match(completion.options[0].description, /chat/);
});

test("plain text and file references are never completed", () => {
  assert.equal(complete("hello", 5), null);
  assert.equal(complete("@src/file", 9), null);
  assert.equal(complete("/unknown arg", 12), null);
});

test("command help is complete and bounded", () => {
  const help = commandHelp();
  assert.equal(help.length, COMMANDS.length);
  for (const entry of help) {
    assert.match(entry.usage, /^\//);
    assert.ok(entry.description.length > 0);
  }
});
