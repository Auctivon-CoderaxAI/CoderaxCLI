import { CoderaxError } from "./client.js";

/**
 * Canonical command catalog.
 *
 * Each entry declares an *intent* (what the command means) and the contract
 * shapes the deployment may publish for it. Nothing here is a hardcoded
 * endpoint: the concrete method, path template, parameters, request body and
 * enums are taken from the deployment's own OpenAPI document at runtime. When
 * the document publishes no matching operation, the command reports
 * OPERATION_NOT_FOUND and sends nothing.
 *
 * `contract` is documentation for humans and error messages, not a request
 * target. It is the shape a WorkflowEngine-compatible deployment is expected to
 * publish (see docs/CONTRACT.md).
 */

const LIST_OPTIONS = Object.freeze(["limit", "cursor", "query", "status"]);

const SCHEDULE_BODY = Object.freeze({
  name: "string",
  cron: "string",
  prompt: "string",
  timezone: "string",
  enabled: "boolean",
  model: "string",
  agent: "string",
});

function define(spec) {
  return Object.freeze({
    aliases: [],
    topAliases: [],
    options: [],
    query: [],
    pathArgs: [],
    requiredBody: [],
    confirm: false,
    list: false,
    mode: "http",
    method: "GET",
    examples: [],
    ...spec,
  });
}

