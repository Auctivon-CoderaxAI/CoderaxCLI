import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventSequencer, SseDecoder, parseFrame } from "../packages/workflow-sdk/src/sse.js";
import { WorkflowClient } from "../packages/workflow-sdk/src/index.js";
import { assertCompatibleVersion, parseApiVersion } from "../packages/workflow-sdk/src/http.js";
import { normalizeSessions, withSession, getSession, clearSession } from "../src/session.js";

test("SSE decoder handles CRLF, comments, multi-line data and ids", () => {
  const decoder = new SseDecoder();
  const frames = decoder.push(
    ": keepalive\r\nid: 7\r\nevent: message\r\ndata: {\"a\":\r\ndata: 1}\r\n\r\n",
  );
  assert.equal(frames.length, 1);
  assert.equal(frames[0].id, "7");
  assert.equal(frames[0].event, "message");
  assert.deepEqual(frames[0].data, { a: 1 });
  assert.equal(frames[0].text, '{"a":\n1}');
});

test("SSE decoder recognises [DONE] and ignores a partial trailing frame", () => {
  const decoder = new SseDecoder();
  const frames = decoder.push("data: [DONE]\n\ndata: {\"partial\":");
  assert.equal(frames.length, 1);
  assert.equal(frames[0].done, true);
  assert.equal(parseFrame("data: {\"x\":1}").data.x, 1);
});

test("event sequencing deduplicates replayed ids", () => {
  const guard = new EventSequencer();
  const first = guard.accept({ id: "1", data: { delta: "a" } });
  assert.equal(first.action, "emit");
  const replay = guard.accept({ id: "1", data: { delta: "a" } });
  assert.equal(replay.action, "drop");
  assert.equal(replay.diagnostics[0].code, "DUPLICATE_EVENT");
});

test("event sequencing buffers and then orders out-of-order events", () => {
  const guard = new EventSequencer();
  const one = guard.accept({ id: "1", data: { delta: "a" } });
  const three = guard.accept({ id: "3", data: { delta: "c" } });
  const two = guard.accept({ id: "2", data: { delta: "b" } });
  assert.equal(one.frames.length, 1);
  assert.equal(three.action, "buffer");
  assert.equal(three.diagnostics[0].code, "OUT_OF_ORDER_EVENT");
  assert.deepEqual(
    two.frames.map((frame) => frame.data.delta),
    ["b", "c"],
  );
});

test("event sequencing flushes a permanent gap in sequence order", () => {
  const guard = new EventSequencer();
  guard.accept({ id: "1", data: { delta: "a" } });
  guard.accept({ id: "3", data: { delta: "c" } });
  const flushed = guard.flush();
  assert.deepEqual(
    flushed.frames.map((frame) => frame.data.delta),
    ["c"],
  );
});

test("API versions are parsed and a different major is rejected", () => {
  assert.deepEqual(parseApiVersion("1.4"), { raw: "1.4", major: 1, minor: 4 });
  assert.equal(parseApiVersion(""), null);
  assert.equal(assertCompatibleVersion("1.9", "test").major, 1);
  assert.throws(
    () => assertCompatibleVersion("2.0", "test"),
    (error) => error.code === "API_VERSION_UNSUPPORTED",
  );
});

test("strict negotiation accepts validated headers and prefers a metadata version", async (t) => {
  const scenarios = [
    { name: "metadata only", metadata: { apiVersion: "1.4" }, expected: "1.4" },
    { name: "metadata wins", metadata: { apiVersion: "1.4" }, metaHeader: "1.3", probeHeader: "1.2", expected: "1.4" },
    { name: "metadata header", metadata: {}, metaHeader: "1.3", expected: "1.3" },
    { name: "probe header", probeHeader: "1.2", expected: "1.2" },
    { name: "degraded probe header", probeStatus: 503, probeHeader: "1.2", expected: "1.2" },
    { name: "missing metadata response header", metaHeader: "1.3", expected: "1.3" },
    { name: "malformed header", probeHeader: "unknown", error: "API_VERSION_UNVERIFIED" },
    { name: "unsupported probe header", probeHeader: "2.0", error: "API_VERSION_UNSUPPORTED" },
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const client = new WorkflowClient({
        baseUrl: "https://coderax.test",
        strict: true,
        fetchImpl: async (url, { method }) => {
          assert.equal(method, "GET");
          if (url.pathname === "/api/meta" || url.pathname === "/api/work/tasks") {
            const meta = url.pathname === "/api/meta";
            const version = meta ? scenario.metaHeader : scenario.probeHeader;
            return Response.json(meta ? scenario.metadata ?? {} : { tasks: [] }, {
              status: meta ? (scenario.metadata ? 200 : 404) : scenario.probeStatus ?? 200,
              headers: version ? { "x-coderax-api-version": version } : {},
            });
          }
          return new Response(null, { status: 404 });
        },
      });
      if (scenario.error) {
        await assert.rejects(client.negotiate(), { code: scenario.error });
      } else {
        assert.equal((await client.negotiate()).apiVersion, scenario.expected);
        assert.ok(!client.diagnostics.some(({ code }) => code === "API_VERSION_UNVERIFIED"));
      }
    });
  }
});

test("conversation pointers are keyed by deployment and bounded", () => {
  let sessions = {};
  sessions = withSession(sessions, "https://coderax.test/", {
    conversationId: "c1",
    parentMessageId: "m1",
  });
  assert.equal(getSession({ sessions }, "https://coderax.test").conversationId, "c1");
  assert.equal(getSession({ sessions }, "https://other.test").conversationId, null);
  sessions = withSession(sessions, "https://coderax.test", { conversationId: "c2" });
  assert.equal(getSession({ sessions }, "https://coderax.test").conversationId, "c2");
  assert.deepEqual(clearSession(sessions, "https://coderax.test"), {});
});

test("session normalization drops malformed entries without throwing", () => {
  assert.deepEqual(
    normalizeSessions({
      a: { conversationId: "ok", parentMessageId: 3 },
      b: { conversationId: "" },
      c: null,
      d: [],
    }),
    { a: { conversationId: "ok", parentMessageId: null } },
  );
});

test("saving a session writes 0600 config and never stores the token in sessions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coderax-session-"));
  const file = join(directory, "config.json");
  const { saveConfig } = await import("../src/legacy-config.js");
  await saveConfig(
    { baseUrl: "https://coderax.test", token: "secret-token", sessions: withSession({}, "https://coderax.test", { conversationId: "c1" }) },
    { filePath: file },
  );
  const stored = JSON.parse(await readFile(file, "utf8"));
  assert.equal(stored.token, "secret-token");
  assert.equal(stored.sessions["https://coderax.test"].conversationId, "c1");
  assert.equal(JSON.stringify(stored.sessions).includes("secret-token"), false);
});
