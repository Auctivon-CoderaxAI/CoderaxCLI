import test from "node:test";
import assert from "node:assert/strict";
import { EventAssembler, followTaskEvents } from "../src/events.js";
import { SseDecoder, parseJsonFrame } from "../src/sse.js";
import { CoderaxError } from "../src/client.js";

function delta(seq, text, eventId = `evt_${seq}`) {
  return { eventId, taskId: "t", seq, type: "text.delta", payload: { text } };
}

function replace(seq, text) {
  return { eventId: `evt_${seq}`, taskId: "t", seq, type: "text.replace", payload: { text } };
}

function terminal(seq, type = "task.completed", payload = { summary: "done" }) {
  return { eventId: `evt_${seq}`, taskId: "t", seq, type, ...(payload ? { payload } : {}) };
}

test("assembler appends incremental deltas and preserves repeated text", () => {
  const assembler = new EventAssembler();
  for (const [seq, text] of [[1, "ha"], [2, "ha"], [3, "!"]]) {
    const outcome = assembler.apply(delta(seq, text));
    assert.equal(outcome.kind, "delta");
  }
  assert.equal(assembler.text, "haha!");
});

test("a cumulative snapshot emits only the unseen suffix", () => {
  const assembler = new EventAssembler();
  assembler.apply(delta(1, "Hello"));
  const outcome = assembler.apply(replace(2, "Hello world"));
  assert.equal(outcome.kind, "delta");
  assert.equal(outcome.text, " world");
  assert.equal(assembler.text, "Hello world");
});

test("a snapshot that rewrites text emits one replacement, not an append", () => {
  const assembler = new EventAssembler();
  assembler.apply(delta(1, "old draft"));
  const outcome = assembler.apply(replace(2, "corrected answer"));
  assert.equal(outcome.kind, "replace");
  assert.equal(outcome.text, "corrected answer");
  assert.equal(assembler.text, "corrected answer");
});

test("an incremental delta already contained in a snapshot is not printed twice", () => {
  const assembler = new EventAssembler();
  const kinds = [];
  for (const event of [
    delta(1, "Hello"),
    replace(2, "Hello world"),
    delta(3, " world"),
    delta(4, "!"),
  ]) {
    kinds.push(assembler.apply(event).kind);
  }
  assert.deepEqual(kinds, ["delta", "delta", "duplicate-text", "delta"]);
  assert.equal(assembler.text, "Hello world!");
});

test("legacy cumulative frames and top-level deltas do not duplicate output", () => {
  const assembler = new EventAssembler();
  const emitted = [];
  const onOutcome = (outcome) => {
    if (outcome.kind === "delta") emitted.push(outcome.text);
  };
  onOutcome(assembler.apply({ message: true, text: "accepted", eventId: "a", seq: 1 }));
  onOutcome(assembler.apply({ message: true, text: "accepted and verified", eventId: "b", seq: 2 }));
  onOutcome(assembler.apply({ delta: " and verified", eventId: "c", seq: 3 }));
  assert.equal(assembler.text, "accepted and verified");
  assert.equal(emitted.join(""), "accepted and verified");
});

test("duplicate event ids and replayed sequence numbers are ignored", () => {
  const assembler = new EventAssembler();
  assert.equal(assembler.apply(delta(1, "a")).kind, "delta");
  assert.equal(assembler.apply(delta(1, "a")).kind, "duplicate");
  assert.equal(assembler.apply(delta(2, "b", "evt_1")).kind, "duplicate");
  assert.equal(assembler.apply(delta(0, "x")).kind, "delta");
  assert.equal(assembler.text, "ax");
});

test("an out-of-order event cannot move the cursor backwards", () => {
  const assembler = new EventAssembler();
  assembler.apply(delta(5, "five"));
  const outcome = assembler.apply(delta(4, "four"));
  assert.equal(outcome.kind, "duplicate");
  assert.equal(assembler.lastSeq, 5);
  assert.equal(assembler.text, "five");
});

test("an unknown event type is ignored while advancing the cursor", () => {
  const assembler = new EventAssembler();
  const outcome = assembler.apply({ eventId: "x", seq: 7, type: "future.event", payload: {} });
  assert.equal(outcome.kind, "unknown");
  assert.equal(assembler.lastSeq, 7);
});

