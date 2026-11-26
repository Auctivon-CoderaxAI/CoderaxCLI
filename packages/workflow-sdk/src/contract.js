/**
 * Coderax client contract, version 1.
 *
 * The shapes below were read from Auctivon-CoderaxAI/Coderax at main
 * (a5d237b0): `api/server/routes/work.js`, `workApi.js`, `workChat.js`,
 * `routes/workflows.js`, `packages/api/src/work/router.ts`,
 * `packages/api/src/workflows/{handlers,definition}.ts`, and
 * `packages/data-provider/src/workflows.ts`.
 *
 * Two deliberate gaps are part of the contract, not hidden by it:
 *
 * 1. The deployment publishes no `/api/meta` or API-version endpoint. The CLI
 *    therefore sends `x-coderax-api-version: 1` and accepts a server response
 *    header when a deployment adds one; otherwise the version is UNVERIFIED.
 * 2. `/api/workflows/runs/:id/stream` emits `data: {"run": ...}` snapshots with
 *    no `id:` field and ignores `Last-Event-ID`. Clients can resume safely
 *    because a snapshot is idempotent, but cannot replay individual events.
 *
 * Do not "improve" either gap by guessing: `negotiate()` records a diagnostic
 * and `--strict` fails closed.
 */

export const API_VERSION = "1";
export const API_MAJOR = 1;
export const CLIENT_NAME = "coderax-cli";

export const CAPABILITY = Object.freeze({
  chat: "work.chat",
  workModels: "work.models",
  workAgents: "work.agents",
  workTasks: "work.tasks",
  workCancel: "work.cancel",
  workflows: "workflows.list",
  builds: "workflows.builds",
  runs: "workflows.runs",
  runStream: "workflows.stream",
  approve: "workflows.approve",
  pause: "workflows.pause",
  resume: "workflows.resume",
  cancel: "workflows.cancel",
  repos: "repos.list",
});

/** Endpoints published by the deployment. No path is invented outside this map. */
export const ROUTE = Object.freeze({
  meta: ["/api/meta", "/.well-known/coderax.json", "/api/version"],
  user: "/api/user",
  chat: "/api/work/chat",
  workModels: "/api/work/models",
  workAgents: "/api/work/agents",
  workReadiness: "/api/work/readiness",
  workTasks: "/api/work/tasks",
  workTask: (id) => `/api/work/tasks/${encodeURIComponent(id)}`,
  workCancel: (id) => `/api/work/tasks/${encodeURIComponent(id)}/cancel`,
  workflows: "/api/workflows",
  templates: "/api/workflows/templates",
  builds: "/api/workflows/builds",
  workflowRuns: (id) => `/api/workflows/${encodeURIComponent(id)}/runs`,
  run: (id) => `/api/workflows/runs/${encodeURIComponent(id)}`,
  runStream: (id) => `/api/workflows/runs/${encodeURIComponent(id)}/stream`,
  runExport: (id) => `/api/workflows/runs/${encodeURIComponent(id)}/export`,
  approve: (id) => `/api/workflows/runs/${encodeURIComponent(id)}/approve`,
  pause: (id) => `/api/workflows/runs/${encodeURIComponent(id)}/pause`,
  resume: (id) => `/api/workflows/runs/${encodeURIComponent(id)}/resume`,
  cancel: (id) => `/api/workflows/runs/${encodeURIComponent(id)}/cancel`,
  repos: "/api/repos",
});

/** `WORKFLOW_RUN_STATUSES` in packages/data-provider/src/workflows.ts. */
export const RUN_STATUSES = Object.freeze([
  "queued",
  "running",
  "paused",
  "waiting_approval",
  "completed",
  "failed",
  "cancelled",
]);

export const TERMINAL_RUN_STATUSES = Object.freeze(["completed", "failed", "cancelled"]);

/** `WORKFLOW_BUILD_MODES` in packages/data-provider/src/workflows.ts. */
export const BUILD_MODES = Object.freeze(["turbo15", "autonomous", "verified"]);

export const WORK_STATES = Object.freeze([
  "queued",
  "running",
  "paused",
  "unknown",
  "completed",
  "failed",
  "cancelled",
]);

/** Owner gate used by the backend: `SystemRoles.ADMIN`. */
export const OWNER_ROLE = "ADMIN";

export function isTerminalStatus(status) {
  return TERMINAL_RUN_STATUSES.includes(status);
}

/**
 * Capability inference from safe GET probes when the deployment publishes no
 * metadata. Each probe is a read that the real routes implement; absence means
 * the capability is absent, not that the client should try a write anyway.
 */
export const PROBES = Object.freeze([
  { capability: CAPABILITY.workTasks, path: ROUTE.workTasks },
  { capability: CAPABILITY.workflows, path: ROUTE.workflows },
]);
