/**
 * One authoritative command registry.
 *
 * Every surface reads command names, availability and operations from this
 * file: top-level dispatch validation, `engine` dispatch, help, capabilities
 * and generated shell completion. A command may only be `available` when the
 * authoritative WorkflowEngine 1.0.0 contract exposes the operation it names.
 *
 * The separate Coderax deployment API (the legacy Work API) is not described
 * here and is not conflated with WorkflowEngine. Commands that the engine does
 * not implement are `blocked`, with a reason, and must fail before any network
 * request instead of simulating success.
 */

import { CONTRACT_VERSION, ROUTES } from "./contract.js";

/** The engine contract this client is written against. */
export const ENGINE_CONTRACT_VERSION = CONTRACT_VERSION;
export const ENGINE_API_PREFIX = "/v1";

/**
 * The authoritative operation table comes from the pinned contract module
 * (`src/contract.js`), which mirrors the engine's published OpenAPI document
 * and is checked by its digest. This registry only names commands on top of
 *that one table; it does not keep a second route catalogue.
 */
export const ENGINE_OPERATIONS = Object.freeze(
  Object.fromEntries(
    ROUTES.map(({ operationId, method, path, auth }) => [
      operationId,
      { method, path, auth },
    ]),
  ),
);

/**
 * Engine commands and their honest state.
 *
 * status:
 *   available    - implemented by the engine and wired by this CLI
 *   blocked      - no authoritative operation exists; fails closed, no request
 *   unconfigured - implemented, but this invocation has no deployment/token
 */
