/**
 * The single command registry. Validation, help completion and shell
 * completion all read these lists; do not add a command to a second array.
 */
export const COMMANDS = Object.freeze([
  "chat",
  "work",
  "sessions",
  "agents",
  "models",
  "notifications",
  "permissions",
  "login",
  "logout",
  "status",
  "auth",
  "engine",
  "doctor",
  "config",
  "completion",
  "legacy",
  "compat",
  "uninstall",
  "cleanup",
  "products",
  "cloud",
  "projects",
  "update",
  "deploy",
  "health",
  "openapi",
  "call",
  "help",
  "version",
]);

export const WORK_SUBCOMMANDS = Object.freeze([
  "run",
  "submit",
  "list",
  "status",
  "watch",
  "attach",
  "report",
  "cancel",
  "resume",
  "retry",
  "resolve",
  "uncertain",
  "templates",
]);

export const ENGINE_ACTIONS = Object.freeze([
  "health",
  "ready",
  "contract",
  "capabilities",
  "agents",
  "models",
]);

export const CONFIG_ACTIONS = Object.freeze(["show", "list", "get", "set", "unset", "path"]);

export const SESSIONS_ACTIONS = Object.freeze(["list", "show", "switch", "new", "current"]);

export const DEPLOY_ACTIONS = Object.freeze(["health", "openapi", "agents", "models", "call"]);

export const PERMISSIONS_ACTIONS = Object.freeze(["list", "decide"]);

export const COMPLETION_SHELLS = Object.freeze(["bash", "zsh", "fish"]);
