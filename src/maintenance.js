/**
 * Uninstallation and cleanup.
 *
 * The command removes user data only. Removing the program itself is left to
 * the tool that installed it (npm, the standalone installer, or the repository
 * checkout), because a process deleting the tree it is currently executing from
 * is unreliable on Windows and unnecessary everywhere else.
 */
import { rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { EXIT } from "./product-commands.js";
import { credentialAccount, deleteCredential } from "./credentials.js";
import { PACKAGE_NAME } from "./version.js";

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function globalNpmPrefix(path) {
  if (!path || !isAbsolute(path) || basename(path) !== PACKAGE_NAME) return null;
  const modules = dirname(path);
  if (basename(modules) !== "node_modules") return null;

  const parent = dirname(modules);
  const windows = process.platform === "win32";
  // npm uses <prefix>/node_modules on Windows and <prefix>/lib/node_modules
  // elsewhere. Other managers' global layouts may not have an npm prefix.
  if (!windows && basename(parent) !== "lib") return null;
  const prefix = windows ? parent.replaceAll("\\", "/") : dirname(parent);
  // Use forward slashes on Windows so a drive root cannot escape the closing
  // quote. Only emit commands for paths safe inside quotes across shells.
  if (windows && !/^[a-z]:\//i.test(prefix)) return null;
  // `~` covers Windows 8.3 short names (C:/Users/RUNNER~1/...), which appear in
  // temporary and profile paths. It is literal inside double quotes in both
  // cmd.exe and POSIX sh, so it does not need rejecting.
  return /^[\p{L}\p{M}\p{N} /:~._-]+$/u.test(prefix) ? prefix : null;
}

/** Instructions that remove the program, per installation method. */
export function programRemovalCommands(install) {
  const path = install.installPath;
  switch (install.installMethod) {
    case "npm-global": {
      const prefix = globalNpmPrefix(path);
      return prefix
        ? [`npm uninstall --global --prefix "${prefix}" ${PACKAGE_NAME}`]
        : ["Verify the npm prefix for the installPath shown by coderax version --json before removing this copy."];
    }
    case "npm-local":
      return ["npm uninstall coderax-cli"];
    case "standalone":
      return [
        `sh "${path}/uninstall.sh" --prefix "${dirname(path)}" --bin-dir "<launcher directory>"`,
      ];
    default:
      return [`Remove the checkout at ${path}`];
  }
}

/**
 * Refuse paths that are obviously not ours to delete. A typo in CODERAX_CONFIG
 * must not be able to remove a home directory.
 */
function isUnsafeTarget(path) {
  const target = resolve(path);
  const root = resolve("/");
  return target === root || target === resolve(homedir()) || target === dirname(root);
}

export async function uninstall(ctx) {
  const dryRun = !(ctx.flags.has("yes") || ctx.flags.has("purge"));
  const configuredFile = ctx.env.CODERAX_CONFIG?.trim();
  // With CODERAX_CONFIG set the operator owns the file location; otherwise the
  // whole CLI-owned directory is user data and can go.
  const target = configuredFile ? ctx.settings.configPath : dirname(ctx.settings.configPath);

  const present = (await exists(target)) && !isUnsafeTarget(target);
  const payload = {
    dryRun,
    target,
    exists: present,
    removed: false,
    program: {
      installMethod: ctx.install.installMethod,
      installPath: ctx.install.installPath,
      commands: programRemovalCommands(ctx.install),
    },
    retained: [
      "Deployment-side data: conversations, agents, and Work runs live in the Coderax deployment, not on this machine.",
    ],
  };

  if (dryRun) {
    const lines = [
      `coderax uninstall: dry run (nothing was removed)`,
      `user data: ${target}${present ? "" : " (already absent)"}`,
      "the program itself is removed by its installer:",
      ...payload.program.commands.map((command) => `  ${command}`),
      "re-run with --yes to remove the user data above",
    ];
    ctx.out(ctx.json ? JSON.stringify(payload, null, 2) : `${lines.join("\n")}\n`);
    return EXIT.OK;
  }

  if (present) {
    await rm(target, { recursive: true, force: true });
    payload.removed = true;
  }

  // The Windows DPAPI credential lives under APPDATA, not beside the config
  // file, so removing the config directory alone would leave it behind.
  // --purge is the explicit request to delete the stored owner credential.
  if (ctx.flags.has("purge")) {
    if (ctx.credentialStore?.available && ctx.settings.baseUrl) {
      await ctx.credentialStore.delete(credentialAccount(ctx.settings.baseUrl));
    }
    await deleteCredential({
      backend: ctx.settings.tokenStore ?? "file",
      account: ctx.settings.account ?? null,
      env: ctx.env,
    });
    payload.credentialRemoved = true;
  }

  const message = present
    ? `Removed ${target}.`
    : `Nothing to remove at ${target}.`;
  ctx.out(
    ctx.json
      ? JSON.stringify(payload, null, 2)
      : `${message}\nRemove the program with:\n${payload.program.commands.map((command) => `  ${command}`).join("\n")}\n`,
  );
  return EXIT.OK;
}
