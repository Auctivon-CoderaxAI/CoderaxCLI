/**
 * Canonical command catalogue.
 *
 * This is the single source of truth for:
 *
 * - the top-level commands `src/cli.js` accepts and its usage text;
 * - the slash commands the interactive terminal completes and documents.
 *
 * A command may exist in one surface or both. `cli.usage` is never completed;
 * `interactive.usage` always starts with `/` because that is what the terminal
 * accepts. Adding a command here is the only way to make either surface aware
 * of it, so the two can no longer drift apart.
 */

/**
 * @typedef {object} CommandEntry
 * @property {string} name stable identifier used by the dispatcher
 * @property {string} description one-line human description
 * @property {string} [cli] usage line for the non-interactive CLI
 * @property {string} [interactive] usage line for the interactive terminal
 */

/** @type {ReadonlyArray<CommandEntry>} */
export const COMMANDS = Object.freeze([
  // Interactive-first entries keep completion order stable and predictable.
  Object.freeze({
    name: "help",
    description: "Show keys and commands",
    cli: "help",
    interactive: "/help",
  }),
  Object.freeze({
    name: "mode",
    description: "Switch between Chat and Work",
    interactive: "/mode <chat|work>",
  }),
  Object.freeze({
    name: "model",
    description: "Choose or show the model",
    interactive: "/model [id]",
  }),
  Object.freeze({
    name: "agent",
    description: "Choose or show the agent",
    interactive: "/agent [id]",
  }),
  Object.freeze({
    name: "resume",
    description: "Resume a durable run or a saved conversation",
    cli: "resume <runId> [--json]",
    interactive: "/resume [id]",
  }),
  Object.freeze({
    name: "retry",
    description: "Retry the last prompt or a durable run",
    cli: "retry <runId> [--follow] [--json]",
    interactive: "/retry",
  }),
  Object.freeze({
    name: "cancel",
    description: "Cancel the active response, run or task",
    cli: "cancel <runId|taskId> [--task] [--json]",
    interactive: "/cancel",
  }),
  Object.freeze({
    name: "clear",
    description: "Clear the current input",
    interactive: "/clear",
  }),
  Object.freeze({
    name: "new",
    description: "Start a new conversation",
    interactive: "/new",
  }),
  Object.freeze({
    name: "history",
    description: "Manage prompt history",
    cli: "history [list|clear|on|off|retention <days>] [--json]",
    interactive: "/history [clear|on|off]",
  }),
  Object.freeze({
    name: "permissions",
    description: "Show session permission grants",
    interactive: "/permissions",
  }),
  Object.freeze({
    name: "status",
    description: "Show session transport and settings",
    cli: "status [--json]",
    interactive: "/status",
  }),
  Object.freeze({
    name: "quit",
    description: "Leave the interactive session",
    interactive: "/quit",
  }),

  // Non-interactive command surface.
  Object.freeze({
    name: "login",
    description: "Verify the owner role, then store the token securely",
    cli: "login [--token-file <path>] [--json]",
  }),
  Object.freeze({
    name: "logout",
    description: "Remove the stored owner credential",
    cli: "logout [--json]",
  }),
  Object.freeze({
    name: "whoami",
    description: "Verify the authenticated owner",
    cli: "whoami [--json]",
  }),
  Object.freeze({
    name: "chat",
    description: "Stream one Chat turn, or start the interactive terminal",
    cli: "chat [message] [--model <id>] [--agent <id>] [--conversation <id>] [--new] [--json]",
  }),
  Object.freeze({
    name: "work",
    description: "Stream one Work turn, submit a durable build, or start the terminal",
    cli: "work [message] [--model <id>] [--agent <id>] [--json]",
  }),
  Object.freeze({
    name: "engine",
    description: "Use the WorkflowEngine task and event tools",
    cli: "engine <command> [--json]",
  }),
  Object.freeze({
    name: "v1",
    description: "Canonical WorkflowEngine /v1 operations",
    cli: "v1 <health|models|agents|chat|submit|task|watch|tasks|cancel|resume|retry|resolve|notifications|conversations|permissions|templates> [--json]",
  }),
  Object.freeze({
    name: "tasks",
    description: "List or inspect durable Work conversations",
    cli: "tasks [taskId] [--json]",
  }),
  Object.freeze({
    name: "workflows",
    description: "List workflows published by the deployment",
    cli: "workflows [--json]",
  }),
  Object.freeze({
    name: "runs",
    description: "List runs for a workflow",
    cli: "runs --workflow <id> [--json]",
  }),
  Object.freeze({
    name: "run",
    description: "Monitor a durable run, approvals, and notifications",
    cli: "run <runId> [--no-follow] [--approval ask|allow|deny] [--notify] [--json]",
  }),
  Object.freeze({
    name: "approve",
    description: "Approve one paused workflow step",
    cli: "approve <runId> <stepIndex> [--json]",
  }),
  Object.freeze({
    name: "repos",
    description: "List repositories the owner can target",
    cli: "repos [--json]",
  }),
  Object.freeze({
    name: "agents",
    description: "List agents discovered from the deployment",
    cli: "agents [--work] [--json]",
  }),
  Object.freeze({
    name: "models",
    description: "List models discovered from the deployment",
    cli: "models [--work] [--json]",
  }),
  Object.freeze({
    name: "config",
    description: "Show, read, or write deployment settings",
    cli: "config show|list|get|set [--json]",
  }),
  Object.freeze({
    name: "health",
    description: "Probe the deployment health endpoint",
    cli: "health [--json]",
  }),
  Object.freeze({
    name: "openapi",
    description: "Summarize the deployment OpenAPI document",
    cli: "openapi [--json]",
  }),
  Object.freeze({
    name: "call",
    description: "Call one documented deployment endpoint",
    cli: "call <METHOD> <PATH> [--data <json>] [--json]",
  }),
  Object.freeze({
    name: "products",
    description: "Show the canonical product registry",
    cli: "products [--json]",
  }),
  Object.freeze({
    name: "cloud",
    description: "Show owner cloud access information",
    cli: "cloud [--json]",
  }),
  Object.freeze({
    name: "projects",
    description: "List projects known to the owner account",
    cli: "projects [--json]",
  }),
  Object.freeze({
    name: "doctor",
    description: "Diagnose install, transport, storage, and compatibility",
    cli: "doctor [--json]",
  }),
  Object.freeze({
    name: "diagnostics",
    description: "Alias for doctor",
    cli: "diagnostics [--json]",
  }),
  Object.freeze({
    name: "update",
    description: "Explain how to update this installation",
    cli: "update [--json]",
  }),
  Object.freeze({
    name: "compat",
    description: "Check the deployment compatibility contract",
    cli: "compat [--json]",
  }),
  Object.freeze({
    name: "uninstall",
    description: "Remove local user data; never runs automatically",
    cli: "uninstall [--yes] [--dry-run] [--purge] [--json]",
  }),
  Object.freeze({
    name: "cleanup",
    description: "Alias for uninstall",
    cli: "cleanup [--yes] [--dry-run] [--purge] [--json]",
  }),
  Object.freeze({
    name: "version",
    description: "Report the installed version and compatibility contract",
    cli: "version [--json]",
  }),
]);

/** Names the top-level CLI dispatcher accepts. */
export const CLI_COMMAND_NAMES = Object.freeze(
  COMMANDS.filter((command) => command.cli !== undefined).map((command) => command.name),
);

/** Entries the interactive terminal completes and documents. */
export const INTERACTIVE_COMMANDS = Object.freeze(
  COMMANDS.filter((command) => command.interactive !== undefined),
);

export function commandByName(name) {
  return COMMANDS.find((command) => command.name === name) ?? null;
}
