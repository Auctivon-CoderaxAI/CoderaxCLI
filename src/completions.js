import { basename } from "node:path";
import { CoderaxError } from "./client.js";
import {
  BUILTIN_COMMANDS,
  COMMAND_SPECS,
  GLOBAL_OPTIONS,
  catalogRoots,
  resolveSurfaceCommand,
} from "./capability-catalog.js";

export const SHELLS = Object.freeze(["bash", "zsh", "fish"]);

const LEGACY_ROOTS = ["chat", "work", "agents", "models", "products", "cloud", "login", "logout", "status", "config", "doctor", "update", "health", "openapi", "call", "completion", "version", "help"];

function rootSummaries() {
  const entries = new Map();
  for (const builtin of BUILTIN_COMMANDS) {
    entries.set(builtin.command, builtin.summary);
  }
  for (const spec of COMMAND_SPECS) {
    const root = spec.path[0];
    if (!entries.has(root)) entries.set(root, spec.summary);
  }
  for (const root of catalogRoots()) {
    const resolved = resolveSurfaceCommand([root]);
    if (resolved?.spec) entries.set(root, resolved.spec.summary);
  }
  const roots = new Set(catalogRoots());
  return [...entries.entries()]
    .filter(([name]) => LEGACY_ROOTS.includes(name) || roots.has(name))
    .sort(([a], [b]) => a.localeCompare(b));
}

function actionsFor(root) {
  const actions = new Set();
  for (const spec of COMMAND_SPECS) {
    if (spec.path[0] !== root) continue;
    if (spec.path[1]) actions.add(spec.path[1]);
    for (const alias of spec.aliases ?? []) {
      if (alias[0] === root && alias[1]) actions.add(alias[1]);
    }
  }
  return [...actions].sort();
}

function bashScript() {
  const roots = rootSummaries();
  const cases = roots
    .map(([root]) => [root, actionsFor(root)])
    .filter(([, actions]) => actions.length > 0)
    .map(([root, actions]) => `    ${root}) opts="${actions.join(" ")}" ;;`)
    .join("\n");

  return `# coderax bash completion
# Install: coderax completion bash > /etc/bash_completion.d/coderax
_coderax() {
  local cur root opts
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  root="\${COMP_WORDS[1]}"

  if [ "\${COMP_CWORD}" -eq 1 ]; then
    COMPREPLY=( \$(compgen -W "${roots.map(([root]) => root).join(" ")}" -- "\$cur") )
    return 0
  fi

  case "\$cur" in
    -*)
      COMPREPLY=( \$(compgen -W "${[...new Set(GLOBAL_OPTIONS)].sort().join(" ")}" -- "\$cur") )
      return 0
      ;;
  esac

  if [ "\${COMP_CWORD}" -eq 2 ]; then
    case "\$root" in
${cases}
      *) opts="" ;;
    esac
    if [ -n "\$opts" ]; then
      COMPREPLY=( \$(compgen -W "\$opts" -- "\$cur") )
      return 0
    fi
  fi

  COMPREPLY=( \$(compgen -f -- "\$cur") )
  return 0
}
complete -F _coderax coderax
`;
}

function zshScript() {
  const roots = rootSummaries();
  const rootList = roots.map(([root, summary]) => `    '${root}:${summary.replace(/'/g, "'\\''")}'`).join("\n");
  const cases = roots
    .map(([root]) => [root, actionsFor(root)])
    .filter(([, actions]) => actions.length > 0)
    .map(([root, actions]) => `    ${root}) _values 'action' ${actions.map((action) => `'${action}'`).join(" ")} ;;`)
    .join("\n");

  return `#compdef coderax
# Install: coderax completion zsh > "\${fpath[1]}/_coderax"
_coderax() {
  local -a commands
  commands=(
${rootList}
  )

  if (( CURRENT == 2 )); then
    _describe 'command' commands
    return
  fi

  if (( CURRENT == 3 )); then
    case "\$words[2]" in
${cases}
      *) ;;
    esac
    return
  fi

  _files
}

_coderax "$@"
`;
}

function fishScript() {
  const roots = rootSummaries();
  const rootLines = roots.map(([root, summary]) =>
    `complete -c coderax -n '__fish_use_subcommand' -a '${root}' -d '${summary.replace(/'/g, "\\'")}'`,
  );
  const actionLines = roots
    .map(([root]) => [root, actionsFor(root)])
    .filter(([, actions]) => actions.length > 0)
    .map(([root, actions]) =>
      `complete -c coderax -n '__fish_seen_subcommand_from ${root}' -a '${actions.join(" ")}'`,
    );
  const flagLines = [...new Set(GLOBAL_OPTIONS)].sort().map((name) =>
    `complete -c coderax -l ${name}`,
  );

  return [
    "# coderax fish completion",
    "# Install: coderax completion fish > ~/.config/fish/completions/coderax.fish",
    "complete -c coderax -f",
    ...rootLines,
    ...actionLines,
    ...flagLines,
    "",
  ].join("\n");
}

export function completionScript(shell) {
  switch (shell) {
    case "bash":
      return bashScript();
    case "zsh":
      return zshScript();
    case "fish":
      return fishScript();
    default:
      throw new CoderaxError("USAGE", `completion requires one of: ${SHELLS.join(", ")}`);
  }
}

export function detectShell(env = {}) {
  const guess = basename(String(env.SHELL ?? "").trim()).replace(/^-/, "");
  return SHELLS.includes(guess) ? guess : null;
}

export function completionCommand(positionals, ctx) {
  const requested = positionals[1];
  const shell = requested ?? detectShell(ctx.env);
  if (!shell) {
    throw new CoderaxError(
      "USAGE",
      `completion requires a shell: ${SHELLS.join(", ")} (or set $SHELL)`,
    );
  }
  if (!SHELLS.includes(shell)) {
    throw new CoderaxError("USAGE", `unsupported shell: ${shell}. Supported: ${SHELLS.join(", ")}`);
  }
  if (positionals.length > 2) {
    throw new CoderaxError("USAGE", "completion accepts at most one shell argument");
  }

  const script = completionScript(shell);
  if (ctx.json) {
    ctx.out(JSON.stringify({ shell, script }, null, 2));
  } else {
    ctx.out(script);
  }
  return 0;
}