test("terminal events record the authoritative state", () => {
  const assembler = new EventAssembler();
  const outcome = assembler.apply(terminal(1, "task.failed", { code: "provider_error", retryable: true }));
  assert.equal(outcome.kind, "terminal");
  assert.equal(assembler.terminal.state, "failed");
});

test("the SSE decoder reassembles frames split at every boundary", () => {
  const frames = [
    'data: {"type":"text.delta","payload":{"text":"split"}}\r\n\r\n',
    'data: {"type":"text.delta",\r\ndata: "payload":{"text":" frame"}}\n\n',
  ].join("");
  const decoder = new SseDecoder();
  const parsed = [];
  for (const chunk of frames.split("")) {
    for (const frame of decoder.push(chunk)) parsed.push(parseJsonFrame(frame));
  }
  assert.deepEqual(
    parsed.map((event) => event.payload.text).join(""),
    "split frame",
  );
});

test("a malformed frame is a protocol error, not silent text", () => {
  const decoder = new SseDecoder();
  const [frame] = decoder.push("data: not-json\n\n");
  assert.throws(() => parseJsonFrame(frame), (error) => /not valid JSON/.test(error.message));
});

class ScriptedClient {
  constructor(connections) {
    this.connections = connections;
    this.calls = 0;
    this.after = [];
  }

  async *events(_taskId, { after } = {}) {
    this.after.push(after ?? 0);
    const connection = this.connections[this.calls];
    this.calls += 1;
    if (!connection) throw new CoderaxError("REQUEST_FAILED", "no connection scripted");
    for (const event of connection.events) yield event;
    if (connection.error) throw connection.error;
  }
}

test("follow reconnects from the last sequence and deduplicates replay", async () => {
  const client = new ScriptedClient([
    { events: [delta(1, "Hello")], error: new CoderaxError("REQUEST_FAILED", "socket closed") },
    {
      events: [
        delta(1, "Hello"),
        delta(2, " world"),
        terminal(3),
      ],
    },
  ]);
  const assembler = await followTaskEvents({
    client,
    taskId: "t",
    sleep: async () => {},
  });
  assert.equal(assembler.text, "Hello world");
  assert.deepEqual(client.after, [0, 1]);
  assert.equal(assembler.eventCount, 3);
});

test("follow reconnects after a clean close without a terminal event", async () => {
  const client = new ScriptedClient([
    { events: [delta(1, "Hello")] },
    { events: [delta(2, "!")] },
    { events: [terminal(3)] },
  ]);
  const assembler = await followTaskEvents({ client, taskId: "t", sleep: async () => {} });
  assert.equal(assembler.text, "Hello!");
  assert.deepEqual(client.after, [0, 1, 2]);
});

test("an expired token is fatal and is never retried", async () => {
  const client = new ScriptedClient([
    { events: [], error: new CoderaxError("unauthorized", "token expired", { status: 401 }) },
  ]);
  await assert.rejects(
    () => followTaskEvents({ client, taskId: "t", sleep: async () => {} }),
    (error) => error.code === "unauthorized",
  );
  assert.equal(client.calls, 1);
});

test("detaching aborts the follow loop with CANCELLED", async () => {
  const controller = new AbortController();
  controller.abort();
  const client = new ScriptedClient([{ events: [delta(1, "never")] }]);
  await assert.rejects(
    () => followTaskEvents({ client, taskId: "t", signal: controller.signal, sleep: async () => {} }),
    (error) => error.code === "CANCELLED",
  );
});

test("follow stops after the configured number of failed reconnects", async () => {
  const client = new ScriptedClient(
    Array.from({ length: 4 }, () => ({ events: [], error: new CoderaxError("REQUEST_FAILED", "down") })),
  );
  await assert.rejects(
    () => followTaskEvents({ client, taskId: "t", sleep: async () => {}, maxReconnects: 2 }),
    (error) => error.code === "STREAM_DISCONNECTED",
  );
  assert.equal(client.calls, 3);
});
