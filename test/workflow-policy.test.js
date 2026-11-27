import assert from "node:assert/strict";
import test from "node:test";
import { validateWorkflow } from "../scripts/lib/workflow-policy.mjs";

const workflow = (top, job) => `permissions:${top}
jobs:
  verify:
${job}
`;
const check = (top, job) => validateWorkflow("ci.yml", workflow(top, job));
const linux = "    runs-on: ubuntu-latest";
const matrix = (values) => `    runs-on: ${"${{ matrix.os }}"}
    strategy:
      matrix:
        os:${values}`;

test("workflow and job token overrides cannot grant writes", () => {
  const read = "\n  contents: read";
  assert.deepEqual(check(read, `${linux}\n    permissions: {}\n`), []);
  assert.deepEqual(check(" read-all", `${linux}\n    permissions:\n      checks: read`), []);
  assert.match(check(read + "\n  issues: write", linux)[0], /issues: write/);
  assert.match(check(read, `${linux}\n    permissions:\n      contents: read\n      issues: write`)[0], /issues: write/);
  assert.match(check(" write-all", linux)[0], /block mapping/);
  assert.match(check(read, `${linux}\n    permissions: {issues: write}`)[0], /block mapping/);
});

test("matrix runners check all list entries and reject unsupported expansions", () => {
  const read = "\n  contents: read";
  assert.deepEqual(check(read, matrix(" [ubuntu-latest, 'windows-latest']")), []);
  assert.deepEqual(check(read, matrix("\n          - ubuntu-latest\n          - macos-latest")), []);
  assert.match(check(read, matrix("\n          - ubuntu-latest\n          - unapproved"))[0], /unapproved/);
  assert.match(check(read, matrix(" [ubuntu-latest]\n        include:\n          - os: unapproved"))[0], /unsupported runner matrix/);
  assert.match(check(read, matrix(" ${{ inputs.runner }}"))[0], /unsupported os/);
});
