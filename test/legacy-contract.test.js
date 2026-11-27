import test from "node:test";
import assert from "node:assert/strict";
import { startHarness, openapiDocument } from "./harness/workflow-engine.mjs";
import { evaluateContract, loadContractInputs } from "../scripts/lib/contract.mjs";

const ROOT = process.cwd();
const inputs = await loadContractInputs(ROOT);

function evaluate(overrides = {}) {
  return evaluateContract({ ...inputs, ...overrides });
}

function codes(result) {
  return result.violations.map((violation) => violation.code);
}

test("[capability:api-version-compatibility] the checked-in contract passes against a compatible engine", async () => {
  const harness = await startHarness();
  try {
    const response = await fetch(`${harness.baseUrl}/openapi.json`);
    const document = await response.json();
    const result = evaluate({ document });
    assert.deepEqual(result.violations, [], JSON.stringify(result.violations, null, 2));
    assert.equal(result.checked.supported + result.checked.unsupported, inputs.contract.capabilities.length);
  } finally {
    await harness.close();
  }
});

test("a stale deployment API version cannot pass", () => {
  const result = evaluate({ document: openapiDocument("0.9.0") });
  assert.ok(codes(result).includes("API_VERSION_STALE"), JSON.stringify(result.violations));
});

test("an unsupported API major cannot pass", () => {
  const result = evaluate({ document: openapiDocument("2.0.0") });
  assert.ok(codes(result).includes("API_VERSION_UNSUPPORTED"), JSON.stringify(result.violations));
});

test("a document without an API version cannot pass", () => {
  const document = openapiDocument();
  delete document.info.version;
  const result = evaluate({ document });
  assert.ok(codes(result).includes("API_VERSION_MISSING"));
});

test("a missing required operation cannot pass", () => {
  const document = openapiDocument();
  delete document.paths["/api/work/chat"];
  const result = evaluate({ document });
  assert.ok(codes(result).includes("OPERATION_UNSUPPORTED"));
});

test("a non-OpenAPI document cannot pass", () => {
  const result = evaluate({ document: { openapi: "2.0", info: { version: "1.0.0" }, paths: {} } });
  assert.ok(codes(result).includes("API_DOCUMENT_UNSUPPORTED"));
});

test("a stale shared client version cannot pass", () => {
  const contract = structuredClone(inputs.contract);
  contract.sharedClient.version = "0.0.1";
  const result = evaluate({ contract, document: openapiDocument() });
  assert.ok(codes(result).includes("SDK_VERSION_STALE"));
});

test("a stale documented version cannot pass", () => {
  const result = evaluate({
    document: openapiDocument(),
    docsText: inputs.docsText.replace(/Version: CLI `[^`]+`/, "Version: CLI `0.0.0`"),
  });
  assert.ok(codes(result).includes("DOC_VERSION_STALE"));
});

test("a supported capability without a marked test cannot pass", () => {
  const testSources = new Map(inputs.testSources);
  testSources.set("test/integration/cli-http.test.js", "test('no marker here', () => {});");
  const result = evaluate({ document: openapiDocument(), testSources });
  assert.ok(codes(result).includes("CAPABILITY_UNVERIFIED"));
});

test("a supported capability citing a missing file cannot pass", () => {
  const contract = structuredClone(inputs.contract);
  contract.capabilities.find((entry) => entry.status === "supported").verifiedBy = ["test/ghost.test.js"];
  const result = evaluate({ contract, document: openapiDocument() });
  assert.ok(codes(result).includes("CAPABILITY_UNVERIFIED"));
});

test("an unsupported capability cannot claim verification", () => {
  const contract = structuredClone(inputs.contract);
  const unsupported = contract.capabilities.find((entry) => entry.status === "unsupported");
  unsupported.verifiedBy = ["test/contract.test.js"];
  const result = evaluate({ contract, document: openapiDocument() });
  assert.ok(codes(result).includes("CAPABILITY_CLAIM_MISMATCH"));
});

test("an operation cannot be both required and unsupported", () => {
  const contract = structuredClone(inputs.contract);
  contract.unsupportedOperations.push(contract.requiredOperations[0]);
  const result = evaluate({ contract, document: openapiDocument() });
  assert.ok(codes(result).includes("CONTRACT_INVALID"));
});

test("the contract refuses to pass without a document at all", () => {
  const result = evaluate({ document: null });
  assert.ok(codes(result).includes("DOCUMENT_MISSING"));
});