export const ENGINE_COMMANDS = Object.freeze([
  {
    name: "login",
    status: "available",
    operation: "listAgents",
    usage: "engine login [--token-file <path>] [--json]",
    summary: "Verify the owner token against /v1/agents and store it securely.",
  },
  {
    name: "logout",
    status: "available",
    operation: null,
    usage: "engine logout [--json]",
    summary: "Remove the stored engine owner token.",
  },
  {
    name: "health",
    status: "available",
    operation: "getHealth",
    usage: "engine health [--json]",
    summary: "Read the engine's public health report and contract version.",
  },
  {
    name: "ready",
    status: "available",
    operation: "getReadiness",
    usage: "engine ready [--json]",
    summary: "Check whether the engine is ready to accept traffic.",
  },
  {
    name: "compat",
    status: "available",
    operation: "getHealth",
    usage: "engine compat [--strict] [--json]",
    summary: "Validate the served contract version and owner authentication.",
  },
  {
    name: "verify",
    status: "available",
    operation: "listAgents",
    usage: "engine verify [--json]",
    summary: "Prove the configured token is accepted as the engine owner.",
  },
  {
    name: "agents",
    status: "available",
    operation: "listAgents",
    usage: "engine agents [--json]",
    summary: "List agents, capabilities and truthful availability.",
  },
  {
    name: "models",
    status: "available",
    operation: "listModels",
    usage: "engine models [--json]",
    summary: "List zero-cost models and the configured free route.",
  },
  {
    name: "chat",
    status: "available",
    operation: "submitChat",
    usage: "engine chat <message> [--conversation <id>] [--agent <id>] [--model <provider/model>] [--mode private|cloud] [--json]",
    summary: "Send one chat turn to the authoritative engine.",
  },
  {
    name: "work",
    status: "available",
    operation: "submitWork",
    usage: "engine work submit <objective>|--data <json> [--agent <id>] [--model <provider/model>] [--mode private|cloud] [--no-approval] [--follow|--detach] [--json]",
    summary: "Submit durable Work; --follow streams it, --detach returns after submission.",
  },
  {
    name: "task",
    status: "available",
    operation: "getTask",
    usage: "engine task <taskId> [--json]",
    summary: "Read one task's authoritative status by id.",
  },
  {
    name: "tasks",
    status: "available",
    operation: "listNotifications",
    usage: "engine tasks [--json]",
    summary: "List durable task completions derived from notifications; 1.0.0 has no task-list operation.",
  },
  {
    name: "events",
    status: "available",
    operation: "streamTaskEvents",
    usage: "engine events <taskId> [--after <n>] [--once] [--json]",
    summary: "Replay and tail a task's durable event stream.",
  },
  {
    name: "cancel",
    status: "available",
    operation: "cancelTask",
    usage: "engine cancel <taskId> [--reason <text>] [--json]",
    summary: "Request cancellation of a durable task.",
  },
  {
    name: "resume",
    status: "available",
    operation: "resumeTask",
    usage: "engine resume <taskId> [--generation <n>] [--json]",
    summary: "Resume a paused or interrupted task.",
  },
  {
    name: "retry",
    status: "available",
    operation: "retryTask",
    usage: "engine retry <taskId> [--generation <n>] [--model <provider/model>] [--json]",
    summary: "Retry a terminal task from its authoritative generation.",
  },
  {
    name: "conversations",
    status: "available",
    operation: "listConversations",
    usage: "engine conversations [--json]",
    summary: "List chat and Work conversations.",
  },
  {
    name: "conversation",
    status: "available",
    operation: "getConversation",
    usage: "engine conversation <conversationId> [--json]",
    summary: "Read one conversation transcript.",
  },
  {
    name: "memory",
    status: "available",
    operation: "listMemory",
    usage: "engine memory [--mode private|cloud] [--json]",
    summary: "Read owner memory in one data mode.",
  },
  {
    name: "permissions",
    status: "available",
    operation: "listPermissions",
    usage: "engine permissions <taskId> | decide <taskId> <requestId> approve|deny [--reason <text>] [--json]",
    summary: "Read pending permission requests or decide one.",
  },
  {
    name: "approve",
    status: "available",
    operation: "decidePermission",
    usage: "engine approve <taskId> <requestId> [--reason <text>] [--json]",
    summary: "Approve one pending permission request.",
  },
  {
    name: "deny",
    status: "available",
    operation: "decidePermission",
    usage: "engine deny <taskId> <requestId> [--reason <text>] [--json]",
    summary: "Deny one pending permission request.",
  },
  {
    name: "notifications",
    status: "available",
    operation: "listNotifications",
    usage: "engine notifications [--json]",
    summary: "Read durable task-completion notifications.",
  },
  {
    name: "capabilities",
    status: "available",
    operation: null,
    usage: "engine capabilities [--json]",
    summary: "Report available, unconfigured and blocked capabilities.",
  },
  {
    name: "status",
    status: "available",
    operation: null,
    usage: "engine status [--json]",
    summary: "Show the configured engine URL, token source and data mode.",
  },
  {
    name: "doctor",
    status: "available",
    operation: "getHealth",
    usage: "engine doctor [--json]",
    summary: "Run local and engine diagnostics, including contract and owner auth.",
  },
  {
    name: "help",
    status: "available",
    operation: null,
    usage: "engine help [<command>]",
    summary: "Show the authoritative engine command surface.",
  },
  {
    name: "schedules",
    status: "blocked",
    reason: "WorkflowEngine 1.0.0 exposes no schedule operations; schedule creation and updates cannot be bound to a versioned backend operation.",
  },
  {
    name: "artifacts",
    status: "available",
    operation: "getTask",
    usage: "engine artifacts <taskId> [--json]",
    summary: "List artifact metadata from a task result; 1.0.0 has no upload or download operation.",
  },
  {
    name: "transfers",
    status: "blocked",
    reason: "WorkflowEngine 1.0.0 exposes no artifact upload, download or file-transfer operation; task results carry metadata only.",
  },
  {
    name: "plugins",
    status: "blocked",
    reason: "WorkflowEngine 1.0.0 exposes no plugin operations.",
  },
  {
    name: "tools",
    status: "blocked",
    reason: "WorkflowEngine 1.0.0 exposes no tool operations and the native agent reports tools as unavailable.",
  },
  {
    name: "projects",
    status: "blocked",
    reason: "WorkflowEngine 1.0.0 exposes no project operations; projects belong to the separate Coderax deployment API.",
  },
  {
    name: "executions",
    status: "blocked",
    reason: "WorkflowEngine 1.0.0 has no execution-list operation; a task can only be read by id.",
  },
  {
    name: "browser",
    status: "blocked",
    reason: "WorkflowEngine 1.0.0 exposes no cloud-browser session operation.",
  },
  {
    name: "game-studio",
    status: "blocked",
    reason: "Native Game Studio has no WorkflowEngine 1.0.0 operation.",
  },
  {
    name: "gaming-agent",
    status: "blocked",
    reason: "Native Gaming Agent has no WorkflowEngine 1.0.0 operation.",
  },
  {
    name: "openapi",
    status: "blocked",
    reason: "WorkflowEngine 1.0.0 does not serve an OpenAPI document; the CLI binds to its fixed contract instead of trusting a discovered document.",
  },
  {
    name: "identity",
    status: "blocked",
    reason: "WorkflowEngine 1.0.0 has no identity endpoint. `engine verify` proves owner authorization; it does not invent a profile.",
  },
]);

