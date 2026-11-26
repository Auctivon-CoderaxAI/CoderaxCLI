import { UsageError } from "../errors.js";
import {
  COMMANDS,
  COMPLETION_SHELLS,
  CONFIG_ACTIONS,
  ENGINE_ACTIONS,
  SESSIONS_ACTIONS,
  WORK_SUBCOMMANDS,
} from "./registry.js";

export { COMMANDS };

const GLOBAL_FLAGS = Object.freeze([
  "--help", "--version", "--json", "--ndjson", "--no-color", "--quiet", "--verbose",
  "--engine-url", "--base-url", "--token", "--timeout", "--model", "--agent",
  "--conversation", "--config", "--state",
]);

function words(list) {
  return list.join(" ");
}

export function completionScript(shell) {
  switch (shell) {
    case "bash":
      return `# bash completion for coderax
_coderax() {
  local current previous
  current="\${COMP_WORDS[COMP_CWORD]}"
  previous="\${COMP_WORDS[COMP_CWORD-1]}"
  case "\${COMP_WORDS[1]}" in
    work) COMPREPLY=( $(compgen -W "${words(WORK_SUBCOMMANDS)} ${words(GLOBAL_FLAGS)}" -- "\${current}") ); return 0 ;;
    engine) COMPREPLY=( $(compgen -W "${words(ENGINE_ACTIONS)} ${words(GLOBAL_FLAGS)}" -- "\${current}") ); return 0 ;;
    config) COMPREPLY=( $(compgen -W "${words(CONFIG_ACTIONS)} ${words(GLOBAL_FLAGS)}" -- "\${current}") ); return 0 ;;
    sessions) COMPREPLY=( $(compgen -W "${words(SESSIONS_ACTIONS)} ${words(GLOBAL_FLAGS)}" -- "\${current}") ); return 0 ;;
    completion) COMPREPLY=( $(compgen -W "${words(COMPLETION_SHELLS)}" -- "\${current}") ); return 0 ;;
  esac
  COMPREPLY=( $(compgen -W "${words(COMMANDS)} ${words(GLOBAL_FLAGS)}" -- "\${current}") )
}
complete -F _coderax coderax
`;
    case "zsh":
      return `#compdef coderax
_coderax() {
  local -a commands
  commands=(${COMMANDS.map((command) => `'${command}'`).join(" ")})
  if (( CURRENT == 2 )); then
    _describe 'command' commands
    return
  fi
  case "\${words[2]}" in
    work) _values 'work command' ${WORK_SUBCOMMANDS.map((value) => `'${value}'`).join(" ")} ;;
    engine) _values 'engine command' ${ENGINE_ACTIONS.map((value) => `'${value}'`).join(" ")} ;;
    config) _values 'config command' ${CONFIG_ACTIONS.map((value) => `'${value}'`).join(" ")} ;;
    sessions) _values 'sessions command' ${SESSIONS_ACTIONS.map((value) => `'${value}'`).join(" ")} ;;
    completion) _values 'shell' ${COMPLETION_SHELLS.map((value) => `'${value}'`).join(" ")} ;;
  esac
}
_coderax "$@"
`;
    case "fish":
      return `# fish completion for coderax
complete -c coderax -f -a "${words(COMMANDS)}"
complete -c coderax -n "__fish_seen_subcommand_from work" -f -a "${words(WORK_SUBCOMMANDS)}"
complete -c coderax -n "__fish_seen_subcommand_from engine" -f -a "${words(ENGINE_ACTIONS)}"
complete -c coderax -n "__fish_seen_subcommand_from config" -f -a "${words(CONFIG_ACTIONS)}"
complete -c coderax -n "__fish_seen_subcommand_from sessions" -f -a "${words(SESSIONS_ACTIONS)}"
complete -c coderax -n "__fish_seen_subcommand_from completion" -f -a "${words(COMPLETION_SHELLS)}"
`;
    default:
      throw new UsageError("completion requires one of: bash, zsh, fish");
  }
}

export function completionCommand(runtime, positionals) {
  const shell = positionals[0];
  if (!shell) throw new UsageError("completion requires one of: bash, zsh, fish");
  runtime.write(completionScript(shell).trimEnd());
  return 0;
}
