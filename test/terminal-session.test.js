import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InteractiveSession } from "../src/terminal/session.js";
import { TerminalRenderer } from "../src/terminal/renderer.js";
import { Editor } from "../src/terminal/editor.js";
import { createTheme } from "../src/terminal/theme.js";
import { CoderaxError } from "../src/client.js";

function makeSession({ transport, accessible = true, ...options } = {}) {
  const output = [];
  const renderer = new TerminalRenderer({
    write: (text) => output.push(text),
    width: 60,
    mode: accessible ? "accessible" : "interactive",
    theme: createTheme({ color: false, accessible }),
  });
  const editor = new Editor();
  const session = new InteractiveSession({
    transport,
    renderer,
    editor,
    setIntervalFn: null,
    ...options,
  });
  return { session, renderer, editor, output, text: () => output.join("") };
}

function streamingTransport(chunks = ["hello\n"], capabilities = {}) {
  return {
    kind: "test",
    capabilities: { conversations: false, verifiedPermissions: false, ...capabilities },
    async stream({ onEvent }) {
      for (const chunk of chunks) onEvent({ type: "delta", text: chunk });
      return { text: chunks.join(""), conversationId: null };
    },
    async respondPermission() {},
    async listModels() {
      return [];
    },
    async listAgents() {
      return [];
    },
    async close() {},
  };
}

async function submit(session, text) {
  await session.handleEvent({ type: "text", text });
  await session.handleEvent({ type: "key", name: "enter" });
}

