#!/usr/bin/env node
/**
 * Read-only cross-surface visibility check.
 *
 * Verifies that a Work task or workflow run created elsewhere (for example in
 * the web application) is visible to the CLI through the shared owner-scoped
 * API. It never creates a task or run, never starts a generation, and never
 * spends credits.
 *
 * Required:
 *   CODERAX_VERIFY_BASE_URL   HTTPS deployment URL (HTTP only on loopback)
 *   CODERAX_VERIFY_TOKEN      owner token (role ADMIN)
 *   CODERAX_VERIFY_TASK_ID    a Work task/conversation id, or
 *   CODERAX_VERIFY_RUN_ID     a workflow run id
 *
 * Exit codes: 0 visible, 4 network, 6 missing/unavailable, 7 not visible.
 */
import { WorkflowClient, SdkError } from "../packages/workflow-sdk/src/index.js";

const baseUrl = process.env.CODERAX_VERIFY_BASE_URL?.trim();
const token = process.env.CODERAX_VERIFY_TOKEN?.trim();
const taskId = process.env.CODERAX_VERIFY_TASK_ID?.trim();
const runId = process.env.CODERAX_VERIFY_RUN_ID?.trim();

function fail(code, message) {
  process.stderr.write(`cross-surface: ${message}\n`);
  process.exit(code);
}

if (!baseUrl || !token) {
  fail(
    6,
    "not configured: set CODERAX_VERIFY_BASE_URL and CODERAX_VERIFY_TOKEN (owner ADMIN). " +
      "This check never runs without an authorized deployment.",
  );
}
if (!taskId && !runId) {
  fail(
    6,
    "no shared id: set CODERAX_VERIFY_TASK_ID (a Work task seen in the web app) " +
      "or CODERAX_VERIFY_RUN_ID. Nothing is created or spent by this check.",
  );
}

const client = new WorkflowClient({
  baseUrl,
  token,
  clientVersion: "verify-cross-surface",
  onDiagnostic: (entry) => {
    process.stderr.write(`cross-surface: ${entry.code}: ${entry.message}\n`);
  },
});

try {
  const identity = await client.requireOwner();
  process.stdout.write(
    `owner verified${identity.account ? `: ${identity.account}` : ""}\n`,
  );

  if (taskId) {
    // The list is the same owner-scoped projection the web application reads.
    const { tasks } = await client.listTasks();
    const found = tasks.find((task) => String(task.id ?? task.conversationId) === taskId);
    if (!found) {
      fail(7, `Work task ${taskId} is not visible in /api/work/tasks; cross-surface visibility is broken`);
    }
    process.stdout.write(
      `task ${taskId} visible: state=${found.state ?? found.status ?? "unknown"}\n`,
    );
  }

  if (runId) {
    const run = await client.getRun(runId);
    if (String(run.id) !== runId) {
      fail(7, `run ${runId} resolved to a different id`);
    }
    process.stdout.write(`run ${runId} visible: status=${run.status}\n`);
  }

  process.stdout.write(
    "read-only check complete; no task, run or generation was created. " +
      "For the reverse direction, open the web app and confirm the same id is rendered.\n",
  );
} catch (error) {
  if (error instanceof SdkError) {
    const code = error.code === "UNAUTHENTICATED" || error.code === "FORBIDDEN" ? 3 : 4;
    fail(code, `${error.code}: ${error.message}`);
  }
  fail(4, error instanceof Error ? error.message : String(error));
}
