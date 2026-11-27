/** Slash commands completed and documented by the interactive terminal. */

/**
 * @typedef {object} CommandEntry
 * @property {string} name stable identifier used by the dispatcher
 * @property {string} description one-line human description
 * @property {string} interactive usage line for the interactive terminal
 */

/** @type {ReadonlyArray<CommandEntry>} */
export const INTERACTIVE_COMMANDS = Object.freeze([
  Object.freeze({
    name: "help",
    description: "Show keys and commands",
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
    interactive: "/resume [id]",
  }),
  Object.freeze({
    name: "retry",
    description: "Retry the last prompt or a durable run",
    interactive: "/retry",
  }),
  Object.freeze({
    name: "cancel",
    description: "Cancel the active response, run or task",
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
    interactive: "/status",
  }),
  Object.freeze({
    name: "quit",
    description: "Leave the interactive session",
    interactive: "/quit",
  }),

]);