export const COMMAND_SPECS = Object.freeze([
  // ---------------------------------------------------------------- conversations
  define({
    id: "conversations.list",
    path: ["conversations", "list"],
    capability: "conversations",
    summary: "List conversations",
    description: "Lists the conversations stored by the deployment, newest first where the server supports it.",
    method: "GET",
    contract: "GET /conversations",
    operationIds: ["listConversations", "getConversations", "conversations.list"],
    paths: [/\/conversations\/?$/i],
    options: LIST_OPTIONS,
    query: LIST_OPTIONS,
    list: true,
    examples: ["coderax conversations", "coderax conversations list --limit 20 --json"],
  }),
  define({
    id: "conversations.show",
    path: ["conversations", "show"],
    capability: "conversations",
    summary: "Show one conversation",
    method: "GET",
    contract: "GET /conversations/{conversationId}",
    operationIds: ["getConversation", "showConversation", "conversations.get"],
    paths: [/\/conversations\/\{[^/{}]+\}\/?$/i],
    pathArgs: ["id"],
    examples: ["coderax conversations show conv-1 --json"],
  }),

  // ---------------------------------------------------------------------- tasks
  define({
    id: "tasks.list",
    path: ["tasks", "list"],
    capability: "tasks",
    summary: "List Work tasks",
    description: "Lists Work tasks the authenticated account can see. This is the same task stream Coderax Web renders.",
    method: "GET",
    contract: "GET /tasks",
    operationIds: ["listTasks", "getTasks", "listWorkTasks", "work.tasks.list"],
    paths: [/\/tasks\/?$/i],
    options: LIST_OPTIONS,
    query: LIST_OPTIONS,
    list: true,
    examples: ["coderax tasks", "coderax tasks list --status running --json"],
  }),
  define({
    id: "tasks.show",
    path: ["tasks", "show"],
    capability: "tasks",
    summary: "Show one Work task",
    method: "GET",
    contract: "GET /tasks/{taskId}",
    operationIds: ["getTask", "showTask", "getWorkTask"],
    paths: [/\/tasks\/\{[^/{}]+\}\/?$/i],
    pathArgs: ["id"],
    examples: ["coderax tasks show task-1 --json"],
  }),
  define({
    id: "tasks.cancel",
    path: ["tasks", "cancel"],
    capability: "tasks",
    summary: "Cancel a running Work task",
    method: "POST",
    contract: "POST /tasks/{taskId}/cancel",
    operationIds: ["cancelTask", "cancelWorkTask", "tasks.cancel"],
    paths: [/\/tasks\/\{[^/{}]+\}\/cancel\/?$/i],
    pathArgs: ["id"],
    confirm: true,
    topAliases: ["cancel"],
    examples: ["coderax cancel task-1 --yes"],
  }),
  define({
    id: "tasks.retry",
    path: ["tasks", "retry"],
    capability: "tasks",
    summary: "Retry a failed Work task",
    method: "POST",
    contract: "POST /tasks/{taskId}/retry",
    operationIds: ["retryTask", "retryWorkTask", "tasks.retry"],
    paths: [/\/tasks\/\{[^/{}]+\}\/retry\/?$/i],
    pathArgs: ["id"],
    topAliases: ["retry"],
    examples: ["coderax retry task-1"],
  }),
  define({
    id: "tasks.resume",
    path: ["tasks", "resume"],
    capability: "tasks",
    summary: "Resume a paused Work task",
    method: "POST",
    contract: "POST /tasks/{taskId}/resume",
    operationIds: ["resumeTask", "resumeWorkTask", "tasks.resume"],
    paths: [/\/tasks\/\{[^/{}]+\}\/resume\/?$/i],
    pathArgs: ["id"],
    topAliases: ["resume"],
    examples: ["coderax resume task-1"],
  }),
  define({
    id: "tasks.detach",
    path: ["tasks", "detach"],
    capability: "tasks",
    summary: "Detach from a Work task without cancelling it",
    method: "POST",
    contract: "POST /tasks/{taskId}/detach",
    operationIds: ["detachTask", "detachWorkTask", "tasks.detach"],
    paths: [/\/tasks\/\{[^/{}]+\}\/detach\/?$/i],
    pathArgs: ["id"],
    topAliases: ["detach"],
    examples: ["coderax detach task-1"],
  }),

  // ---------------------------------------------------------------- permissions
  define({
    id: "permissions.list",
    path: ["permissions", "list"],
    capability: "permissions",
    summary: "List authorizations granted to the account",
    method: "GET",
    contract: "GET /permissions",
    operationIds: ["listPermissions", "getPermissions"],
    paths: [/\/permissions\/?$/i],
    options: LIST_OPTIONS,
    query: LIST_OPTIONS,
    list: true,
    examples: ["coderax permissions --json"],
  }),
  define({
    id: "permissions.show",
    path: ["permissions", "show"],
    capability: "permissions",
    summary: "Show one authorization",
    method: "GET",
    contract: "GET /permissions/{permissionId}",
    operationIds: ["getPermission", "showPermission"],
    paths: [/\/permissions\/\{[^/{}]+\}\/?$/i],
    pathArgs: ["id"],
    examples: ["coderax permissions show perm-1"],
  }),

  // --------------------------------------------------------------------- memory
  define({
    id: "memory.list",
    path: ["memory", "list"],
    capability: "memory",
    summary: "List persistent memory entries",
    method: "GET",
    contract: "GET /memory",
    operationIds: ["listMemory", "listMemories", "getMemories"],
    paths: [/\/memor(?:y|ies)\/?$/i],
    options: LIST_OPTIONS,
    query: LIST_OPTIONS,
    list: true,
    examples: ["coderax memory --json"],
  }),
  define({
    id: "memory.show",
    path: ["memory", "show"],
    capability: "memory",
    summary: "Show one memory entry",
    method: "GET",
    contract: "GET /memory/{memoryId}",
    operationIds: ["getMemory", "showMemory", "getMemoryEntry"],
    paths: [/\/memor(?:y|ies)\/\{[^/{}]+\}\/?$/i],
    pathArgs: ["id"],
    examples: ["coderax memory show mem-1"],
  }),
  define({
    id: "memory.delete",
    path: ["memory", "delete"],
    capability: "memory",
    summary: "Forget one memory entry",
    method: "DELETE",
    contract: "DELETE /memory/{memoryId}",
    operationIds: ["deleteMemory", "forgetMemory"],
    paths: [/\/memor(?:y|ies)\/\{[^/{}]+\}\/?$/i],
    pathArgs: ["id"],
    confirm: true,
    examples: ["coderax memory delete mem-1 --yes"],
  }),

  // ------------------------------------------------------------------ schedules
  define({
    id: "schedules.list",
    path: ["schedules", "list"],
    capability: "schedules",
    summary: "List scheduled tasks",
    method: "GET",
    contract: "GET /schedules",
    operationIds: ["listSchedules", "getSchedules"],
    paths: [/\/schedules\/?$/i],
    options: LIST_OPTIONS,
    query: LIST_OPTIONS,
    list: true,
    examples: ["coderax schedules --json"],
  }),
  define({
    id: "schedules.show",
    path: ["schedules", "show"],
    capability: "schedules",
    summary: "Show one schedule",
    method: "GET",
    contract: "GET /schedules/{scheduleId}",
    operationIds: ["getSchedule", "showSchedule"],
    paths: [/\/schedules\/\{[^/{}]+\}\/?$/i],
    pathArgs: ["id"],
    examples: ["coderax schedules show sched-1"],
  }),
  define({
    id: "schedules.create",
    path: ["schedules", "create"],
    capability: "schedules",
    summary: "Create a scheduled task",
    description: "Creates a schedule. The trigger (`--cron`) and `--prompt` are required; the deployment validates the cron expression.",
    method: "POST",
    contract: "POST /schedules",
    operationIds: ["createSchedule", "schedules.create"],
    paths: [/\/schedules\/?$/i],
    options: Object.keys(SCHEDULE_BODY),
    body: SCHEDULE_BODY,
    requiredBody: ["cron", "prompt"],
    examples: [
      'coderax schedules create --cron "0 9 * * 1-5" --prompt "Review open pull requests" --json',
      'coderax schedules create --data \'{"cron":"0 9 * * *","prompt":"Daily triage"}\'',
    ],
  }),
  define({
    id: "schedules.update",
    path: ["schedules", "update"],
    capability: "schedules",
    summary: "Modify a schedule",
    description: "Partially updates a schedule. Supply at least one field flag or --data.",
    method: ["PATCH", "PUT"],
    contract: "PATCH /schedules/{scheduleId}",
    operationIds: ["updateSchedule", "patchSchedule"],
    paths: [/\/schedules\/\{[^/{}]+\}\/?$/i],
    pathArgs: ["id"],
    options: Object.keys(SCHEDULE_BODY),
    body: SCHEDULE_BODY,
    requireAnyBody: true,
    examples: ['coderax schedules update sched-1 --cron "0 18 * * *" --yes'],
  }),
  define({
    id: "schedules.pause",
    path: ["schedules", "pause"],
    capability: "schedules",
    summary: "Pause a schedule",
    method: "POST",
    contract: "POST /schedules/{scheduleId}/pause",
    operationIds: ["pauseSchedule", "suspendSchedule"],
    paths: [/\/schedules\/\{[^/{}]+\}\/pause\/?$/i],
    pathArgs: ["id"],
    examples: ["coderax schedules pause sched-1"],
  }),
  define({
    id: "schedules.resume",
    path: ["schedules", "resume"],
    capability: "schedules",
    summary: "Resume a paused schedule",
    method: "POST",
    contract: "POST /schedules/{scheduleId}/resume",
    operationIds: ["resumeSchedule"],
    paths: [/\/schedules\/\{[^/{}]+\}\/resume\/?$/i],
    pathArgs: ["id"],
    examples: ["coderax schedules resume sched-1"],
  }),
  define({
    id: "schedules.delete",
    path: ["schedules", "delete"],
    capability: "schedules",
    summary: "Cancel and remove a schedule",
    method: "DELETE",
    contract: "DELETE /schedules/{scheduleId}",
    operationIds: ["deleteSchedule", "cancelSchedule"],
    paths: [/\/schedules\/\{[^/{}]+\}\/?$/i],
    pathArgs: ["id"],
    aliases: [["schedules", "cancel"]],
    confirm: true,
    examples: ["coderax schedules cancel sched-1 --yes"],
  }),

  // -------------------------------------------------------------- notifications
  define({
    id: "notifications.list",
    path: ["notifications", "list"],
    capability: "notifications",
    summary: "List notifications",
    method: "GET",
    contract: "GET /notifications",
    operationIds: ["listNotifications", "getNotifications"],
    paths: [/\/notifications\/?$/i],
    options: LIST_OPTIONS,
    query: LIST_OPTIONS,
    list: true,
    examples: ["coderax notifications --json"],
  }),
  define({
    id: "notifications.read",
    path: ["notifications", "read"],
    capability: "notifications",
    summary: "Mark a notification as read",
    method: "POST",
    contract: "POST /notifications/{notificationId}/read",
    operationIds: ["markNotificationRead", "readNotification", "acknowledgeNotification"],
    paths: [/\/notifications\/\{[^/{}]+\}\/read\/?$/i],
    pathArgs: ["id"],
    examples: ["coderax notifications read note-1"],
  }),

  // ----------------------------------------------------------------- artifacts
  define({
    id: "artifacts.list",
    path: ["artifacts", "list"],
    capability: "artifacts",
    summary: "List persistent artifacts",
    method: "GET",
    contract: "GET /artifacts",
    operationIds: ["listArtifacts", "getArtifacts"],
    paths: [/\/artifacts\/?$/i],
    options: LIST_OPTIONS,
    query: LIST_OPTIONS,
    list: true,
    examples: ["coderax artifacts --json"],
  }),
  define({
    id: "artifacts.show",
    path: ["artifacts", "show"],
    capability: "artifacts",
    summary: "Show artifact metadata",
    method: "GET",
    contract: "GET /artifacts/{artifactId}",
    operationIds: ["getArtifact", "showArtifact"],
    paths: [/\/artifacts\/\{[^/{}]+\}\/?$/i],
    pathArgs: ["id"],
    examples: ["coderax artifacts show art-1"],
  }),
  define({
    id: "artifacts.upload",
    path: ["artifacts", "upload"],
    capability: "artifacts",
    summary: "Upload a file as a persistent artifact",
    description: "Sends the file as multipart/form-data under the `file` field. The destination operation must accept multipart uploads.",
    method: "POST",
    contract: "POST /artifacts (multipart/form-data, field `file`)",
    operationIds: ["uploadArtifact", "createArtifact"],
    paths: [/\/artifacts\/?$/i],
    mode: "upload",
    fileArg: true,
    pathArgs: [],
    examples: ["coderax artifacts upload ./report.pdf --json"],
  }),
  define({
    id: "artifacts.download",
    path: ["artifacts", "download"],
    capability: "artifacts",
    summary: "Download artifact content",
    description: "Writes the artifact bytes to --output with mode 0600, atomically and without overwriting unless --force is set.",
    method: "GET",
    contract: "GET /artifacts/{artifactId}/content",
    operationIds: ["downloadArtifact", "getArtifactContent"],
    paths: [/\/artifacts\/\{[^/{}]+\}\/(?:content|download|file)\/?$/i],
    pathArgs: ["id"],
    mode: "download",
    options: ["output", "force"],
    examples: ["coderax artifacts download art-1 --output ./report.pdf --json"],
  }),
  define({
    id: "artifacts.delete",
    path: ["artifacts", "delete"],
    capability: "artifacts",
    summary: "Delete an artifact",
    method: "DELETE",
    contract: "DELETE /artifacts/{artifactId}",
    operationIds: ["deleteArtifact"],
    paths: [/\/artifacts\/\{[^/{}]+\}\/?$/i],
    pathArgs: ["id"],
    confirm: true,
    examples: ["coderax artifacts delete art-1 --yes"],
  }),

  // ------------------------------------------------------------------- plugins
  define({
    id: "plugins.list",
    path: ["plugins", "list"],
    capability: "plugins",
    summary: "List installed plugins",
    method: "GET",
    contract: "GET /plugins",
    operationIds: ["listPlugins", "getPlugins"],
    paths: [/\/plugins\/?$/i],
    options: LIST_OPTIONS,
    query: LIST_OPTIONS,
    list: true,
    examples: ["coderax plugins --json"],
  }),
  define({
    id: "plugins.show",
    path: ["plugins", "show"],
    capability: "plugins",
    summary: "Show one plugin",
    method: "GET",
    contract: "GET /plugins/{pluginId}",
    operationIds: ["getPlugin", "showPlugin"],
    paths: [/\/plugins\/\{[^/{}]+\}\/?$/i],
    pathArgs: ["id"],
    examples: ["coderax plugins show plugin-1"],
  }),

  // --------------------------------------------------------------------- tools
  define({
    id: "tools.list",
    path: ["tools", "list"],
    capability: "tools",
    summary: "List tools exposed to the account",
    method: "GET",
    contract: "GET /tools",
    operationIds: ["listTools", "getTools"],
    paths: [/\/tools\/?$/i],
    options: LIST_OPTIONS,
    query: LIST_OPTIONS,
    list: true,
    examples: ["coderax tools --json"],
  }),
  define({
    id: "tools.show",
    path: ["tools", "show"],
    capability: "tools",
    summary: "Show one tool and its input schema",
    method: "GET",
    contract: "GET /tools/{toolId}",
    operationIds: ["getTool", "showTool"],
    paths: [/\/tools\/\{[^/{}]+\}\/?$/i],
    pathArgs: ["id"],
    examples: ["coderax tools show tool-1 --json"],
  }),
  define({
    id: "tools.invoke",
    path: ["tools", "invoke"],
    capability: "tools",
    summary: "Invoke a tool",
    description: "Invokes the tool with the JSON object passed to --data. The deployment validates the input against the tool's own schema.",
    method: "POST",
    contract: "POST /tools/{toolId}/invoke",
    operationIds: ["invokeTool", "callTool", "runTool"],
    paths: [/\/tools\/\{[^/{}]+\}\/invoke\/?$/i],
    pathArgs: ["id"],
    options: ["data"],
    examples: ['coderax tools invoke tool-1 --data \'{"path":"README.md"}\' --json'],
  }),

  // ------------------------------------------------------------------ projects
  define({
    id: "projects.list",
    path: ["projects", "list"],
    capability: "projects",
    summary: "List cloud projects",
    method: "GET",
    contract: "GET /projects",
    operationIds: ["listProjects", "getProjects"],
    paths: [/\/projects\/?$/i],
    options: LIST_OPTIONS,
    query: LIST_OPTIONS,
    list: true,
    fallback: true,
    examples: ["coderax projects --json"],
  }),

  // ------------------------------------------------------------------ identity
  define({
    id: "whoami",
    path: ["whoami"],
    capability: "identity",
    summary: "Show the authenticated account",
    method: "GET",
    contract: "GET /user (fixed convenience route, same as `coderax login`)",
    fixedPath: "/api/user",
    examples: ["coderax whoami --json"],
  }),

  // -------------------------------------------------------------- capabilities
  define({
    id: "capabilities",
    path: ["capabilities"],
    capability: "capabilities",
    summary: "Report which commands this deployment can serve",
    description: "Binds every catalog command to the deployment's published operations and reports ready, partial and unavailable capabilities. Sends no request to any route that is not in the document.",
    mode: "capabilities",
    contract: "GET /capabilities (optional server capability document)",
    operationIds: ["getCapabilities", "listCapabilities"],
    paths: [/\/capabilities\/?$/i],
    examples: ["coderax capabilities", "coderax capabilities --json"],
  }),
]);

