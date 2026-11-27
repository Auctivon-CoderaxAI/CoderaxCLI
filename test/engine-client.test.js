import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { EngineClient } from "../src/engine.js";
import { followTaskEvents } from "../src/events.js";
import {
  TOKEN,
  agentsBody,
  event,
  healthBody,
  problem,
  sseHead,
  sseWrite,
  withServer,
} from "./support.js";

function client(url, overrides = {}) {
  return new EngineClient({ baseUrl: url, token: TOKEN, timeoutMs: 2000, ...overrides });
}

function delta(seq, text, eventId = `evt_${seq}`) {
  return event("text.delta", seq, { text }, { eventId });
}

function replace(seq, text) {
  return event("text.replace", seq, { text }, { eventId: `evt_${seq}` });
}

function terminal(seq) {
  return event("task.completed", seq, { summary: "done" }, { eventId: `evt_${seq}` });
}

async function listen(server, port = 0) {
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

async function close(server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

test("health is public and owner failures keep the Problem code", async () => {
  await withServer(
    (req, res) => {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname === "/v1/health") return sseJson(res, healthBody());
      if (url.pathname === "/v1/agents") {
        assert.equal(req.headers.authorization, `Bearer ${TOKEN}`);
        return sseJson(res, agentsBody());
      }
      if (url.pathname === "/v1/work/missing") {
        return sseJson(res, problem(404, "not_found", "no such task", { requestId: "req-404" }), 404);
      }
      return sseJson(res, problem(404, "not_found", "missing"), 404);
    },
    async (url) => {
      const api = client(url);
      const health = await api.health();
      assert.equal(health.contractVersion, "1.0.0");
      const agents = await api.agents();
      assert.equal(agents.agents.length, 3);

      await assert.rejects(
        () => api.task("missing"),
        (error) => {
          assert.equal(error.code, "not_found");
          assert.equal(error.status, 404);
          assert.equal(error.requestId, "req-404");
          return true;
        },
      );
    },
  );
});

test("an owner operation without the token is rejected, not guessed", async () => {
  await withServer(
    (req, res) => {
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        return sseJson(res, problem(401, "unauthorized", "owner token required"), 401);
      }
      return sseJson(res, agentsBody());
    },
    async (url) => {
      const anonymous = new EngineClient({ baseUrl: url, timeoutMs: 2000 });
      await assert.rejects(
        () => anonymous.agents(),
        (error) => error.code === "unauthorized" && error.status === 401,
      );
    },
  );
});

test("SSE frames survive arbitrary chunking and CRLF boundaries", async () => {
  const raw = [
    'data: {"type":"text.delta","payload":{"text":"split"}}\r\n\r\n',
    'data: {"type":"text.delta",\r\ndata: "payload":{"text":" frame"}}\r\n\r\n',
    'data: {"type":"task.completed","payload":{"summary":"done"}}\r\n\r\n',
  ].join("");

  await withServer(
    (req, res) => {
      sseHead(res);
      for (let index = 0; index < raw.length; index += 1) {
        res.write(raw.slice(index, index + 1));
      }
      res.end();
    },
    async (url) => {
      const events = [];
      for await (const value of client(url).events("task-1")) events.push(value);
      assert.equal(
        events.filter((value) => value.type === "text.delta").map((value) => value.payload.text).join(""),
        "split frame",
      );
      assert.equal(events.at(-1).type, "task.completed");
    },
  );
});

test("a malformed frame fails loudly instead of being rendered as text", async () => {
  await withServer(
    (req, res) => {
      sseHead(res);
      res.write("data: this is not json\n\n");
      res.end();
    },
    async (url) => {
      await assert.rejects(
        async () => {
          for await (const value of client(url).events("task-1")) void value;
        },
        (error) => error.code === "STREAM_PROTOCOL",
      );
    },
  );
});

test("an expired token on an event stream is fatal and never retried", async () => {
  let requests = 0;
  await withServer(
    (req, res) => {
      requests += 1;
      sseJson(res, problem(401, "unauthorized", "token expired"), 401);
    },
    async (url) => {
      await assert.rejects(
        () => followTaskEvents({ client: client(url), taskId: "task-1", sleep: async () => {} }),
        (error) => error.code === "unauthorized",
      );
      assert.equal(requests, 1);
    },
  );
});

