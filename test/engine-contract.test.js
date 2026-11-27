import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  CONTRACT_SOURCE,
  CONTRACT_VERSION,
  ROUTES,
  SDK_VERSION,
  EVENT_SCHEMA_VERSION,
} from "../src/contract.js";

const documentPath = fileURLToPath(
  new URL("../contracts/workflow-engine-1.0.0.openapi.json", import.meta.url),
);

test("the vendored OpenAPI document is the pinned engine artifact", async () => {
  const text = await readFile(documentPath, "utf8");
  // The digest is over the engine's LF bytes. Normalize CRLF so a Windows
  // checkout cannot report contract drift that does not exist.
  const digest = createHash("sha256").update(text.replace(/\r\n/g, "\n"), "utf8").digest("hex");
  assert.equal(digest, CONTRACT_SOURCE.openapiSha256);
  const document = JSON.parse(text);
  assert.equal(document.openapi, "3.1.0");
  assert.equal(document.info.version, CONTRACT_VERSION);
});

test("every CLI route exists in the authoritative document with the same operation id", async () => {
  const document = JSON.parse(await readFile(documentPath, "utf8"));
  const published = new Map();
  for (const [path, methods] of Object.entries(document.paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      if (["get", "post", "put", "patch", "delete", "head", "options"].includes(method)) {
        published.set(`${method.toUpperCase()} ${path}`, operation.operationId);
      }
    }
  }
  assert.equal(published.size, ROUTES.length);
  for (const route of ROUTES) {
    const key = `${route.method} ${route.path}`;
    assert.equal(published.get(key), route.operationId, `${key} is not the document's operation`);
    assert.equal(route.path.startsWith("/v1/"), true, `${key} is outside the versioned prefix`);
  }
});

test("the contract and event versions match the published SDK generation", () => {
  assert.equal(CONTRACT_VERSION, "1.0.0");
  assert.equal(SDK_VERSION, "1.0.0");
  assert.equal(EVENT_SCHEMA_VERSION, 1);
  assert.equal(CONTRACT_SOURCE.repository, "Auctivon-CoderaxAI/Coderax-WorkflowEngine");
});

test("public operations are limited to liveness and readiness", () => {
  const publicRoutes = ROUTES.filter((route) => route.auth === "public").map((route) => route.path);
  assert.deepEqual(publicRoutes.sort(), ["/v1/health", "/v1/ready"]);
});

test("the engine client contains no legacy or unversioned route", async () => {
  for (const file of ["../src/engine.js", "../src/contract.js"]) {
    const source = await readFile(fileURLToPath(new URL(file, import.meta.url)), "utf8");
    assert.equal(/\/api\//.test(source), false, `${file} still references a legacy /api route`);
  }
});

test("the Chat overlay documents the pinned handler's JSON reply", async () => {
  const document = JSON.parse(await readFile(documentPath, "utf8"));
  const overlay = JSON.parse(await readFile(new URL(
    "../contracts/workflow-engine-chat.overlay.json", import.meta.url
  ), "utf8"));
  const [summary, content, removal] = overlay.actions;
  assert.equal(overlay.extends, "./workflow-engine-1.0.0.openapi.json");
  assert.equal(summary.target, "$.paths['/v1/chat'].post");
  assert.equal(content.target, "$.paths['/v1/chat'].post.responses['200'].content");
  assert.equal(removal.target, content.target + "['text/event-stream']");
  assert.equal(removal.remove, true);
  const chat = ROUTES.find(({ operationId }) => operationId === "submitChat");
  assert.equal(chat.stream, false);
  assert.deepEqual(Object.keys(content.update), [chat.responseMediaType]);
  assert.deepEqual(document.paths["/v1/chat"].post.responses["200"].content, {
    "text/event-stream": { schema: { type: "string" } },
  });
  const { schema } = content.update[chat.responseMediaType];
  assert.equal(schema.type, "object");
  assert.equal(schema.properties.text.type, "string");
  assert.ok(schema.required.includes("text"));
});
