#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  CONTRACT_FINGERPRINT,
  CONTRACT_SOURCE,
  CONTRACT_VERSION,
  ROUTES,
  contractFingerprint,
} from "../src/engine-contract.js";

/**
 * Cross-repository contract gate.
 *
 * Verifies the CLI's vendored document, route table and fingerprint against a
 * real WorkflowEngine checkout at the pinned commit, and checks the SDK
 * artifact manifest the engine publishes. It never writes to the engine tree
 * and never reads a credential.
 *
 * Usage: node scripts/verify-engine-contract.mjs --engine ../Coderax-WorkflowEngine
 *        CODERAX_ENGINE_DIR=... npm run verify:engine
 */

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function fail(message) {
  console.error(`verify-engine-contract: ${message}`);
  process.exitCode = 1;
}

const engineDir = resolve(
  argument("--engine") ?? process.env.CODERAX_ENGINE_DIR ?? "",
);
if (!engineDir) {
  console.error("verify-engine-contract: pass --engine <path> or CODERAX_ENGINE_DIR");
  process.exit(2);
}

const localDocument = await readFile(
  new URL("../contracts/workflow-engine-1.2.0.openapi.json", import.meta.url),
);
const localDigest = sha256(localDocument);
if (localDigest !== CONTRACT_SOURCE.openapiSha256) {
  fail(`the vendored OpenAPI document is ${localDigest}, expected ${CONTRACT_SOURCE.openapiSha256}`);
}
const localOpenApi = JSON.parse(localDocument.toString("utf8"));
if (localOpenApi.info?.version !== CONTRACT_VERSION) {
  fail(`the vendored OpenAPI reports ${localOpenApi.info?.version}, expected ${CONTRACT_VERSION}`);
}
if (contractFingerprint() !== CONTRACT_FINGERPRINT) {
  fail(`the route table fingerprints as ${contractFingerprint()}, expected ${CONTRACT_FINGERPRINT}`);
}

const engineDocumentPath = join(engineDir, "openapi.json");
const engineDocument = await readFile(engineDocumentPath);
const engineDigest = sha256(engineDocument);
if (engineDigest !== CONTRACT_SOURCE.openapiSha256) {
  fail(`the engine checkout's openapi.json is ${engineDigest}, expected ${CONTRACT_SOURCE.openapiSha256}`);
}
const engineOpenApi = JSON.parse(engineDocument.toString("utf8"));
if (engineOpenApi.info?.version !== CONTRACT_VERSION) {
  fail(`the engine checkout publishes contract ${engineOpenApi.info?.version}, expected ${CONTRACT_VERSION}`);
}

const engineFingerprintPath = join(engineDir, "packages/contracts/dist/index.js");
const engineContracts = await import(pathToFileURL(engineFingerprintPath).href);
if (engineContracts.CONTRACT_VERSION !== CONTRACT_VERSION) {
  fail(`@coderax/contracts reports ${engineContracts.CONTRACT_VERSION}, expected ${CONTRACT_VERSION}`);
}
if (engineContracts.CONTRACT_FINGERPRINT !== CONTRACT_FINGERPRINT) {
  fail(
    `@coderax/contracts fingerprints as ${engineContracts.CONTRACT_FINGERPRINT}, expected ${CONTRACT_FINGERPRINT}`,
  );
}
if (engineContracts.ROUTES.length !== ROUTES.length) {
  fail(`@coderax/contracts publishes ${engineContracts.ROUTES.length} operations, expected ${ROUTES.length}`);
}

const artifactPath = join(engineDir, "packages/sdk/sdk-artifact.json");
const artifact = JSON.parse(await readFile(artifactPath, "utf8"));
if (artifact.name !== CONTRACT_SOURCE.sdkPackage || artifact.version !== CONTRACT_SOURCE.sdkVersion) {
  fail(`the engine SDK artifact is ${artifact.name}@${artifact.version}, expected ${CONTRACT_SOURCE.sdkPackage}@${CONTRACT_SOURCE.sdkVersion}`);
}
if (artifact.contractVersion !== CONTRACT_VERSION) {
  fail(`the engine SDK artifact targets ${artifact.contractVersion}, expected ${CONTRACT_VERSION}`);
}
if (artifact.sha256 !== CONTRACT_SOURCE.sdkArtifactSha256) {
  fail(`the engine SDK artifact digest is ${artifact.sha256}, expected ${CONTRACT_SOURCE.sdkArtifactSha256}`);
}
if (artifact.bytes !== CONTRACT_SOURCE.sdkArtifactBytes) {
  fail(`the engine SDK artifact is ${artifact.bytes} bytes, expected ${CONTRACT_SOURCE.sdkArtifactBytes}`);
}
const artifactFile = await readFile(join(engineDir, "packages/sdk", artifact.path));
if (sha256(artifactFile) !== artifact.sha256) {
  fail("the SDK tarball on disk does not match its own manifest digest");
}
const artifactInfo = await stat(join(engineDir, "packages/sdk", artifact.path));

const report = {
  ok: process.exitCode !== 1,
  contractVersion: CONTRACT_VERSION,
  fingerprint: CONTRACT_FINGERPRINT,
  operations: ROUTES.length,
  openapiSha256: engineDigest,
  sdk: {
    name: artifact.name,
    version: artifact.version,
    sha256: artifact.sha256,
    bytes: artifactInfo.size,
  },
  source: CONTRACT_SOURCE,
};
console.log(JSON.stringify(report, null, 2));
