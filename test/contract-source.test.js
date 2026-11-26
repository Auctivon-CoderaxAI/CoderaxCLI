import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  CONTRACT_SOURCE,
  CONTRACT_VERSION,
  EVENT_SCHEMA_VERSION,
  SDK_VERSION,
} from "../src/engine/contract.js";

const documentPath = fileURLToPath(
  new URL("../contracts/workflow-engine-1.0.0.openapi.json", import.meta.url),
);

const EXPECTED_OPERATIONS = Object.freeze([
  ["GET", "/v1/health", "getHealth"],
  ["GET", "/v1/ready", "getReadiness"],
  ["GET", "/v1/agents", "listAgents"],
  ["GET", "/v1/models", "listModels"],
  ["POST", "/v1/chat", "submitChat"],
  ["POST", "/v1/work", "submitWork"],
  ["GET", "/v1/work/{taskId}", "getTask"],
  ["POST", "/v1/work/{taskId}/cancel", "cancelTask"],
  ["POST", "/v1/work/{taskId}/resume", "resumeTask"],
  ["POST", "/v1/work/{taskId}/retry", "retryTask"],
  ["GET", "/v1/work/{taskId}/events", "streamTaskEvents"],
  ["GET", "/v1/work/{taskId}/permissions", "listPermissions"],
  ["POST", "/v1/work/{taskId}/permissions", "decidePermission"],
  ["GET", "/v1/conversations", "listConversations"],
  ["GET", "/v1/conversations/{conversationId}", "getConversation"],
  ["GET", "/v1/memory", "listMemory"],
  ["GET", "/v1/notifications", "listNotifications"],
]);

test("the vendored OpenAPI document is the pinned engine artifact", async () => {
  const bytes = await readFile(documentPath);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), CONTRACT_SOURCE.openapiSha256);
  const document = JSON.parse(bytes.toString("utf8"));
  assert.equal(document.openapi, "3.1.0");
  assert.equal(document.info.version, CONTRACT_VERSION);
  assert.equal(document.info.version, SDK_VERSION);
  assert.equal(document.paths["/v1/health"].get.responses["200"].content["application/json"].schema.properties.contractVersion.const, CONTRACT_VERSION);
});

test("every CLI operation exists with the published operation id", async () => {
  const document = JSON.parse(await readFile(documentPath, "utf8"));
  const published = new Map();
  for (const [path, methods] of Object.entries(document.paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      if (["get", "post", "put", "patch", "delete", "head", "options"].includes(method)) {
        published.set(`${method.toUpperCase()} ${path}`, operation.operationId);
      }
    }
  }
  assert.equal(published.size, EXPECTED_OPERATIONS.length);
  for (const [method, path, operationId] of EXPECTED_OPERATIONS) {
    assert.equal(published.get(`${method} ${path}`), operationId, `${method} ${path}`);
  }
});

test("only liveness and readiness are public", async () => {
  const document = JSON.parse(await readFile(documentPath, "utf8"));
  const publicRoutes = [];
  for (const [path, methods] of Object.entries(document.paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      if (["get", "post"].includes(method) && Array.isArray(operation.security) && operation.security.length === 0) {
        publicRoutes.push(`${method.toUpperCase()} ${path}`);
      }
    }
  }
  assert.deepEqual(publicRoutes.sort(), ["GET /v1/health", "GET /v1/ready"]);
});

test("the pinned versions match the client constants", () => {
  assert.equal(CONTRACT_VERSION, "1.0.0");
  assert.equal(SDK_VERSION, "1.0.0");
  assert.equal(EVENT_SCHEMA_VERSION, 1);
  assert.equal(CONTRACT_SOURCE.commit, "808dfd3797f9b1d7647ebd14bd395806fc4ab9bd");
});