const ENGINE_BY_NAME = new Map(ENGINE_COMMANDS.map((command) => [command.name, command]));

export function findEngineCommand(name) {
  return ENGINE_BY_NAME.get(name) ?? null;
}

/**
 * Top-level command table: the only list of CLI commands.
 *
 * Dispatch validation, help and shell completion read this table, and
 * `src/cli.js` resolves each `handler` key against its single dispatch map.
 * The parity test in `test/command-registry.test.js` fails if a command has no
 * handler or a handler is unreachable, so the registry and the implementations
 * cannot drift without a failing test.
 *
 * `usage` is the help line (or lines) rendered by `renderTopLevelUsage()`.
 * `aliasOf` folds a dispatchable alias into a visible command's usage line;
 * `hidden` keeps a legacy alias dispatchable without advertising it in help.
 */
export const TOP_LEVEL_COMMANDS = Object.freeze([
  {
    name: "config",
    handler: "cli.config",
    usage: [
      "config show|list [--json]",
      "config get <key>",
      "config set <key> <value>",
      "config set [--base-url <url>] [--timeout <ms>]",
    ],
    summary: "Show or change stored configuration.",
  },
  {
    name: "health",
    handler: "cli.health",
    requiresBaseUrl: true,
    usage: "health [--json]",
    summary: "Probe the deployment's health endpoint.",
  },
  {
    name: "openapi",
    handler: "cli.openapi",
    requiresBaseUrl: true,
    usage: "openapi [--json]",
    summary: "List the deployment's OpenAPI operations.",
  },
  {
    name: "agents",
    handler: "workflow.agents",
    requiresBaseUrl: true,
    usage: "agents [--work] [--json]",
    summary: "List agents, or Work-eligible agents with --work.",
  },
  {
    name: "models",
    handler: "workflow.models",
    requiresBaseUrl: true,
    usage: "models [--work] [--json]",
    summary: "List models, or Work-eligible models with --work.",
  },
  {
    name: "call",
    handler: "cli.call",
    requiresBaseUrl: true,
    usage: "call <METHOD> <PATH> [--data <json>] [--json]",
    summary: "Call one deployment endpoint with an arbitrary method.",
  },
  {
    name: "products",
    handler: "product.products",
    usage: "products|cloud|projects|update [--json]",
    summary: "Product, cloud, project and update status.",
  },
  { name: "cloud", handler: "product.cloud", aliasOf: "products" },
  { name: "projects", handler: "product.projects", aliasOf: "products" },
  { name: "update", handler: "product.update", aliasOf: "products" },
  {
    name: "login",
    handler: "product.login",
    usage: "login [--token-file <path>] [--json]",
    summary: "Verify the owner role, then store the token.",
  },
  {
    name: "logout",
    handler: "product.logout",
    usage: "logout [--json]",
    summary: "Remove the stored deployment token.",
  },
  {
    name: "status",
    handler: "product.status",
    usage: "status [--json]",
    summary: "Show deployment, credential and product status.",
  },
  {
    name: "whoami",
    handler: "workflow.whoami",
    usage: "whoami [--json]",
    summary: "Show the verified owner identity.",
  },
  {
    name: "chat",
    handler: "workflow.chat",
    usage: "chat [message] [--model <id>] [--agent <id>] [--conversation <id>] [--new] [--json]",
    summary: "Send one chat turn to the deployment.",
  },
  {
    name: "work",
    handler: "workflow.work",
    usage: [
      "work [message] [--model <id>] [--agent <id>] [--json]",
      "work submit <prompt> --repo <owner/name> --agent <id> [--base-ref <ref>] [--mode turbo15|autonomous|verified] [--workspace <name>] [--follow] [--json]",
    ],
    summary: "Run Work chat or submit a durable autonomous build.",
  },
  {
    name: "tasks",
    handler: "workflow.tasks",
    usage: "tasks [taskId] [--json]",
    summary: "Durable Work conversations.",
  },
  {
    name: "workflows",
    handler: "workflow.workflows",
    usage: "workflows [--json]",
    summary: "List workflow definitions.",
  },
  {
    name: "runs",
    handler: "workflow.runs",
    usage: "runs --workflow <id> [--json]",
    summary: "List runs for one workflow.",
  },
  {
    name: "run",
    handler: "workflow.run",
    usage: "run <runId> [--no-follow] [--approval ask|allow|deny] [--notify] [--notify-command <cmd>] [--cancel-on-interrupt] [--json]",
    summary: "Monitor one durable run.",
  },
  {
    name: "cancel",
    handler: "workflow.cancel",
    usage: "cancel <runId|taskId> [--task] [--json]",
    summary: "Cancel a run or task.",
  },
  {
    name: "resume",
    handler: "workflow.resume",
    usage: "resume <runId> [--json]",
    summary: "Resume a run.",
  },
  {
    name: "retry",
    handler: "workflow.retry",
    usage: "retry <runId> [--follow] [--json]",
    summary: "Retry a run.",
  },
  {
    name: "approve",
    handler: "workflow.approve",
    usage: "approve <runId> <stepIndex> [--json]",
    summary: "Approve one pending run step.",
  },
  {
    name: "repos",
    handler: "workflow.repos",
    usage: "repos [--json]",
    summary: "List repositories available to Work.",
  },
  {
    name: "doctor",
    handler: "product.doctor",
    usage: "doctor|diagnostics [--json]",
    summary: "Run local and deployment diagnostics.",
  },
  { name: "diagnostics", handler: "product.doctor", aliasOf: "doctor" },
  {
    name: "version",
    handler: "cli.version",
    usage: "version [--json]",
    summary: "Show install and compatibility information.",
  },
  {
    name: "compat",
    handler: "product.compat",
    usage: "compat [--json]",
    summary: "Check the deployment API-version handshake.",
  },
  {
    name: "v1",
    handler: "v1.run",
    usage: "v1 <health|models|agents|chat|submit|task|watch|tasks|cancel|resume|retry|resolve|notifications|conversations|permissions|templates> [--json]",
    summary: "Use the shared SDK's WorkflowEngine /v1 commands.",
  },
  {
    name: "history",
    handler: "product.history",
    usage: "history [list|clear|on|off|retention <days>] [--json]",
    summary: "Manage prompt history.",
  },
  {
    name: "engine",
    handler: "engine.run",
    usage: "engine <command> [options] [--json]",
    summary: "Authoritative WorkflowEngine 1.0.0 command surface; `engine help` lists every command.",
  },
  {
    name: "completion",
    handler: "cli.completion",
    usage: "completion <bash|zsh|fish>",
    summary: "Print shell completion generated from this registry.",
  },
  {
    name: "uninstall",
    handler: "maintenance.uninstall",
    usage: "uninstall [--yes] [--dry-run] [--purge] [--json]",
    summary: "Remove local user data; the installer removes the program.",
  },
  { name: "cleanup", handler: "maintenance.uninstall", aliasOf: "uninstall", hidden: true },
  {
    name: "help",
    handler: "cli.help",
    usage: "help",
    summary: "Show this help.",
  },
]);

