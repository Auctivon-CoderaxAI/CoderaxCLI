import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { InteractiveSession } from "../src/terminal/session.js";
import { TerminalRenderer } from "../src/terminal/renderer.js";
import { Editor } from "../src/terminal/editor.js";
import { createTheme } from "../src/terminal/theme.js";
import { createTransport } from "../src/sdk.js";
import { createMemoryLedger } from "../packages/workflow-sdk/src/v1/index.js";

const TOKEN = "owner-token-0123456789";

const HEALTH = {
  status: "ok",
  contractVersion: "1.0.0",
  startedAt: "2026-11-27T00:00:00.000Z",
  uptimeMs: 1,
  checks: [],
  engines: [],
};

function event(seq, type, payload = {}) {
  return {
    v: 1,
    eventId: `evt_${seq}`,
    taskId: "task_1",
    seq,
    at: `2026-11-27T00:00:0${seq}.000Z`,
    agent: "coderax",
    generation: 0,
    type,
    payload,
  };
}

async function withEngine(run) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const json = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/v1/health") return json(200, HEALTH);
    if (url.pathname === "/v1/work" && req.method === "POST") {
      return json(202, {
        taskId: "task_1",
        conversationId: "conversation_1",
        state: "queued",
        generation: 0,
        eventsPath: "/v1/work/task_1/events",
      });
    }
    if (url.pathname === "/v1/work/task_1/events") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const frame of [
        event(1, "task.started"),
        event(2, "text.delta", { text: "checking the repo" }),
        event(3, "task.completed", { summary: "all checks passed" }),
      ]) {
        res.write(`data: ${JSON.stringify(frame)}\n\n`);
      }
      res.end();
      return undefined;
    }
    return json(404, { message: "not found" });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    return await run(baseUrl);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
}

function makeSession(transport) {
  const output = [];
  const renderer = new TerminalRenderer({
    write: (text) => output.push(text),
    width: 60,
    mode: "accessible",
    theme: createTheme({ color: false, accessible: true }),
  });
  const session = new InteractiveSession({
    transport,
    renderer,
    editor: new Editor(),
    mode: "work",
    setIntervalFn: null,
  });
  return { session, text: () => output.join("") };
}

test("an interactive Work turn runs end to end over /v1", async () => {
  await withEngine(async (baseUrl) => {
    const { transport, description } = await createTransport({
      settings: {
        baseUrl,
        token: TOKEN,
        timeoutMs: 5000,
        ledger: createMemoryLedger(),
      },
      env: { CODERAX_SDK: "v1" },
    });
    assert.equal(description.kind, "workflow-v1");

    const { session, text } = makeSession(transport);
    session.running = true;
    session.beginPrompt();
    await session.handleEvent({ type: "text", text: "verify the build" });
    await session.handleEvent({ type: "key", name: "enter" });
    await session.sendPromise;

    assert.equal(session.outcome, "ok");
    assert.match(text(), /checking the repo/);
    assert.equal(session.sessionConversationId, "conversation_1");
    assert.equal(session.toolCount, 0);
    await transport.close();
  });
});