/** Commands implemented inside the CLI, not through a discovered operation. */
export const BUILTIN_COMMANDS = Object.freeze([
  Object.freeze({ command: "chat", summary: "Stream a chat reply over SSE", usage: 'coderax chat [message] [--model <id>] [--json]' }),
  Object.freeze({ command: "work", summary: "Run Work mode and stream the reply", usage: 'coderax work [message] [--model <id>] [--json]' }),
  Object.freeze({ command: "agents", summary: "List agents discovered from the OpenAPI document", usage: "coderax agents [--json]" }),
  Object.freeze({ command: "models", summary: "List models discovered from the OpenAPI document", usage: "coderax models [--json]" }),
  Object.freeze({ command: "products", summary: "Show the Coderax product registry", usage: "coderax products [--json]" }),
  Object.freeze({ command: "cloud", summary: "Report Coderax Cloud availability", usage: "coderax cloud [--json]" }),
  Object.freeze({ command: "login", summary: "Verify and store a deployment token", usage: "coderax login [--token <token>]" }),
  Object.freeze({ command: "logout", summary: "Remove the stored token", usage: "coderax logout [--json]" }),
  Object.freeze({ command: "status", summary: "Show local session configuration", usage: "coderax status [--json]" }),
  Object.freeze({ command: "config", summary: "Show or change deployment settings", usage: "coderax config show|get|set ..." }),
  Object.freeze({ command: "doctor", summary: "Diagnose configuration, reachability and auth", usage: "coderax doctor [--json]" }),
  Object.freeze({ command: "update", summary: "Explain how to update this build", usage: "coderax update [--json]" }),
  Object.freeze({ command: "health", summary: "Probe deployment health endpoints", usage: "coderax health [--json]" }),
  Object.freeze({ command: "openapi", summary: "List operations from the OpenAPI document", usage: "coderax openapi [--json]" }),
  Object.freeze({ command: "call", summary: "Issue one authenticated request", usage: "coderax call <METHOD> <PATH> [--data <json>]" }),
  Object.freeze({ command: "completion", summary: "Print a shell completion script", usage: "coderax completion [bash|zsh|fish]" }),
  Object.freeze({ command: "version", summary: "Print the CLI version", usage: "coderax version" }),
  Object.freeze({ command: "help", summary: "Show help for the CLI or one command", usage: "coderax help [command]" }),
]);