/** Names in registry order, for validation and completion. */
export const TOP_LEVEL_COMMAND_NAMES = Object.freeze(
  TOP_LEVEL_COMMANDS.map((command) => command.name),
);

const TOP_LEVEL_BY_NAME = new Map(
  TOP_LEVEL_COMMANDS.map((command) => [command.name, command]),
);

export function findTopLevelCommand(name) {
  return TOP_LEVEL_BY_NAME.get(name) ?? null;
}

const HELP_SUMMARY_COLUMN = 50;

/** The Usage section of `coderax --help`, generated from this table. */
export function renderTopLevelUsage() {
  const lines = [];
  for (const command of TOP_LEVEL_COMMANDS) {
    if (command.aliasOf || command.hidden) continue;
    const usages = Array.isArray(command.usage) ? command.usage : [command.usage];
    usages.forEach((usage, index) => {
      const text = `  coderax ${usage}`;
      const summary = index === 0 ? command.summary : undefined;
      if (!summary) {
        lines.push(text);
      } else if (text.length + 2 > HELP_SUMMARY_COLUMN) {
        lines.push(`${text}\n${" ".repeat(HELP_SUMMARY_COLUMN)}${summary}`);
      } else {
        lines.push(`${text}${" ".repeat(HELP_SUMMARY_COLUMN - text.length)}${summary}`);
      }
    });
  }
  return lines.join("\n");
}

