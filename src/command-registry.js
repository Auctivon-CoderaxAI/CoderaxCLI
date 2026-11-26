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
    usage: "engine work submit <objective>|--data <json> [--agent <id>] [--model <provider/model>] [--mode private|cloud] [--no-approval] [--follow] [--json]",
    summary: "Submit durable Work and optionally follow it to a terminal state.",
  },
  {
    name: "tasks",
    status: "available",
    operation: "getTask",
    usage: "engine tasks <taskId> | events <taskId> [--after <n>] | cancel <taskId> [--reason <text>] | resume <taskId> | retry <taskId> [--generation <n>] [--model <provider/model>]",
    summary: "Read a task, replay its events, or cancel/resume/retry it.",
  },
  {
    name: "conversations",
    status: "available",
    operation: "listConversations",
    usage: "engine conversations [<conversationId>] [--json]",
    summary: "List conversations or read one with its transcript.",
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
    name: "doctor",
    status: "available",
    operation: "getHealth",
    usage: "engine doctor [--json]",
    summary: "Alias for compat with the engine contract check.",
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
    status: "blocked",
    reason: "WorkflowEngine 1.0.0 lists artifact paths in task results but exposes no artifact or file-transfer operation.",
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
    name: "detach",
    status: "blocked",
    reason: "WorkflowEngine 1.0.0 does not accept a detach request; Work is durable by default because submit returns before the run finishes.",
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
 * Top-level commands owned by the consolidated CLI. PR #6's release,
 * authentication, sync and maintenance handlers remain in place; `engine`
 * and `completion` are the two added entry points.
 */
export const TOP_LEVEL_COMMANDS = Object.freeze([
  "config",
  "health",
  "openapi",
  "agents",
  "models",
  "call",
  "products",
  "chat",
  "work",
  "cloud",
  "projects",
  "login",
  "logout",
  "status",
  "whoami",
  "tasks",
  "workflows",
  "runs",
  "run",
  "cancel",
  "resume",
  "retry",
  "approve",
  "repos",
  "doctor",
  "diagnostics",
  "update",
  "compat",
  "uninstall",
  "cleanup",
  "help",
  "version",
  "engine",
  "completion",
]);

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
]);

/** Shell completion generated from this registry, not a second list. */
export function completionScript(shell) {
  const top = TOP_LEVEL_COMMANDS.join(" ");
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
  top=(${TOP_LEVEL_COMMANDS.join(" ")})
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
    const topLines = TOP_LEVEL_COMMANDS.map(
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