/** Flags accepted by every command. */
export const GLOBAL_OPTIONS = Object.freeze(new Set([
  "help",
  "version",
  "json",
  "no-color",
  "base-url",
  "token",
  "timeout",
  "model",
  "endpoint",
  "chat-path",
  "url",
  "yes",
  "operation",
  "param",
]));

const GROUPS = new Map();
const STANDALONE = new Map();
const TOP_ALIASES = new Map();

for (const spec of COMMAND_SPECS) {
  if (spec.mode === "legacy") continue;
  const [root, action] = spec.path;
  if (action === undefined) {
    STANDALONE.set(root, spec);
  } else {
    let group = GROUPS.get(root);
    if (!group) {
      group = { root, actions: new Map(), ordered: [], defaultSpec: null };
      GROUPS.set(root, group);
    }
    group.actions.set(action, spec);
    group.ordered.push(action);
    if (action === "list") group.defaultSpec = spec;
    for (const alias of spec.aliases ?? []) {
      if (alias.length === 2 && alias[0] === root) {
        if (!group.actions.has(alias[1])) group.ordered.push(alias[1]);
        group.actions.set(alias[1], spec);
      }
    }
  }
  for (const alias of spec.topAliases ?? []) TOP_ALIASES.set(alias, spec);
}

export function catalogRoots() {
  return [...new Set([...GROUPS.keys(), ...STANDALONE.keys(), ...TOP_ALIASES.keys()])];
}