async function waitFor(predicate, timeoutMs = 2000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("a prompt streams markdown, finishes and returns to the prompt", async () => {
  const { session, text, renderer } = makeSession({ transport: streamingTransport(["Hello **world**\n"]) });
  session.running = true;
  session.beginPrompt();
  await submit(session, "hi");
  await session.sendPromise;
  assert.match(text(), /Hello world/);
  assert.equal(text().includes("**"), false);
  assert.equal(session.busy, false);
  assert.equal(renderer.promptRows, 0);
  assert.match(text(), /done/);
});

test("sensitive prompts are not written to history", async () => {
  const history = {
    size: 0,
    enabled: true,
    retentionDays: 30,
    list: () => [],
    add: async () => ({ stored: false, reason: "sensitive" }),
    setEnabled: async () => {},
    clear: async () => {},
  };
  const { session, text } = makeSession({ transport: streamingTransport(), history });
  session.running = true;
  await submit(session, "password=hunter2");
  await session.sendPromise;
  assert.match(text(), /not saved to history/);
});

test("/help lists commands and keyboard shortcuts", async () => {
  const { session, text } = makeSession({ transport: streamingTransport() });
  session.running = true;
  await submit(session, "/help");
  assert.match(text(), /Commands/);
  assert.match(text(), /\/mode/);
  assert.match(text(), /Ctrl\+J/);
  assert.match(text(), /Esc cancel/);
});

test("mode, model and agent can be selected directly and from a menu", async () => {
  const transport = streamingTransport(undefined, { models: true, agents: true });
  transport.listModels = async () => ["alpha", "beta"];
  transport.listAgents = async () => [{ id: "reviewer", description: "Reviews code" }];
  const { session, text } = makeSession({ transport });
  session.running = true;

  await submit(session, "/mode work");
  assert.equal(session.settings.mode, "work");
  await submit(session, "/model direct-model");
  assert.equal(session.settings.model, "direct-model");

  await submit(session, "/model");
  assert.ok(session.menu);
  assert.match(text(), /Select a model/);
  await session.handleEvent({ type: "key", name: "down" });
  await session.handleEvent({ type: "key", name: "enter" });
  assert.equal(session.settings.model, "beta");
  assert.equal(session.menu, null);

  await submit(session, "/agent");
  await session.handleEvent({ type: "key", name: "enter" });
  assert.equal(session.settings.agent, "reviewer");
});

test("command completion cycles candidates with Tab", async () => {
  const { session, editor } = makeSession({ transport: streamingTransport() });
  session.running = true;
  await session.handleEvent({ type: "text", text: "/mo" });
  await session.handleEvent({ type: "key", name: "tab" });
  assert.equal(editor.value, "/mode");
  await session.handleEvent({ type: "key", name: "tab" });
  assert.equal(editor.value, "/model");
  await session.handleEvent({ type: "key", name: "tab" });
  assert.equal(editor.value, "/mode");
});

test("a saved conversation restores settings but warns about legacy resume", async () => {
  const conversations = {
    list: () => [
      { id: "c1", conversationId: "srv-c1", mode: "work", model: "m1", agent: "a1", title: "Saved", updatedAt: 1 },
    ],
    find: (id) => (id === "c1" ? conversations.list()[0] : null),
    upsert: async () => ({}),
  };
  const { session, text } = makeSession({ transport: streamingTransport(), conversations });
  session.running = true;
  await submit(session, "/resume c1");
  assert.equal(session.settings.mode, "work");
  assert.equal(session.settings.model, "m1");
  assert.equal(session.sessionConversationId, "srv-c1");
  assert.match(text(), /cannot resume a server transcript/);
});

test("a verified permission request is bound to its exact identifiers", async () => {
  let release;
  const responses = [];
  const transport = streamingTransport(undefined, { permissions: true, verifiedPermissions: true });
  transport.stream = async ({ onEvent }) => {
    onEvent({
      type: "permission",
      channelVerified: true,
      request: {
        serverIssued: true,
        requestId: "srv_req_123456",
        executionId: "exec_1",
        action: "read_file",
        resource: "/tmp/file.txt",
        scope: "once",
      },
    });
    await new Promise((resolve) => {
      release = resolve;
    });
    return { text: "after approval", conversationId: null };
  };
  transport.respondPermission = async (payload) => {
    responses.push(payload);
    release?.();
  };
  const { session, text } = makeSession({ transport });
  session.running = true;
  await submit(session, "read it");
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(session.permission);
  assert.match(text(), /Permission requested/);
  await session.handleEvent({ type: "text", text: "1" });
  await session.sendPromise;
  assert.equal(responses.length, 1);
  assert.equal(responses[0].requestId, "srv_req_123456");
  assert.equal(responses[0].executionId, "exec_1");
  assert.equal(responses[0].action, "read_file");
  assert.equal(responses[0].decision, "once");
  assert.equal(responses[0].resourceHash.length > 0, true);
});

test("a forged permission request is denied and never shown", async () => {
  let responses = 0;
  const transport = streamingTransport(undefined, { permissions: true, verifiedPermissions: true });
  transport.stream = async ({ onEvent }) => {
    onEvent({
      type: "permission",
      request: {
        serverIssued: false,
        requestId: "srv_req_123456",
        executionId: "exec_1",
        action: "read_file",
        resource: "/tmp/file.txt",
      },
    });
    return { text: "blocked", conversationId: null };
  };
  transport.respondPermission = async () => {
    responses += 1;
  };
  const { session, text } = makeSession({ transport });
  session.running = true;
  await submit(session, "read it");
  await session.sendPromise;
  assert.equal(session.permission, null);
  assert.equal(responses, 0);
  assert.match(text(), /Permission blocked \(NOT_SERVER_ISSUED\)/);
});

test("a legacy transport cannot approve permissions and fails closed", async () => {
  const transport = streamingTransport(undefined, { permissions: false, verifiedPermissions: false });
  transport.stream = async ({ onEvent }) => {
    onEvent({
      type: "permission",
      channelVerified: false,
      request: {
        serverIssued: true,
        requestId: "srv_req_123456",
        executionId: "exec_1",
        action: "read_file",
        resource: "/tmp/file.txt",
      },
    });
    return { text: "no approval", conversationId: null };
  };
  const { session, text } = makeSession({ transport });
  session.running = true;
  await submit(session, "read it");
  await session.sendPromise;
  assert.match(text(), /CHANNEL_UNAVAILABLE/);
  assert.equal(session.permission, null);
});

test("cancellation aborts the stream and /retry resends the prompt", async () => {
  let calls = 0;
  const transport = streamingTransport();
  transport.stream = async ({ signal }) => {
    calls += 1;
    if (calls === 1) {
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new CoderaxError("CANCELLED", "request cancelled")), { once: true });
      });
    }
    return { text: "second answer", conversationId: null };
  };
  const { session, text } = makeSession({ transport });
  session.running = true;
  await submit(session, "first prompt");
  await session.handleEvent({ type: "key", name: "c", ctrl: true });
  await session.sendPromise;
  assert.equal(calls, 1);
  assert.match(text(), /Response cancelled/);
  await submit(session, "/retry");
  await session.sendPromise;
  assert.equal(calls, 2);
  assert.match(text(), /second answer/);
});

