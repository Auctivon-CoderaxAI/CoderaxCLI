/**
 * Slash-command completion.
 *
 * Completion is intentionally limited to commands and selection values: file
 * completion would enumerate the user's filesystem, including sensitive files,
 * without the explicit authorisation that attachments require.
 */

import { INTERACTIVE_COMMANDS } from "../commands.js";

const MAX_OPTIONS = 50;

// Derived from the canonical catalogue: the terminal never keeps a second
// command list that can drift from the CLI's dispatch table.
export const COMMANDS = Object.freeze(
  INTERACTIVE_COMMANDS.map((command) => ({
    name: command.name,
    usage: command.interactive,
    description: command.description,
  })),
);

function dedupe(options) {
  const seen = new Set();
  const output = [];
  for (const option of options) {
    if (seen.has(option.value)) continue;
    seen.add(option.value);
    output.push(option);
  }
  return output;
}

function fromStrings(values, description) {
  return dedupe(
    values
      .map((value) => (typeof value === "string" ? value : value?.id ?? value?.name ?? ""))
      .filter(Boolean)
      .map((value) => ({ value: String(value), description })),
  ).slice(0, MAX_OPTIONS);
}

/**
 * @returns {{start:number,end:number,options:Array<{value:string,description?:string}>,kind:string}|null}
 */
export function complete(input, cursor, context = {}) {
  const text = String(input ?? "");
  const position = Math.max(0, Math.min(cursor ?? text.length, text.length));
  const before = text.slice(0, position);

  if (!before.startsWith("/")) return null;

  const space = before.indexOf(" ");
  if (space === -1) {
    const prefix = before.slice(1).toLowerCase();
    const options = COMMANDS.filter((command) => command.name.startsWith(prefix)).map((command) => ({
      value: command.name,
      description: command.description,
    }));
    // Keep the leading slash: the option values are command names only.
    return { start: 1, end: position, options: options.slice(0, MAX_OPTIONS), kind: "command" };
  }

  const command = before.slice(1, space).toLowerCase();
  const argumentStart = space + 1;
  const argument = before.slice(argumentStart);
  if (argument.includes(" ")) return null;

  let options = [];
  let kind = command;
  if (command === "mode") {
    options = fromStrings(["chat", "work"], "Mode").filter((option) => option.value.startsWith(argument.toLowerCase()));
  } else if (command === "model") {
    options = fromStrings(context.models ?? [], "Model").filter((option) =>
      option.value.toLowerCase().startsWith(argument.toLowerCase()),
    );
  } else if (command === "agent") {
    options = fromStrings(context.agents ?? [], "Agent").filter((option) =>
      option.value.toLowerCase().startsWith(argument.toLowerCase()),
    );
  } else if (command === "resume") {
    options = (context.conversations ?? [])
      .map((conversation) => ({
        value: conversation.id,
        description: `${conversation.mode ?? "chat"}${conversation.title ? ` \u00b7 ${conversation.title}` : ""}`,
      }))
      .filter((option) => option.value.startsWith(argument))
      .slice(0, MAX_OPTIONS);
  } else if (command === "history") {
    options = fromStrings(["clear", "on", "off"], "History").filter((option) =>
      option.value.startsWith(argument.toLowerCase()),
    );
  } else {
    return null;
  }

  if (options.length === 0) return null;
  return { start: argumentStart, end: position, options, kind };
}

/** Replace the completed range with one option. */
export function applyCompletion(input, cursor, completion, value) {
  if (!completion) return { text: String(input ?? ""), cursor: cursor ?? String(input ?? "").length };
  const text = String(input ?? "");
  const selected = value ?? completion.options[0]?.value ?? "";
  const next = `${text.slice(0, completion.start)}${selected}${text.slice(completion.end)}`;
  return { text: next, cursor: completion.start + selected.length };
}

/** Command help grouped for the `/help` output. */
export function commandHelp() {
  return COMMANDS.map((command) => ({
    usage: command.usage,
    description: command.description,
  }));
}
