#!/usr/bin/env node
/**
 * Local contract validation, plus an optional cross-repository check.
 *
 * `npm run test:contract` without an engine checkout validates the CLI's
 * dependency-free mirror. CI passes a pinned WorkflowEngine checkout so the
 * pinned contract version and `/v1` route surface are compared, not assumed.
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
import {
  CONTRACT_SOURCE,
  CONTRACT_VERSION,
  EVENT_SCHEMA_VERSION,
  SDK_VERSION,
  assertAgentList,
  assertExecutionEvent,
  assertHealth,
  assertTaskStatus,
} from "../src/engine/contract.js";
import { validAgents, validEvent, validHealth, validTaskStatus } from "../test/helpers.js";

const failures = [];
const notes = [];

function expect(condition, message) {
  if (!condition) failures.push(message);
}

expect(CONTRACT_VERSION === "1.0.0", `unexpected local CONTRACT_VERSION ${CONTRACT_VERSION}`);
expect(SDK_VERSION === "1.0.0", `unexpected local SDK_VERSION ${SDK_VERSION}`);
expect(EVENT_SCHEMA_VERSION === 1, `unexpected local EVENT_SCHEMA_VERSION ${EVENT_SCHEMA_VERSION}`);

const vendoredPath = new URL("../contracts/workflow-engine-1.0.0.openapi.json", import.meta.url);
const vendoredBytes = await readFile(vendoredPath).catch((error) => {
  failures.push(`vendored OpenAPI could not be read: ${error.message}`);
  return null;
});
if (vendoredBytes) {
  const digest = createHash("sha256").update(vendoredBytes).digest("hex");
  expect(digest === CONTRACT_SOURCE.openapiSha256, `vendored OpenAPI digest ${digest} does not match the pin`);
  let document = null;
  try {
    document = JSON.parse(vendoredBytes.toString("utf8"));
  } catch (error) {
    failures.push(`vendored OpenAPI is not valid JSON: ${error.message}`);
  }
  if (document) {
    expect(document.info?.version === CONTRACT_VERSION, `vendored OpenAPI version ${document.info?.version} does not match ${CONTRACT_VERSION}`);
    const paths = Object.keys(document.paths ?? {});
    expect(paths.length === 16, `vendored OpenAPI has ${paths.length} paths, expected 16`);
    for (const route of ["/v1/health", "/v1/ready", "/v1/agents", "/v1/models", "/v1/chat", "/v1/work", "/v1/work/{taskId}/events", "/v1/notifications"]) {
      expect(paths.includes(route), `vendored OpenAPI is missing ${route}`);
    }
    notes.push(`vendored OpenAPI ${CONTRACT_SOURCE.commit.slice(0, 12)} verified (${digest.slice(0, 12)})`);
  }
}

try {
  assertHealth(validHealth());
  assertAgentList(validAgents());
  assertTaskStatus(validTaskStatus());
  const samples = {
    "task.queued": {},
    "task.started": { payload: { sessionId: "session_1" } },
    "text.delta": { payload: { text: "x" } },
    "tool.call": { payload: { callId: "call_1", tool: "read" } },
    "task.completed": { payload: {} },
  };
  for (const [type, extra] of Object.entries(samples)) {
    assertExecutionEvent(validEvent({ type, ...extra }));
  }
  notes.push("local validators accept the canonical fixtures");
} catch (error) {
  failures.push(`local validator failure: ${error.message}`);
}

async function walk(directory, output = [], depth = 0) {
  if (depth > 8) return output;
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return output;
  }
  for (const entry of entries) {
    if (["node_modules", ".git", "dist", "coverage", "test", "tests", "__tests__"].includes(entry.name)) continue;
    const full = join(directory, entry.name);
    if (entry.isDirectory()) await walk(full, output, depth + 1);
    else if (entry.isFile() && /\.(?:ts|js|mjs|json|ya?ml|md)$/.test(entry.name)) output.push(full);
  }
  return output;
}

const engineDirectory = process.argv[2] ?? process.env.CODERAX_ENGINE_DIR;
if (engineDirectory) {
  const files = await walk(engineDirectory);
  const versions = new Set();
  const schemaVersions = new Set();
  const openapiFiles = [];
  for (const file of files) {
    const info = await stat(file).catch(() => null);
    if (!info || info.size > 2 * 1024 * 1024) continue;
    if (/(?:^|\/)openapi\.json$/i.test(file)) openapiFiles.push(file);
    if (!/\.(?:ts|js|mjs)$/.test(file)) continue;
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(/CONTRACT_VERSION\s*=\s*["']([^"']+)["']/g)) versions.add(match[1]);
    for (const match of source.matchAll(/EVENT_SCHEMA_VERSION\s*=\s*(\d+)/g)) schemaVersions.add(match[1]);
  }

  if (versions.size === 0) {
    failures.push(`could not find CONTRACT_VERSION in ${engineDirectory}; pass a full engine checkout`);
  } else {
    for (const version of versions) {
      if (version !== CONTRACT_VERSION) failures.push(`engine contract ${version} does not match CLI ${CONTRACT_VERSION}`);
    }
  }
  if (schemaVersions.size === 0) {
    failures.push(`could not find EVENT_SCHEMA_VERSION in ${engineDirectory}`);
  } else {
    for (const version of schemaVersions) {
      if (Number(version) !== EVENT_SCHEMA_VERSION) failures.push(`engine event schema ${version} does not match CLI ${EVENT_SCHEMA_VERSION}`);
    }
  }

  let routeCount = 0;
  for (const file of openapiFiles) {
    let document;
    try {
      document = JSON.parse(await readFile(file, "utf8"));
    } catch {
      failures.push(`${relative(engineDirectory, file)} is not valid JSON`);
      continue;
    }
    const paths = Object.keys(document?.paths ?? {});
    routeCount += paths.length;
    const required = [
      "/v1/health",
      "/v1/ready",
      "/v1/agents",
      "/v1/models",
      "/v1/chat",
      "/v1/work",
      "/v1/work/{taskId}",
      "/v1/work/{taskId}/cancel",
      "/v1/work/{taskId}/resume",
      "/v1/work/{taskId}/retry",
      "/v1/work/{taskId}/events",
      "/v1/work/{taskId}/permissions",
      "/v1/conversations",
      "/v1/conversations/{conversationId}",
      "/v1/memory",
      "/v1/notifications",
    ];
    for (const route of required) {
      if (!paths.includes(route)) failures.push(`${relative(engineDirectory, file)} is missing ${route}`);
    }
  }
  if (routeCount === 0 && openapiFiles.length > 0) notes.push("OpenAPI documents were empty");
  const packagePath = join(engineDirectory, "package.json");
  try {
    const enginePackage = JSON.parse(await readFile(packagePath, "utf8"));
    notes.push(`engine ${enginePackage.name ?? "(unnamed)"} ${enginePackage.version ?? ""}`.trim());
  } catch {
    // A package file is not required for the contract comparison.
  }
  notes.push(`${files.length} engine files inspected`);
}

if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`contract: ${failure}\n`);
  process.exit(1);
}
process.stdout.write(`contract: ${CONTRACT_VERSION}, event schema ${EVENT_SCHEMA_VERSION}\n`);
for (const note of notes) process.stdout.write(`  ${note}\n`);
if (!engineDirectory) {
  process.stdout.write("  cross-repository check skipped; pass an engine checkout or set CODERAX_ENGINE_DIR\n");
}
