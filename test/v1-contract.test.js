import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  CONTRACT_SOURCE,
  CONTRACT_VERSION,
  EVENT_SCHEMA_VERSION,
  ROUTE,
  assertExecutionEvent,
  assertHealth,
  negotiateContractVersion,
} from "../packages/workflow-sdk/src/v1/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const artifact = join(root, "contracts", "workflow-engine-1.0.0.openapi.json");

test("the vendored contract matches its recorded provenance", () => {
  const bytes = readFileSync(artifact);
  const digest = createHash("sha256").update(bytes).digest("hex");
  assert.equal(digest, CONTRACT_SOURCE.openapiSha256);
  const document = JSON.parse(bytes.toString("utf8"));
  assert.equal(document.info.version, CONTRACT_VERSION);
  assert.equal(EVENT_SCHEMA_VERSION, 1);
});

test("every mirrored route exists in the published document", () => {
  const document = JSON.parse(readFileSync(artifact, "utf8"));
  const published = new Set(Object.keys(document.paths));
  const mirrored = [
    ROUTE.health,
    ROUTE.ready,
    ROUTE.agents,
    ROUTE.models,
    ROUTE.chat,
    ROUTE.work,
    ROUTE.task("task_1"),
    ROUTE.cancel("task_1"),
    ROUTE.resume("task_1"),
    ROUTE.retry("task_1"),
    ROUTE.events("task_1"),
    ROUTE.conversations,
    ROUTE.conversation("conversation_1"),
    ROUTE.memory,
    ROUTE.permissions("task_1"),
    ROUTE.notifications,
  ];
  assert.equal(mirrored.length, published.size);
  const templateOf = (route) =>
    route
      .replace(/^\/v1\/work\/[^/]+/, "/v1/work/{taskId}")
      .replace(/^\/v1\/conversations\/[^/]+$/, "/v1/conversations/{conversationId}");
  for (const route of mirrored) {
    const template = templateOf(route);
    assert.equal(
      published.has(template),
      true,
      `${route} (${template}) is not in the published document`,
    );
  }
});

test("a compatible minor is accepted and a different major is refused", () => {
  assert.equal(negotiateContractVersion("1.0.0").major, 1);
  assert.equal(negotiateContractVersion("1.0.0").newerMinor, false);
  assert.equal(negotiateContractVersion("1.4.2").newerMinor, true);
  assert.throws(
    () => negotiateContractVersion("2.0.0"),
    (error) => error.code === "CONTRACT_UNSUPPORTED",
  );
  assert.throws(
    () => negotiateContractVersion("not-a-version"),
    (error) => error.code === "CONTRACT_UNSUPPORTED",
  );
  assert.throws(
    () => negotiateContractVersion(""),
    (error) => error.code === "CONTRACT_UNVERIFIED",
  );
});

test("validators reject an unexpected field instead of ignoring it", () => {
  const health = {
    status: "ok",
    contractVersion: "1.0.0",
    startedAt: "2026-11-27T00:00:00.000Z",
    uptimeMs: 10,
    checks: [],
    engines: [],
  };
  assert.equal(assertHealth(health), health);
  assert.throws(
    () => assertHealth({ ...health, surprise: true }),
    (error) => error.code === "CONTRACT_VIOLATION" && /surprise/.test(error.message),
  );
});

test("an unknown event type is ignored and a malformed known one is a violation", () => {
  const base = {
    v: 1,
    eventId: "evt_1",
    taskId: "task_1",
    seq: 1,
    at: "2026-11-27T00:00:00.000Z",
    agent: "coderax",
    generation: 0,
  };
  assert.equal(assertExecutionEvent({ ...base, type: "future.event", payload: {} }), null);
  assert.throws(
    () => assertExecutionEvent({ ...base, type: "text.delta", payload: { text: "" } }),
    (error) => error.code === "CONTRACT_VIOLATION",
  );
  assert.throws(
    () => assertExecutionEvent({ ...base, v: 2, type: "text.delta", payload: { text: "x" } }),
    (error) => error.code === "CONTRACT_VIOLATION" && /unsupported execution event version/.test(error.message),
  );
});
