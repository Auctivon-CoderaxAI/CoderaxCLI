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
  const bytes = await readFile(documentPath);
  const digest = createHash("sha256").update(bytes).digest("hex");
  assert.equal(digest, CONTRACT_SOURCE.openapiSha256);
  const document = JSON.parse(bytes.toString("utf8"));
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
