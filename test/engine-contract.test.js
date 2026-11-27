import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  CONTRACT_FINGERPRINT,
  CONTRACT_SOURCE,
  CONTRACT_VERSION,
  ROUTES,
  contractFingerprint,
} from "../src/engine-contract.js";

const DOCUMENT = new URL("../contracts/workflow-engine-1.2.0.openapi.json", import.meta.url);
const PIN = new URL("../contracts/workflow-engine-sdk-pin.json", import.meta.url);

test("the vendored OpenAPI document is byte-identical to the engine contract", async () => {
  const document = await readFile(DOCUMENT);
  assert.equal(
    createHash("sha256").update(document).digest("hex"),
    CONTRACT_SOURCE.openapiSha256,
  );
  const openapi = JSON.parse(document.toString("utf8"));
  assert.equal(openapi.info.version, CONTRACT_VERSION);
  assert.equal(openapi.openapi, "3.1.0");
});

test("every route matches the OpenAPI operation id, method and path", async () => {
  const openapi = JSON.parse(await readFile(DOCUMENT, "utf8"));
  const published = [];
  for (const [path, item] of Object.entries(openapi.paths)) {
    for (const [method, operation] of Object.entries(item)) {
      published.push({ operationId: operation.operationId, method: method.toUpperCase(), path });
    }
  }
  assert.equal(ROUTES.length, 40);
  assert.equal(published.length, ROUTES.length);
  for (const route of ROUTES) {
    const match = published.find((entry) => entry.operationId === route.operationId);
    assert.ok(match, `missing operation ${route.operationId}`);
    assert.equal(match.method, route.method, route.operationId);
    assert.equal(match.path, route.path, route.operationId);
  }
});

test("the route catalogue fingerprints to the engine's published fingerprint", () => {
  assert.equal(contractFingerprint(), CONTRACT_FINGERPRINT);
});

test("the pinned SDK metadata agrees with the route table", async () => {
  const pin = JSON.parse(await readFile(PIN, "utf8"));
  assert.equal(pin.contractVersion, CONTRACT_VERSION);
  assert.equal(pin.contractFingerprint, CONTRACT_FINGERPRINT);
  assert.equal(pin.sdk.version, CONTRACT_SOURCE.sdkVersion);
  assert.equal(pin.sdk.sha256, CONTRACT_SOURCE.sdkArtifactSha256);
  assert.equal(pin.openapi.sha256, CONTRACT_SOURCE.openapiSha256);
  assert.equal(pin.eventSchemaVersion, 1);
  assert.equal(pin.chatStreamVersion, 1);
  assert.equal(pin.legacyAdapter.status, "temporary-compatibility-adapter");
});

test("the authoritative task and event vocabularies are pinned", async () => {
  const { TASK_STATES, EXECUTION_EVENT_TYPES, TERMINAL_EVENT_TYPES } = await import(
    "../src/engine-contract.js"
  );
  assert.deepEqual(TASK_STATES, [
    "queued",
    "running",
    "awaiting_approval",
    "completed",
    "failed",
    "cancelled",
    "interrupted",
  ]);
  assert.deepEqual(TERMINAL_EVENT_TYPES, [
    "task.completed",
    "task.failed",
    "task.cancelled",
    "task.interrupted",
  ]);
  assert.equal(EXECUTION_EVENT_TYPES.length, 16);
  assert.ok(EXECUTION_EVENT_TYPES.includes("stream.truncated"));
});