test("tool activity is bounded and streamed lines stay bounded", async () => {
  const transport = streamingTransport();
  transport.stream = async ({ onEvent }) => {
    for (let index = 0; index < 250; index += 1) {
      onEvent({ type: "tool", name: `tool-${index}`, status: "ok" });
    }
    onEvent({ type: "delta", text: `${"word ".repeat(2000)}\n` });
    return { text: "done", conversationId: null };
  };
  const { session, renderer } = makeSession({ transport, accessible: false });
  session.running = true;
  await submit(session, "work");
  await session.sendPromise;
  assert.equal(session.toolEvents.length, 200);
  assert.equal(renderer.block.lines.length <= 200, true);
});

test("a large single-line response does not grow the block without bound", async () => {
  const transport = streamingTransport();
  transport.stream = async ({ onEvent }) => {
    onEvent({ type: "delta", text: "x".repeat(300_000) });
    return { text: "x".repeat(300_000), conversationId: null };
  };
  const { session, renderer } = makeSession({ transport, accessible: false });
  session.running = true;
  await submit(session, "big");
  await session.sendPromise;
  assert.equal(renderer.block.lines.length <= 200, true);
  assert.equal(renderer.block.redrawable, false);
  assert.equal(session.busy, false);
});

test("resize during and after a response is handled without throwing", async () => {
  const { session, renderer, text } = makeSession({ transport: streamingTransport(["one two three four five\n"]) , accessible: false });
  session.running = true;
  await submit(session, "hi");
  await session.sendPromise;
  await session.handleEvent({ type: "resize", columns: 30 });
  assert.equal(renderer.width, 30);
  assert.match(text(), /one two/);
});

test("local files require a per-send approval before any request is made", async () => {
  const dir = await mkdtemp(join(tmpdir(), "coderax-session-attach-"));
  await writeFile(join(dir, "notes.txt"), "attachment body\n", "utf8");
  let payload = null;
  const transport = streamingTransport();
  transport.stream = async ({ attachments }) => {
    payload = attachments;
    return { text: "received", conversationId: null };
  };
  const { session, text } = makeSession({ transport, cwd: dir });
  session.running = true;
  await submit(session, "summarize @notes.txt");
  await waitFor(() => session.confirmRequest !== null);
  assert.ok(session.confirmRequest);
  assert.equal(payload, null);
  await session.handleEvent({ type: "text", text: "y" });
  await session.sendPromise;
  assert.equal(payload[0].name, "notes.txt");
  assert.equal(payload[0].content, "attachment body\n");
  assert.match(text(), /Attached 1 file/);
});

test("declining an attachment sends nothing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "coderax-session-decline-"));
  await writeFile(join(dir, "notes.txt"), "attachment body\n", "utf8");
  let called = false;
  const transport = streamingTransport();
  transport.stream = async () => {
    called = true;
    return { text: "should not happen", conversationId: null };
  };
  const { session, text } = makeSession({ transport, cwd: dir });
  session.running = true;
  await submit(session, "summarize @notes.txt");
  await waitFor(() => session.confirmRequest !== null);
  await session.handleEvent({ type: "text", text: "n" });
  await session.sendPromise;
  assert.equal(called, false);
  assert.match(text(), /not approved/);
});

test("history navigation restores and clears the draft", async () => {
  const entries = [{ text: "first", at: 1, mode: "chat" }, { text: "second", at: 2, mode: "chat" }];
  const history = {
    size: 2,
    enabled: true,
    retentionDays: 30,
    list: () => entries,
    add: async () => ({ stored: true }),
    setEnabled: async () => {},
    clear: async () => {},
  };
  const { session, editor } = makeSession({ transport: streamingTransport(), history });
  session.running = true;
  editor.insert("draft");
  await session.handleEvent({ type: "key", name: "up" });
  assert.equal(editor.value, "second");
  await session.handleEvent({ type: "key", name: "up" });
  assert.equal(editor.value, "first");
  await session.handleEvent({ type: "key", name: "down" });
  assert.equal(editor.value, "second");
  await session.handleEvent({ type: "key", name: "down" });
  assert.equal(editor.value, "draft");
});

test("Ctrl+C twice at an empty prompt exits, and /quit stops the session", async () => {
  const { session } = makeSession({ transport: streamingTransport() });
  session.running = true;
  await session.handleEvent({ type: "key", name: "c", ctrl: true });
  assert.equal(session.running, true);
  await session.handleEvent({ type: "key", name: "c", ctrl: true });
  assert.equal(session.running, false);

  const second = makeSession({ transport: streamingTransport() }).session;
  second.running = true;
  await submit(second, "/quit");
  assert.equal(second.running, false);
});