export function normalizeMethods(method) {
  return (Array.isArray(method) ? method : [method ?? "GET"]).map((value) => String(value).toUpperCase());
}

export function pathParamCount(path) {
  return [...String(path ?? "").matchAll(/\{[^}]+\}/g)].length;
}

export function pathParamNames(path) {
  return [...String(path ?? "").matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
}

/** Resolve a command path to its spec, or descriptive usage error. */
export function resolveSurfaceCommand(positionals) {
  const [root, second, ...rest] = positionals;
  if (!root) return null;

  if (STANDALONE.has(root)) return { spec: STANDALONE.get(root), args: positionals.slice(1) };
  if (TOP_ALIASES.has(root)) return { spec: TOP_ALIASES.get(root), args: positionals.slice(1) };

  const group = GROUPS.get(root);
  if (!group) return null;
  if (second === undefined) {
    return { spec: group.defaultSpec, args: [] };
  }
  if (group.actions.has(second)) return { spec: group.actions.get(second), args: rest };

  throw new CoderaxError(
    "USAGE",
    `unknown ${root} action: ${second}. Available: ${group.ordered.join(", ")}`,
  );
}

export function validateSurfaceOptions(spec, flags) {
  const allowed = new Set([...GLOBAL_OPTIONS, ...(spec.options ?? [])]);
  for (const name of flags.keys()) {
    if (!allowed.has(name)) {
      const usable = [...allowed].filter((entry) => entry !== "help" && entry !== "version").sort();
      throw new CoderaxError("USAGE", `--${name} is not valid for \`${spec.path.join(" ")}\`. Usable options: ${usable.join(", ")}`);
    }
  }
}

export function checkArgumentCount(spec, args) {
  const expected = spec.pathArgs?.length ?? 0;
  const actual = args.length - (spec.fileArg ? 1 : 0);
  if (spec.fileArg && args.length === 0) {
    throw new CoderaxError("USAGE", `\`${spec.path.join(" ")}\` requires a file path`);
  }
  if (actual !== expected) {
    const wanted = expected === 0
      ? "no path arguments"
      : `${expected} path argument${expected === 1 ? "" : "s"} (${(spec.pathArgs ?? []).map((name) => `<${name}>`).join(" ")})`;
    throw new CoderaxError("USAGE", `\`${spec.path.join(" ")}\` expects ${wanted}, received ${Math.max(actual, 0)}`);
  }
}

function compareOperations(a, b) {
  return pathParamCount(a.path) - pathParamCount(b.path)
    || a.path.length - b.path.length
    || a.path.localeCompare(b.path)
    || a.method.localeCompare(b.method);
}

/** Every published operation matching a spec, best candidate first. */
export function candidateOperations(spec, operations) {
  const methods = normalizeMethods(spec.method);
  const byMethod = operations.filter((operation) => methods.includes(operation.method));
  const ids = new Set((spec.operationIds ?? []).map((id) => id.toLowerCase()));
  let matches = byMethod.filter((operation) => operation.operationId && ids.has(operation.operationId.toLowerCase()));
  if (matches.length === 0) {
    matches = byMethod.filter((operation) => (spec.paths ?? []).some((pattern) => pattern.test(operation.path)));
  }
  return matches.sort(compareOperations);
}

/**
 * Bind a spec to exactly one authoritative operation. Throws when absent or
 * ambiguous; never guesses a route.
 */
export function bindOperation(spec, operations, override) {
  if (override) return bindOverride(spec, operations, override);

  const candidates = candidateOperations(spec, operations);
  if (candidates.length === 0) {
    const methods = normalizeMethods(spec.method).join("/");
    throw new CoderaxError(
      "OPERATION_NOT_FOUND",
      `the deployment's OpenAPI document publishes no ${methods} operation for \`${spec.path.join(" ")}\` (contract: ${spec.contract}). Nothing was sent. Run \`coderax capabilities\` to see what this deployment supports.`,
    );
  }

  const [best, second] = candidates;
  if (second && second.path !== best.path && pathParamCount(second.path) === pathParamCount(best.path)) {
    const rendered = candidates
      .filter((operation) => operation.path !== best.path || operation.method === best.method)
      .slice(0, 4)
      .map((operation) => `${operation.method} ${operation.path}${operation.operationId ? ` (${operation.operationId})` : ""}`)
      .join(", ");
    throw new CoderaxError(
      "OPERATION_AMBIGUOUS",
      `multiple operations match \`${spec.path.join(" ")}\`: ${rendered}. Re-run with --operation <operationId> to choose one.`,
    );
  }
  return best;
}

function bindOverride(spec, operations, override) {
  const target = override.trim();
  const byId = operations.filter(
    (operation) => (operation.operationId ?? "").toLowerCase() === target.toLowerCase(),
  );
  if (byId.length > 0) return byId.sort(compareOperations)[0];

  const spaced = /^([A-Za-z]+)\s+(.+)$/.exec(target);
  if (spaced) {
    const method = spaced[1].toUpperCase();
    const path = spaced[2];
    const exact = operations.find((operation) => operation.method === method && operation.path === path);
    if (exact) return exact;
  }

  const byPath = operations.filter((operation) => operation.path === target);
  if (byPath.length === 1) return byPath[0];

  throw new CoderaxError(
    "OPERATION_NOT_FOUND",
    `--operation ${target} does not match any discovered operation for \`${spec.path.join(" ")}\`. Run \`coderax openapi\` to list operations.`,
  );
}

export function buildCapabilityReport(operations, server = null) {
  const capabilities = new Map();

  for (const spec of COMMAND_SPECS) {
    if (spec.mode === "legacy") continue;
    let operation = null;
    let ambiguous = false;
    let binding = "openapi";

    if (spec.fixedPath) {
      operation = { method: normalizeMethods(spec.method)[0], path: spec.fixedPath, operationId: null };
      binding = "fixed";
    } else {
      const candidates = candidateOperations(spec, operations);
      operation = candidates[0] ?? null;
      ambiguous = Boolean(
        operation
        && candidates[1]
        && candidates[1].path !== operation.path
        && pathParamCount(candidates[1].path) === pathParamCount(operation.path),
      );
    }

    const entry = {
      command: spec.path.join(" "),
      summary: spec.summary,
      mode: spec.mode,
      available: Boolean(operation) && !ambiguous,
      ambiguous,
      binding,
      contract: spec.contract,
      operation: operation
        ? { method: operation.method, path: operation.path, operationId: operation.operationId ?? null }
        : null,
    };

    if (!capabilities.has(spec.capability)) {
      capabilities.set(spec.capability, { capability: spec.capability, commands: [] });
    }
    capabilities.get(spec.capability).commands.push(entry);
  }

  const groups = [...capabilities.values()].map((group) => {
    const ready = group.commands.filter((command) => command.available).length;
    const status = ready === group.commands.length
      ? "ready"
      : ready === 0
        ? "unavailable"
        : "partial";
    return Object.freeze({ ...group, status });
  });

  return {
    capabilities: groups,
    builtins: BUILTIN_COMMANDS,
    server,
  };
}

export function renderCapabilityTable(report) {
  const rows = report.capabilities.map((group) => [
    group.capability,
    group.status,
    group.commands.map((command) => command.command.split(" ").slice(1).join(" ") || command.command).join(", "),
  ]);
  const widths = [0, 1, 2].map((index) =>
    Math.max(["CAPABILITY", "STATUS", "COMMANDS"][index].length, ...rows.map((row) => String(row[index]).length)),
  );
  const line = (cells) => cells.map((cell, index) => String(cell).padEnd(widths[index])).join("  ").trimEnd();
  return [
    line(["CAPABILITY", "STATUS", "COMMANDS"]),
    line(widths.map((width) => "\u2500".repeat(width))),
    ...rows.map(line),
  ];
}

export function renderBindings(report) {
  const lines = [];
  for (const group of report.capabilities) {
    for (const command of group.commands) {
      const binding = command.operation
        ? `${command.operation.method} ${command.operation.path}${command.operation.operationId ? `  (${command.operation.operationId})` : ""}`
        : `not published  (contract: ${command.contract})`;
      lines.push(`  ${command.command.padEnd(24)} ${binding}${command.ambiguous ? "  [ambiguous: use --operation]" : ""}`);
    }
  }
  return lines;
}

export function renderUsageGroups() {
  const lines = [];
  const roots = [...GROUPS.keys()].sort();
  for (const root of roots) {
    const group = GROUPS.get(root);
    const actions = [...group.ordered];
    const label = group.defaultSpec ? `[${actions.join("|")}]` : `<${actions.join("|")}>`;
    lines.push(`  coderax ${root} ${label}`);
  }
  for (const root of [...STANDALONE.keys()].sort()) {
    const spec = STANDALONE.get(root);
    if (spec.mode === "capabilities") continue;
    lines.push(`  coderax ${root}`);
  }
  for (const root of [...TOP_ALIASES.keys()].sort()) {
    lines.push(`  coderax ${root} <id>`);
  }
  return lines.join("\n");
}

export function specHelp(spec) {
  const methods = normalizeMethods(spec.method).join("/");
  const signature = [
    "coderax",
    ...spec.path,
    ...(spec.fileArg ? ["<file>"] : []),
    ...(spec.pathArgs ?? []).map((name) => `<${name}>`),
  ].join(" ");

  const options = [...(spec.options ?? [])].sort();
  const lines = [
    `Usage:\n  ${signature} [options]`,
    "",
    spec.description ?? spec.summary,
    "",
    `Capability: ${spec.capability}`,
    `Binds to: ${methods} operation (${spec.contract})`,
    "Path, query and body rules come from the deployment's OpenAPI document.",
  ];
  if (options.length > 0) {
    const rendered = options.map((name) => {
      const type = spec.body?.[name] ?? "string";
      return `--${name} <${type}>`;
    });
    lines.push(`Command options:\n  ${rendered.join(", ")}`);
  }
  if (spec.requiredBody?.length) lines.push(`Required fields: ${spec.requiredBody.map((name) => `--${name}`).join(", ")}`);
  if (spec.confirm) lines.push("Destructive: requires --yes.");
  if (spec.examples?.length) lines.push(`Examples:\n${spec.examples.map((example) => `  ${example}`).join("\n")}`);
  lines.push(`Global options: --json, --base-url, --token, --timeout, --operation, --param <key=value>, --yes`);
  return `${lines.join("\n")}\n`;
}
