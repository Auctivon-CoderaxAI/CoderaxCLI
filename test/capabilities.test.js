import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startWorkflowHarness } from "./support/workflow-harness.js";
import { cliWorkspace, json, runCapabilityCli, workSubmissions } from "./support/cli-harness.js";

const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<<>>\n%%EOF\n", "utf8");

async function harness(t, options) {
  const instance = await startWorkflowHarness(options);
  t.after(() => instance.close());
  return instance;
}

function family(document, command) {
  return document.families.find((entry) => entry.command === command);
}

test("capabilities resolves every family from the authoritative handshake", async (t) => {
  const server = await harness(t);
  const cwd = await cliWorkspace();
  const result = await runCapabilityCli(["capabilities", "--json"], { harness: server, cwd });

  assert.equal(result.code, 0, result.stderr);
  const document = json(result.stdout);
  assert.equal(document.contract.contractVersion, "1.1.0");
  assert.equal(document.contract.compatible, true);
  assert.equal(document.contract.engineName, "coderax-workflow-engine");
  assert.equal(document.contract.chatStreamVersion, 1);
  assert.equal(document.operations.length, 30);
  assert.deepEqual(document.coverageGaps, []);

  assert.equal(family(document, "create-document").status, "available");
  assert.equal(family(document, "create-presentation").status, "available");
  // Contract 1.1.0 publishes no multimodal or multi-agent capability flag, so
  // the deployment makes no claim the CLI may upgrade.
  assert.equal(family(document, "analyze-document").status, "unverified");
  assert.equal(family(document, "analyze-document").blockedBy, "multimodal");
  assert.equal(family(document, "orchestrate").status, "unverified");
  assert.equal(family(document, "orchestrate").blockedBy, "multiAgent");
  assert.equal(family(document, "create-game").status, "not_implemented");
});

test("an unverified family is never executed and exits 6", async (t) => {
  const server = await harness(t);
  const cwd = await cliWorkspace();
  await writeFile(join(cwd, "report.pdf"), PDF);

  const result = await runCapabilityCli(["analyze-document", "report.pdf"], { harness: server, cwd });
  assert.equal(result.code, 6);
  assert.match(result.stderr, /CAPABILITY_NOT_AVAILABLE/);
  assert.match(result.stderr, /multimodal/);
  assert.equal(workSubmissions(server).length, 0, "no task may be submitted for an unverified capability");
});

test("unsupported artifact storage blocks creation", async (t) => {
  const server = await harness(t, { capabilities: { artifacts: false } });
  const cwd = await cliWorkspace();

  const listed = await runCapabilityCli(["capabilities", "--json"], { harness: server, cwd });
  const entry = family(json(listed.stdout), "create-document");
  assert.equal(entry.status, "blocked");
  assert.equal(entry.blockedBy, "artifacts");

  const result = await runCapabilityCli(["create-document", "a short note"], { harness: server, cwd });
  assert.equal(result.code, 6);
  assert.equal(workSubmissions(server).length, 0);
});

test("a disabled capability is reported as unavailable, not executed", async (t) => {
  const server = await harness(t, { capabilities: { work: false } });
  const cwd = await cliWorkspace();
  const listed = await runCapabilityCli(["capabilities", "--json"], { harness: server, cwd });
  assert.equal(family(json(listed.stdout), "create-document").status, "unavailable");

  const result = await runCapabilityCli(["create-document", "a short note"], { harness: server, cwd });
  assert.equal(result.code, 6);
  assert.equal(workSubmissions(server).length, 0);
});

test("a missing required operation is unverified", async (t) => {
  const server = await harness(t, { omitOperations: ["submitWork"] });
  const cwd = await cliWorkspace();
  const listed = await runCapabilityCli(["capabilities", "--json"], { harness: server, cwd });
  const entry = family(json(listed.stdout), "create-document");
  assert.equal(entry.status, "unverified");
  assert.match(entry.detail, /submitWork/);
});

test("an incompatible contract is refused before any request", async (t) => {
  const server = await harness(t, { incompatible: true });
  const cwd = await cliWorkspace();
  const result = await runCapabilityCli(["create-document", "a short note"], { harness: server, cwd });
  assert.equal(result.code, 7);
  assert.match(result.stderr, /CONTRACT_INCOMPATIBLE/);
  assert.equal(workSubmissions(server).length, 0);
});

test("game families are not_implemented until the engine publishes the operations", async (t) => {
  const server = await harness(t);
  const cwd = await cliWorkspace();
  const listed = await runCapabilityCli(["capabilities", "--json"], { harness: server, cwd });
  const entry = family(json(listed.stdout), "create-game");
  assert.equal(entry.status, "not_implemented");
  assert.match(entry.detail, /\/v1\/games/);
});

test("a published game operation the SDK cannot call is unverified", async (t) => {
  const server = await harness(t, { games: true });
  const cwd = await cliWorkspace();
  const listed = await runCapabilityCli(["capabilities", "--json"], { harness: server, cwd });
  const entry = family(json(listed.stdout), "create-game");
  assert.equal(entry.status, "unverified");
  assert.match(entry.detail, /no method/);

  const result = await runCapabilityCli(["create-game", "a small puzzle game", "--json"], { harness: server, cwd });
  assert.equal(result.code, 6);
  assert.equal(workSubmissions(server).length, 0);
});

