/**
 * Version and installation diagnostics.
 *
 * Support engineers and release automation both need the same answer to "what
 * exactly is installed here?". This module derives it from the running module
 * path rather than trusting an environment variable, so a report cannot claim
 * an install method the filesystem contradicts.
 */
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  COMPATIBILITY_BASIS,
  SUPPORTED_API_VERSION,
  SUPPORTED_DEPLOYMENT_RANGE,
} from "./compat.js";
import { configDir, configPath } from "./config.js";
import { NODE_REQUIREMENT, PACKAGE_NAME, VERSION } from "./version.js";

const MODULE_PATH = fileURLToPath(import.meta.url);
export const PACKAGE_ROOT = dirname(dirname(MODULE_PATH));
export const CLI_ENTRYPOINT = dirname(MODULE_PATH) + "/cli.js";

function portable(path) {
  return path.replaceAll("\\", "/");
}

function realpathOrSelf(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * npm can install a package globally or into a project. Both put the code in a
 * `node_modules/coderax-cli` directory; the prefix around it distinguishes them.
 * Package-manager prefixes are matched explicitly so a global install from nvm,
 * Volta, Homebrew, or the Windows npm prefix is not misreported as a project
 * dependency.
 */
const GLOBAL_PREFIX_MARKERS = Object.freeze([
  "/.nvm/versions/node/",
  "/.volta/",
  "/.asdf/",
  "/Cellar/",
  "/Homebrew/",
  "/lib/node_modules/",
  "/AppData/Roaming/npm/",
  "/AppData/Local/Volta/",
  "/pnpm/global/",
  "/yarn/global/",
  "/.bun/install/global/",
]);

export function detectInstallMethod(modulePath = MODULE_PATH) {
  const path = portable(realpathOrSelf(modulePath));
  const packageIndex = path.lastIndexOf(`/node_modules/${PACKAGE_NAME}/`);
  if (packageIndex !== -1) {
    if (GLOBAL_PREFIX_MARKERS.some((marker) => path.includes(marker))) return "npm-global";
    const prefix = path.slice(0, packageIndex + 1);
    const shim = process.platform === "win32" ? "coderax.cmd" : "coderax";
    const localShim = join(prefix, "node_modules", ".bin", shim);
    if (existsSync(localShim)) return "npm-local";

    // POSIX global npm installs match the lib/node_modules marker above.
    // On Windows, a custom global prefix shares the local package layout,
    // but npm puts its global launcher directly in the prefix.
    if (process.platform === "win32" && existsSync(join(prefix, shim))) return "npm-global";
    // npm can install a project dependency with bin-links disabled.
    return "npm-local";
  }
  // The standalone build ships this marker at the package root, so a custom
  // --prefix is recognised without assuming the default ~/.coderax/cli path.
  if (existsSync(join(PACKAGE_ROOT, "install-layout.json"))) return "standalone";
  if (path.includes("/.coderax/cli/")) return "standalone";
  return "source";
}

export function packageRoot() {
  return PACKAGE_ROOT;
}

function nodeMajor() {
  return Number(process.versions.node.split(".")[0]);
}

/**
 * Machine-readable install report. `schemaVersion` lets future tooling add
 * fields without breaking parsers; keys are only ever added, never repurposed.
 */
export function collectVersionInfo({ env = process.env } = {}) {
  const installMethod = detectInstallMethod();
  return {
    schemaVersion: 1,
    cli: "coderax",
    packageName: PACKAGE_NAME,
    cliVersion: VERSION,
    node: process.versions.node,
    nodeRequirement: NODE_REQUIREMENT,
    nodeSupported: nodeMajor() >= 24,
    platform: process.platform,
    arch: process.arch,
    installMethod,
    installPath: PACKAGE_ROOT,
    configPath: configPath(env),
    configDir: configDir(env),
    channel: env.CODERAX_CHANNEL?.trim() || "stable",
    supportedApiVersion: `${SUPPORTED_API_VERSION}.x`,
    supportedDeploymentRange: SUPPORTED_DEPLOYMENT_RANGE,
    compatibilityBasis: COMPATIBILITY_BASIS,
  };
}

/** Human-readable render of `collectVersionInfo`. */
export function formatVersionInfo(info) {
  const lines = [
    `coderax-cli ${info.cliVersion}`,
    `node         ${info.node} (${info.nodeSupported ? "supported" : `requires ${info.nodeRequirement}`})`,
    `platform     ${info.platform}-${info.arch}`,
    `install      ${info.installMethod} (${info.installPath})`,
    `config       ${info.configPath}`,
    `channel      ${info.channel}`,
    `api          ${info.supportedApiVersion}`,
    `deployment   ${info.supportedDeploymentRange}`,
  ];
  return `${lines.join("\n")}\n`;
}
