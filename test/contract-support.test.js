import test from "node:test";
import assert from "node:assert/strict";
import { CONTRACT_VERSION } from "../src/engine/contract.js";
import { contractSupport } from "../src/engine/contract-support.js";

test("the merged 1.0.0 contract remains supported", () => {
  const support = contractSupport(CONTRACT_VERSION);
  assert.equal(support.supported, true);
  assert.equal(support.status, "supported");
});

test("engine PR 7's 1.1.0 catalogue is not treated as final", () => {
  const support = contractSupport("1.1.0");
  assert.equal(support.supported, false);
  assert.equal(support.status, "adapter-pending");
  assert.match(support.note, /not the final/);
});

test("the unpublished unified 1.2.0 contract is adapter-pending", () => {
  const support = contractSupport("1.2.0");
  assert.equal(support.supported, false);
  assert.equal(support.status, "adapter-pending");
  assert.match(support.note, /not published/);
});

test("an unknown contract is unsupported", () => {
  const support = contractSupport("9.9.9");
  assert.equal(support.supported, false);
  assert.equal(support.status, "unsupported");
});
