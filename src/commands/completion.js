import { UsageError } from "../errors.js";

export const COMMANDS = Object.freeze([
  "chat", "work", "sessions", "agents", "models", "notifications", "permissions",
  "login", "logout", "status", "engine", "doctor", "config", "completion",
  "products", "cloud", "projects", "update", "deploy", "help", "version",
]);

const WORK_SUBCOMMANDS = Object.freeze([
  "submit", "list", "status", "watch", "attach", "report", "cancel", "resume",
  "retry", "resolve", "uncertain", "templates",
]);

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
    engine) COMPREPLY=( $(compgen -W "health ready contract capabilities ${words(GLOBAL_FLAGS)}" -- "\${current}") ); return 0 ;;
    config) COMPREPLY=( $(compgen -W "show get set unset path ${words(GLOBAL_FLAGS)}" -- "\${current}") ); return 0 ;;
    completion) COMPREPLY=( $(compgen -W "bash zsh fish" -- "\${current}") ); return 0 ;;
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
    engine) _values 'engine command' health ready contract capabilities ;;
    config) _values 'config command' show get set unset path ;;
    completion) _values 'shell' bash zsh fish ;;
  esac
}
_coderax "$@"
`;
    case "fish":
      return `# fish completion for coderax
complete -c coderax -f -a "${words(COMMANDS)}"
complete -c coderax -n "__fish_seen_subcommand_from work" -f -a "${words(WORK_SUBCOMMANDS)}"
complete -c coderax -n "__fish_seen_subcommand_from engine" -f -a "health ready contract capabilities"
complete -c coderax -n "__fish_seen_subcommand_from config" -f -a "show get set unset path"
complete -c coderax -n "__fish_seen_subcommand_from completion" -f -a "bash zsh fish"
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
