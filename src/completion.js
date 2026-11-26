import { CAPABILITY_FAMILIES } from "./capability-catalog.js";
import { VERSION } from "./version.js";

/**
 * Shell completion generated from the same catalogue the CLI dispatches.
 *
 * The command list is the CLI's authoritative dispatch set, and the capability
 * descriptions come from the capability catalogue, so a command cannot exist
 * without appearing in completion and a removed command cannot linger. The
 * scripts only name commands and options; they never contact the engine, so a
 * completion never reveals whether a deployment is reachable or authorized.
 *
 * Installing these files is the release pipeline's job (`scripts/build-release`,
 * `docs/INSTALL.md`); this command only prints the script.
 */

export const SHELLS = Object.freeze(["bash", "zsh", "fish"]);

const OPTION_WORDS = Object.freeze([
  "--json",
  "--help",
  "--version",
  "--base-url",
  "--token",
  "--timeout",
  "--out",
  "--force",
  "--task",
  "--file",
  "--question",
  "--no-wait",
  "--wait-timeout",
  "--stream",
  "--agent",
  "--model",
  "--conversation",
  "--at",
  "--every",
  "--reason",
]);

function quote(value) {
  return String(value).replace(/'/g, "'\\''");
}

function zshQuote(value) {
  return String(value).replace(/'/g, "'\\''").replace(/:/g, "\\:");
}

function sorted(values) {
  return [...new Set(values)].sort();
}

export function completionScript(shell, commands) {
  const commandList = sorted(commands);
  const commandWords = commandList.join(" ");

  if (shell === "bash") {
    return `# coderax ${VERSION} bash completion
_coderax_complete() {
  local cur
  cur="\${COMP_WORDS[COMP_CWORD]}"
  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "${commandWords}" -- "$cur") )
    return 0
  fi
  COMPREPLY=( $(compgen -W "${OPTION_WORDS.join(" ")}" -- "$cur") )
  return 0
}
complete -F _coderax_complete coderax
`;
  }

  if (shell === "zsh") {
    const described = CAPABILITY_FAMILIES.filter((entry) => commandList.includes(entry.command))
      .map((entry) => `    '${zshQuote(entry.command)}:${zshQuote(entry.title)}'`)
      .join("\n");
    const plain = commandList
      .filter((command) => !CAPABILITY_FAMILIES.some((entry) => entry.command === command))
      .map((command) => `    '${zshQuote(command)}'`)
      .join("\n");
    return `#compdef coderax
# coderax ${VERSION} zsh completion
_coderax() {
  local -a commands
  commands=(
${[plain, described].filter(Boolean).join("\n")}
  )
  if (( CURRENT == 2 )); then
    _describe 'command' commands
    return
  fi
  _arguments '*: :->args'
}
_coderax "$@"
`;
  }

  if (shell === "fish") {
    const lines = commandList.map((command) => {
      const entry = CAPABILITY_FAMILIES.find((family) => family.command === command);
      const description = entry ? ` -d '${quote(entry.title)}'` : "";
      return `complete -c coderax -f -n "__fish_use_subcommand" -a "${quote(command)}"${description}`;
    });
    return `# coderax ${VERSION} fish completion
${lines.join("\n")}
complete -c coderax -f -n "not __fish_use_subcommand" -a "${OPTION_WORDS.join(" ")}"
`;
  }

  throw Object.assign(new Error(`unsupported shell: ${String(shell)}`), { code: "USAGE" });
}
