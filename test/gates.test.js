import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { API_MAJOR, API_VERSION, ROUTE } from "../packages/workflow-sdk/src/index.js";
import { contractViolations, isolationViolations } from "../scripts/lib/gates.mjs";

const ROOT = process.cwd();
const packageJson = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
const docs = {
  contract: await readFile(join(ROOT, "docs/CONTRACT.md"), "utf8"),
  compatibility: await readFile(join(ROOT, "docs/COMPATIBILITY.md"), "utf8"),
};

function contract(overrides = {}) {
  return contractViolations({
    packageJson,
    apiVersion: API_VERSION,
    apiMajor: API_MAJOR,
    route: ROUTE,
    sources: [],
    docs,
    ...overrides,
  });
}

function codes(violations) {
  return violations.map((violation) => violation.code);
}

test("[capability:sdk-drift] the checked-in contract passes as committed", () => {
  assert.deepEqual(contract(), []);
});

test("[capability:sdk-drift] a stale documented version fails the build", () => {
  const violations = contract({
    docs: {
      ...docs,
      contract: docs.contract.replace(/Version: CLI `[^`]+`/, "Version: CLI `0.0.1`"),
    },
  });
  assert.ok(codes(violations).includes("DOC_VERSION_STALE"), JSON.stringify(violations));
});

test("[capability:sdk-drift] an API major that disagrees with the SDK fails the build", () => {
  const violations = contract({ apiMajor: API_MAJOR + 1 });
  assert.ok(codes(violations).includes("SDK_VERSION_STALE"), JSON.stringify(violations));
});

test("[capability:sdk-drift] an unpinned compatibility document fails the build", () => {
  const violations = contract({ docs: { ...docs, compatibility: "# Compatibility\n" } });
  assert.ok(codes(violations).includes("DOC_VERSION_STALE"));
});

test("[capability:unsupported-operations] a call to an unpublished route fails the build", () => {
  const violations = contract({
    sources: [
      {
        path: "src/example.js",
        text: 'const path = "/api/internal/agent/exec";\n',
      },
    ],
  });
  assert.ok(codes(violations).includes("UNSUPPORTED_OPERATION"), JSON.stringify(violations));
  assert.match(violations[0].message, /api\/internal\/agent\/exec/);
});

test("[capability:unsupported-operations] published routes, probes and prefixes are accepted", () => {
  const violations = contract({
    sources: [
      { path: "src/ok.js", text: 'a("/api/user"); b("/api/work/tasks/:id/cancel"); c("/api/health"); d("/api/workflows/runs/:id/stream");' },
      { path: "src/prefix.js", text: 'const head = "/api/workflows/";' },
    ],
  });
  assert.deepEqual(violations, [], JSON.stringify(violations));
});

test("[capability:dependency-security] the repository has no runtime dependency or install script", async () => {
  const lockfile = JSON.parse(await readFile(join(ROOT, "package-lock.json"), "utf8"));
  const violations = isolationViolations({
    packageJson,
    lockfile,
    sources: [{ path: "src/cli.js", text: 'import { join } from "node:path";\n' }],
  });
  assert.deepEqual(violations, [], JSON.stringify(violations));
});

test("[capability:workload-isolation] a runtime dependency or install script fails the build", () => {
  const violations = isolationViolations({
    packageJson: {
      ...packageJson,
      dependencies: { ollama: "^0.5.0" },
      scripts: { ...packageJson.scripts, postinstall: "node setup.mjs" },
    },
    lockfile: null,
    sources: [],
  });
  assert.deepEqual(codes(violations).sort(), ["INSTALL_SCRIPT", "RUNTIME_DEPENDENCY"]);
});

test("[capability:workload-isolation] a local server, database or spawn fails the build", () => {
  const violations = isolationViolations({
    packageJson,
    lockfile: null,
    sources: [
      { path: "src/server.js", text: 'import { createServer } from "node:http";\nconst s = createServer();\ns.listen(8080);\n' },
      { path: "src/db.js", text: 'import Database from "better-sqlite3";\n' },
      { path: "src/agent.js", text: 'const r = spawn("ollama", ["run", "llama3"]);\n' },
    ],
  });
  const found = codes(violations);
  assert.ok(found.includes("LOCAL_EXECUTION_SURFACE"));
  assert.ok(violations.some((violation) => /better-sqlite3|node:http|ollama/.test(violation.message)));
});

test("[capability:workload-isolation] only the reviewed files may start a process", () => {
  const violations = isolationViolations({
    packageJson,
    lockfile: null,
    sources: [{ path: "src/daemon.js", text: 'import { spawn } from "node:child_process";\nspawn("node", ["agent.js"]);\n' }],
  });
  assert.ok(
    violations.some((violation) => violation.code === "LOCAL_EXECUTION_SURFACE" && /starts a process/.test(violation.message)),
  );
  const reviewed = isolationViolations({
    packageJson,
    lockfile: null,
    sources: [{ path: "src/credentials.js", text: 'import { spawn } from "node:child_process";\nspawn("security", ["find-generic-password"]);\n' }],
  });
  assert.equal(reviewed.some((violation) => /starts a process/.test(violation.message)), false);
});