export const GLOBAL_FLAGS = Object.freeze([
  "help",
  "version",
  "json",
  "base-url",
  "token-file",
  "timeout",
  "data",
  "model",
  "agent",
  "endpoint",
  "chat-path",
  "url",
  "conversation",
  "new",
  "repo",
  "base-ref",
  "mode",
  "workspace",
  "follow",
  "detach",
  "no-follow",
  "approval",
  "workflow",
  "task",
  "notify",
  "notify-command",
  "cancel-on-interrupt",
  "strict",
  "max-retries",
  "work",
  "yes",
  "dry-run",
  "purge",
  "no-color",
  "no-approval",
  "reason",
  "generation",
  "after",
  "once",
  "interactive",
  "accessible",
  "plain",
  "resume",
  "no-history",
  "template",
  "retry-submission",
  "reasoning",
]);

export const BOOLEAN_GLOBAL_FLAGS = Object.freeze([
  "help",
  "version",
  "json",
  "no-color",
  "new",
  "follow",
  "detach",
  "no-follow",
  "strict",
  "notify",
  "cancel-on-interrupt",
  "work",
  "task",
  "yes",
  "dry-run",
  "purge",
  "no-approval",
  "once",
  "interactive",
  "accessible",
  "plain",
  "no-history",
  "retry-submission",
]);

/** Shell completion generated from this registry, not a second list. */
export function completionScript(shell) {
  const top = TOP_LEVEL_COMMAND_NAMES.join(" ");
  const engine = ENGINE_COMMANDS.filter((command) => command.status === "available")
    .map((command) => command.name)
    .join(" ");
  const blocked = ENGINE_COMMANDS.filter((command) => command.status === "blocked")
    .map((command) => command.name)
    .join(" ");

  if (shell === "bash") {
    return `# bash completion for coderax (generated from src/command-registry.js)
_coderax_complete() {
  local cur prev
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  if [ "\${COMP_WORDS[1]}" = "engine" ]; then
    if [ "$COMP_CWORD" -eq 2 ]; then
      COMPREPLY=( $(compgen -W "${engine} ${blocked}" -- "$cur") )
      return 0
    fi
    case "\${COMP_WORDS[2]}" in
      tasks) COMPREPLY=( $(compgen -W "events cancel resume retry" -- "$cur") ); return 0 ;;
      permissions) COMPREPLY=( $(compgen -W "decide" -- "$cur") ); return 0 ;;
      completion) COMPREPLY=( $(compgen -W "bash zsh fish" -- "$cur") ); return 0 ;;
    esac
    return 0
  fi
  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "${top}" -- "$cur") )
    return 0
  fi
  case "\${COMP_WORDS[1]}" in
    completion) COMPREPLY=( $(compgen -W "bash zsh fish" -- "$cur") ); return 0 ;;
  esac
  COMPREPLY=()
}
complete -F _coderax_complete coderax
`;
  }

  if (shell === "zsh") {
    return `#compdef coderax
# generated from src/command-registry.js
_coderax() {
  local -a top engine blocked
  top=(${TOP_LEVEL_COMMAND_NAMES.join(" ")})
  engine=(${ENGINE_COMMANDS.filter((c) => c.status === "available").map((c) => c.name).join(" ")})
  blocked=(${ENGINE_COMMANDS.filter((c) => c.status === "blocked").map((c) => c.name).join(" ")})
  if (( CURRENT == 2 )); then
    _describe 'command' top
  elif [[ $words[2] == engine ]]; then
    if (( CURRENT == 3 )); then
      _describe 'engine command' engine
      _describe 'blocked engine command' blocked
    fi
  elif [[ $words[2] == completion ]]; then
    _values 'shell' bash zsh fish
  fi
}
_coderax "$@"
`;
  }

  if (shell === "fish") {
    const topLines = TOP_LEVEL_COMMAND_NAMES.map(
      (command) => `complete -c coderax -n "__fish_use_subcommand" -a "${command}"`,
    ).join("\n");
    const engineLines = ENGINE_COMMANDS.map(
      (command) =>
        `complete -c coderax -n "__fish_seen_subcommand_from engine" -a "${command.name}" -d "${command.status === "blocked" ? "blocked: " : ""}${(command.summary ?? command.reason ?? "").replace(/"/g, "'")}"`,
    ).join("\n");
    return `# fish completion for coderax (generated from src/command-registry.js)\n${topLines}\n${engineLines}\ncomplete -c coderax -n "__fish_seen_subcommand_from completion" -a "bash zsh fish"\n`;
  }

  throw new Error(`unsupported shell: ${shell}`);
}
