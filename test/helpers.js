import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function tempDir(prefix = "coderax-test-") {
  return mkdtemp(join(tmpdir(), prefix));
}

export function capture() {
  const out = [];
  const err = [];
  return {
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    out: () => out.join(""),
    err: () => err.join(""),
    clear() {
      out.length = 0;
      err.length = 0;
    },
  };
}

export function streams(io) {
  return {
    stdoutStream: { isTTY: false, columns: 100, write: (text) => io.stdout(text) },
    stderrStream: { isTTY: false, write: (text) => io.stderr(text) },
  };
}

export function optionsFor(env, io, extra = {}) {
  return {
    env,
    stdout: io.stdout,
    stderr: io.stderr,
    stdinIsTTY: false,
    handleSignals: false,
    ...streams(io),
    ...extra,
  };
}

export function validHealth(overrides = {}) {
  return {
    status: "ok",
    contractVersion: "1.0.0",
    startedAt: new Date().toISOString(),
    uptimeMs: 1000,
    checks: [{ name: "persistence", status: "ok", required: true }],
    engines: [
      {
        id: "native",
        capabilities: {
          streaming: true,
          tools: true,
          cancellation: true,
          resume: true,
          modelSelection: true,
          durable: true,
        },
        availability: { available: true, reason: "ready", detail: "" },
      },
    ],
    ...overrides,
  };
}

export function validAgents(overrides = {}) {
  return {
    agents: [
      {
        id: "coderax",
        engine: "native",
        label: "Coderax Native",
        external: false,
        capabilities: {
          streaming: true,
          tools: true,
          cancellation: true,
          resume: true,
          modelSelection: true,
          durable: true,
        },
        availability: { available: true, reason: "ready", detail: "" },
        isolation: { workspace: "isolated", memory: "none", credentials: "none", conversations: "none" },
      },
    ],
    ...overrides,
  };
}

export function validTaskStatus(overrides = {}) {
  return {
    taskId: "task_1",
    conversationId: "conv_1",
    state: "running",
    agent: "coderax",
    mode: "cloud",
    generation: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    cancelRequested: false,
    steps: [],
    ...overrides,
  };
}

export function validEvent(overrides = {}) {
  return {
    v: 1,
    eventId: "evt_1",
    taskId: "task_1",
    seq: 1,
    at: new Date().toISOString(),
    agent: "coderax",
    generation: 0,
    type: "task.queued",
    ...overrides,
  };
}