test("unknown options and a bare --force are usage errors", async (t) => {
  const server = await harness(t);
  const cwd = await cliWorkspace();

  const unknown = await runCapabilityCli(["create-document", "a note", "--nonsense", "1"], { harness: server, cwd });
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /unknown option/);

  const force = await runCapabilityCli(["create-document", "a note", "--force"], { harness: server, cwd });
  assert.equal(force.code, 2);
  assert.match(force.stderr, /--force/);
  assert.equal(workSubmissions(server).length, 0);
});

test("create-document runs one Work task and downloads a verified artifact", async (t) => {
  const server = await harness(t);
  const cwd = await cliWorkspace();
  const out = join(cwd, "note.md");

  const result = await runCapabilityCli(["create-document", "a note about contracts", "--out", out, "--json"], {
    harness: server,
    cwd,
  });
  assert.equal(result.code, 0, result.stderr);
  const document = json(result.stdout);
  assert.equal(document.task.state, "completed");
  assert.equal(document.artifacts.length, 1);
  assert.equal(document.downloaded.path, out);
  assert.equal(workSubmissions(server).length, 1);

  const content = await import("node:fs/promises").then((fs) => fs.readFile(out));
  assert.equal(createHash("sha256").update(content).digest("hex"), document.artifacts[0].digest.slice(7));
  assert.match(content.toString("utf8"), /a note about contracts/);
});

test("a file-bearing request uploads to the accepted task and verifies the digest", async (t) => {
  const server = await harness(t, { beginDelayMs: 150 });
  const cwd = await cliWorkspace();
  const file = join(cwd, "report.pdf");
  await writeFile(file, PDF);

  const result = await runCapabilityCli(
    ["create-presentation", "a deck about the report", "--file", "report.pdf", "--json"],
    { harness: server, cwd },
  );
  assert.equal(result.code, 0, result.stderr);
  const document = json(result.stdout);
  assert.equal(document.attachment.path, "report.pdf");
  assert.equal(document.attachment.digest, `sha256:${createHash("sha256").update(PDF).digest("hex")}`);
  assert.equal(document.attachment.bytes, PDF.length);
  assert.equal(document.task.state, "completed");

  const posts = server.state.requests.filter((request) => request.method === "POST");
  const work = posts.findIndex((request) => request.path === "/v1/work");
  const upload = posts.findIndex((request) => request.path.endsWith("/artifacts"));
  assert.ok(work !== -1 && upload !== -1, "both submit and upload must happen");
  assert.ok(work < upload, "the attachment is stored on the task the engine accepted");
});

test("a tampered upload cancels the task instead of leaving it running", async (t) => {
  const server = await harness(t, { beginDelayMs: 300, tamperUpload: true });
  const cwd = await cliWorkspace();
  await writeFile(join(cwd, "report.pdf"), PDF);

  const result = await runCapabilityCli(
    ["create-presentation", "a deck", "--file", "report.pdf"],
    { harness: server, cwd },
  );
  assert.equal(result.code, 1);
  assert.match(result.stderr, /cancelled/);
  const task = [...server.state.tasks.values()][0];
  assert.equal(task.status.state, "cancelled");
});

test("--no-wait returns the accepted task", async (t) => {
  const server = await harness(t, { beginDelayMs: 1000 });
  const cwd = await cliWorkspace();
  const result = await runCapabilityCli(["create-document", "a note", "--no-wait", "--json"], {
    harness: server,
    cwd,
  });
  assert.equal(result.code, 0, result.stderr);
  const document = json(result.stdout);
  assert.equal(document.waited, false);
  assert.match(document.accepted.taskId, /^task-/);
  assert.notEqual(server.state.tasks.get(document.accepted.taskId)?.status.state, "completed");
});

test("a failed task exits 1 with the engine failure", async (t) => {
  const server = await harness(t, { behaviors: { default: "failed" } });
  const cwd = await cliWorkspace();
  const result = await runCapabilityCli(["create-document", "a note", "--json"], { harness: server, cwd });
  assert.equal(result.code, 1);
  const document = json(result.stdout);
  assert.equal(document.task.state, "failed");
  assert.equal(document.task.failure.code, "provider_error");
});

test("the local wait deadline is reported as a timeout, not a cancellation", async (t) => {
  const server = await harness(t, { behaviors: { default: "hang" } });
  const cwd = await cliWorkspace();
  const result = await runCapabilityCli(
    ["create-document", "a note", "--wait-timeout", "1200", "--json"],
    { harness: server, cwd },
  );
  assert.equal(result.code, 4);
  const document = json(result.stdout);
  assert.equal(document.timeout, true);
  assert.equal([...server.state.tasks.values()][0].status.state, "running");
  assert.equal([...server.state.tasks.values()][0].status.cancelRequested, false);
});

test("an unauthorized token is refused by the engine", async (t) => {
  const server = await harness(t);
  const cwd = await cliWorkspace();
  const result = await runCapabilityCli(["create-document", "a note"], {
    harness: server,
    cwd,
    token: "not-the-owner-token",
  });
  assert.equal(result.code, 3);
  assert.match(result.stderr, /UNAUTHENTICATED/);
});
