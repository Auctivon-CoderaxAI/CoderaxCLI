/**
 * The authoritative command registry.
 *
 * The parser's whitelist, the help screen and every generated shell completion
 * are derived from this table. Adding a command or flag here is the only step
 * needed; `test/completion.test.js` fails if the completion scripts and the
 * parser disagree with the registry.
 */
export const COMMANDS = Object.freeze([
  ["login", "Verify the owner role, then store the token"],
  ["logout", "Remove the stored token"],
  ["whoami", "Show the authenticated account and role"],
  ["status", "Show configuration, authentication and owner state"],
  ["chat", "Interactive chat over streaming SSE"],
  ["work", "Run or submit an autonomous Work request"],
  ["tasks", "List durable Work tasks or show one task"],
  ["engine", "Durable task control on the WorkflowEngine /v1 contract"],
  ["workflows", "List workflows"],
  ["runs", "List runs for a workflow"],
  ["run", "Follow or show one run"],
  ["cancel", "Cancel a run or a Work task"],
  ["resume", "Resume a paused run"],
  ["retry", "Retry a failed run"],
  ["approve", "Approve or deny a run step"],
  ["repos", "List repositories advertised by the deployment"],
  ["agents", "List agents, or Work-eligible agents with --work"],
  ["models", "List models, or Work-eligible models with --work"],
  ["doctor", "Diagnose install, owner auth, API version and capabilities"],
  ["diagnostics", "Alias for doctor"],
  ["health", "Probe deployment health endpoints"],
  ["openapi", "List operations from the OpenAPI document"],
  ["call", "Issue an authenticated request"],
  ["products", "Show the five-product status"],
  ["cloud", "Show Coderax Cloud status"],
  ["projects", "Show Cloud projects"],
  ["update", "Check the release feed and print upgrade commands"],
  ["version", "Show version, install and API contract details"],
  ["compat", "Check the deployment API version and capabilities"],
  ["config", "Show or change configuration"],
  ["uninstall", "Remove stored credentials, optionally the config"],
  ["cleanup", "Alias for uninstall"],
  ["completion", "Print a shell completion script"],
  ["help", "Show help"],
].map(([name, summary]) => Object.freeze({ name, summary })));

/** Subcommands that are dispatched by their parent command. */
export const SUBCOMMANDS = Object.freeze({
  config: Object.freeze(["show", "list", "get", "set"]),
  work: Object.freeze(["submit"]),
  engine: Object.freeze([
    "status",
    "handshake",
    "submit",
    "tasks",
    "task",
    "events",
    "cancel",
    "resume",
    "retry",
    "permissions",
    "approve",
    "deny",
    "notifications",
    "ack",
    "reconcile",
  ]),
  completion: Object.freeze(["bash", "zsh", "fish", "powershell"]),
});

/**
 * Flags: name without dashes, help text, and whether a value follows.
 * `BOOLEAN_FLAGS` decides whether the parser consumes the next argument.
 */
export const FLAGS = Object.freeze([
  ["help", "Show help", false],
  ["version", "Show the version", false],
  ["json", "Machine-readable output", false],
  ["base-url", "Deployment URL", true],
  ["token", "Bearer token", true],
  ["timeout", "Request timeout in milliseconds", true],
  ["model", "Model id", true],
  ["agent", "Agent id", true],
  ["endpoint", "Chat endpoint name", true],
  ["chat-path", "Streaming path", true],
  ["url", "Streaming path for one invocation", true],
  ["data", "JSON body for call", true],
  ["conversation", "Continue a specific conversation", true],
  ["new", "Start a new conversation", false],
  ["repo", "Repository as owner/name", true],
  ["base-ref", "Base git ref for an autonomous build", true],
  ["mode", "Build mode: turbo15, autonomous or verified", true],
  ["workspace", "Workspace name", true],
  ["follow", "Follow a run after starting it", false],
  ["detach", "Start a run without following it", false],
  ["no-follow", "Do not follow the run", false],
  ["approval", "Approval policy: ask, allow or deny", true],
  ["workflow", "Workflow id", true],
  ["task", "Treat the identifier as a Work task", false],
  ["notify", "Desktop notification when a run finishes", false],
  ["notify-command", "Command to run when a run finishes", true],
  ["cancel-on-interrupt", "Cancel the remote run on Ctrl-C", false],
  ["strict", "Fail on unverified API version or missing capabilities", false],
  ["max-retries", "Reconnect attempts for run monitoring (0-10)", true],
  ["work", "Use Work-eligible agent or model routes", false],
  ["yes", "Confirm uninstall", false],
  ["dry-run", "Preview uninstall", false],
  ["purge", "Also remove stored credentials with uninstall", false],
  ["no-color", "Accepted for compatibility", false],
  ["after", "Replay events strictly after this sequence", true],
  ["generation", "Task generation for resume or retry", true],
  ["idempotency-key", "Caller-chosen key that makes a Work submission safe to reconcile", true],
  ["resume-key", "Reconcile a recorded submission without creating a second task", true],
  ["state", "Filter tasks by state", true],
  ["limit", "Maximum rows to return", true],
  ["reason", "Reason for a cancellation or permission decision", true],
  ["environment", "Advisory state environment label (default: derived)", true],
].map(([name, summary, takesValue]) => Object.freeze({ name, summary, takesValue })));

export const COMMAND_NAMES = new Set(COMMANDS.map((command) => command.name));
export const FLAG_NAMES = new Set(FLAGS.map((flag) => flag.name));
export const BOOLEAN_FLAG_NAMES = new Set(FLAGS.filter((flag) => !flag.takesValue).map((flag) => flag.name));
export const VALUE_FLAG_NAMES = new Set(FLAGS.filter((flag) => flag.takesValue).map((flag) => flag.name));