test("a dropped stream reconnects from the last sequence and does not duplicate replay", async () => {
  let calls = 0;
  await withServer(
    (req, res) => {
      const url = new URL(req.url, "http://localhost");
      calls += 1;
      if (calls === 1) {
        sseHead(res);
        sseWrite(res, delta(1, "Hello"));
        setTimeout(() => res.destroy(), 20);
        return;
      }
      assert.equal(url.searchParams.get("after"), "1");
      sseHead(res);
      sseWrite(res, delta(1, "Hello"));
      sseWrite(res, delta(2, " world"));
      sseWrite(res, terminal(3));
      res.end();
    },
    async (url) => {
      const assembler = await followTaskEvents({
        client: client(url),
        taskId: "task-1",
        sleep: async () => {},
      });
      assert.equal(assembler.text, "Hello world");
      assert.equal(assembler.eventCount, 3);
      assert.equal(calls, 2);
    },
  );
});

test("an event stream survives a server restart on the same origin", async () => {
  let resolveFirst;
  const first = new Promise((resolve) => {
    resolveFirst = resolve;
  });

  const serverA = createServer((req, res) => {
    sseHead(res);
    sseWrite(res, delta(1, "Hello"));
  });
  const port = await listen(serverA);
  const api = client(`http://127.0.0.1:${port}`);

  const following = followTaskEvents({
    client: api,
    taskId: "task-1",
    onEvent: (value, outcome) => {
      if (outcome.kind === "delta") resolveFirst();
    },
  });

  await first;
  await close(serverA);

  const serverB = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    assert.equal(url.searchParams.get("after"), "1");
    sseHead(res);
    sseWrite(res, delta(2, " world"));
    sseWrite(res, terminal(3));
    res.end();
  });
  await listen(serverB, port);

  try {
    const assembler = await following;
    assert.equal(assembler.text, "Hello world");
  } finally {
    await close(serverB);
  }
});

test("an idle event stream has its own deadline instead of hanging", async () => {
  await withServer(
    (req, res) => {
      sseHead(res);
      sseWrite(res, delta(1, "first"));
      // Deliberately never ends and never writes again.
    },
    async (url) => {
      await assert.rejects(
        async () => {
          for await (const value of client(url, { eventTimeoutMs: 1000 }).events("task-1")) void value;
        },
        (error) => error.code === "REQUEST_TIMEOUT",
      );
    },
  );
});

test("cumulative snapshots and incremental deltas never print the same text twice", async () => {
  await withServer(
    (req, res) => {
      sseHead(res);
      sseWrite(res, delta(1, "Hello"));
      sseWrite(res, replace(2, "Hello world"));
      sseWrite(res, delta(3, " world"));
      sseWrite(res, terminal(4));
      res.end();
    },
    async (url) => {
      const emitted = [];
      const assembler = await followTaskEvents({
        client: client(url),
        taskId: "task-1",
        sleep: async () => {},
        onEvent: (value, outcome) => {
          if (outcome.kind === "delta") emitted.push(outcome.text);
        },
      });
      assert.equal(assembler.text, "Hello world");
      assert.equal(emitted.join(""), "Hello world");
    },
  );
});

test("replayed duplicate events are consumed once", async () => {
  await withServer(
    (req, res) => {
      sseHead(res);
      sseWrite(res, delta(1, "once"));
      sseWrite(res, delta(1, "once"));
      sseWrite(res, terminal(2));
      res.end();
    },
    async (url) => {
      const assembler = await followTaskEvents({
        client: client(url),
        taskId: "task-1",
        sleep: async () => {},
      });
      assert.equal(assembler.text, "once");
      assert.equal(assembler.eventCount, 2);
    },
  );
});

test("an events request carries the replay cursor", async () => {
  await withServer(
    (req, res) => {
      const url = new URL(req.url, "http://localhost");
      assert.equal(url.searchParams.get("after"), "7");
      sseHead(res);
      sseWrite(res, terminal(8));
      res.end();
    },
    async (url) => {
      const events = [];
      for await (const value of client(url).events("task-1", { after: 7 })) events.push(value);
      assert.equal(events.length, 1);
      assert.equal(events[0].seq, 8);
    },
  );
});

function sseJson(res, payload, status = 200) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

test("active events can continue past the idle window and the JSON deadline", async () => {
  await withServer(
    async (req, res) => {
      sseHead(res);
      for (let seq = 1; seq <= 5; seq += 1) {
        if (seq > 1) await new Promise((resolve) => setTimeout(resolve, 300));
        sseWrite(res, delta(seq, String(seq)));
      }
      res.end();
    },
    async (url) => {
      const seqs = [];
      for await (const value of client(url, { timeoutMs: 100, eventTimeoutMs: 1000 }).events("task-1")) {
        seqs.push(value.seq);
      }
      assert.deepEqual(seqs, [1, 2, 3, 4, 5]);
    },
  );
});
