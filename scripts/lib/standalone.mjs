/**
 * The CLI is a cloud client. Installing it must not bring local inference, a
 * database driver, a background daemon, Docker or Ollama. These checks are
 * deliberately structural: a new runtime dependency or a spawn/server import
 * fails the build instead of being noticed after release.
 */

export const FORBIDDEN_MODULES = new Set([
  "child_process",
  "node:child_process",
  "cluster",
  "node:cluster",
  "dgram",
  "node:dgram",
  "net",
  "node:net",
  "http",
  "node:http",
  "https",
  "node:https",
  "http2",
  "node:http2",
  "node:sqlite",
  "node:worker_threads",
]);

export const FORBIDDEN_PACKAGES = [
  "dockerode",
  "docker-compose",
  "ollama",
  "ollama-js",
  "node-llama-cpp",
  "llama-node",
  "onnxruntime-node",
  "@xenova/transformers",
  "tensorflow",
  "@tensorflow/tfjs-node",
  "better-sqlite3",
  "sqlite3",
  "pg",
  "mysql2",
  "mongodb",
  "mongoose",
  "redis",
  "ioredis",
  "express",
  "fastify",
  "koa",
  "openai",
  "@anthropic-ai/sdk",
  "electron",
  "pm2",
  "node-cron",
  "bullmq",
];

const LIFECYCLE_SCRIPTS = ["preinstall", "install", "postinstall", "prepare", "prepack", "postpack"];

function importSpecifiers(source) {
  const specifiers = new Set();
  const patterns = [
    /(?:^|\n)\s*import\s+(?:[^'"]*?\s+from\s+)?["']([^"']+)["']/g,
    /(?:^|\n)\s*export\s+[^'"]*?\s+from\s+["']([^"']+)["']/g,
    /\brequire\(\s*["']([^"']+)["']\s*\)/g,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.add(match[1]);
  }
  return specifiers;
}

function checkDependencies(deps, kind, add) {
  for (const name of Object.keys(deps ?? {})) {
    add("RUNTIME_DEPENDENCY", `${kind} declares "${name}"; the CLI must stay dependency-free`);
  }
}

export function checkIsolation({ packageJson, lockfile, sources }) {
  const violations = [];
  const add = (code, message) => violations.push({ code, message });

  checkDependencies(packageJson?.dependencies, "dependencies", add);
  checkDependencies(packageJson?.devDependencies, "devDependencies", add);
  checkDependencies(packageJson?.optionalDependencies, "optionalDependencies", add);
  checkDependencies(packageJson?.peerDependencies, "peerDependencies", add);

  for (const script of LIFECYCLE_SCRIPTS) {
    if (packageJson?.scripts?.[script]) {
      add("INSTALL_SCRIPT", `package.json defines a "${script}" script; installing must not run code`);
    }
  }

  const bins = Object.keys(packageJson?.bin ?? {});
  if (bins.length !== 1 || bins[0] !== "coderax") {
    add("UNEXPECTED_BIN", `package.json must expose exactly the coderax bin, found ${JSON.stringify(bins)}`);
  }

  const packages = Object.entries(lockfile?.packages ?? {}).filter(([key]) => key !== "");
  for (const [path, entry] of packages) {
    if (entry?.hasInstallScript) add("INSTALL_SCRIPT", `${path} runs an install script`);
    if (entry?.dev === false || entry?.optional === false) {
      add("RUNTIME_DEPENDENCY", `${path} is a locked runtime dependency`);
    }
  }
  if (lockfile && lockfile.lockfileVersion !== 3) {
    add("LOCKFILE_STALE", `lockfileVersion is ${lockfile.lockfileVersion}; use lockfileVersion 3`);
  }

  for (const source of sources ?? []) {
    for (const specifier of importSpecifiers(source.text)) {
      if (FORBIDDEN_MODULES.has(specifier)) {
        add("LOCAL_EXECUTION_SURFACE", `${source.path} imports ${specifier}, which can run local services or processes`);
      }
      if (FORBIDDEN_PACKAGES.includes(specifier)) {
        add("LOCAL_EXECUTION_SURFACE", `${source.path} imports ${specifier}, which is not allowed in a cloud client`);
      }
      if (!specifier.startsWith("./") && !specifier.startsWith("../") && !specifier.startsWith("node:")) {
        add("UNEXPECTED_IMPORT", `${source.path} imports "${specifier}"; only relative and node: builtins are allowed`);
      }
    }
    if (/\bcreateServer\s*\(|\b\.listen\s*\(/.test(source.text)) {
      add("BACKGROUND_SERVICE", `${source.path} starts a server; execution workloads must stay cloud-hosted`);
    }
  }

  return violations;
}

/** Prove the gate is not vacuous: each fixture must produce its violation. */
export function fixtures() {
  return [
    {
      name: "runtime dependency",
      input: {
        packageJson: { dependencies: { ollama: "1.0.0" }, bin: { coderax: "src/cli.js" } },
        lockfile: { lockfileVersion: 3, packages: {} },
        sources: [],
      },
      expect: "RUNTIME_DEPENDENCY",
    },
    {
      name: "install script",
      input: {
        packageJson: { scripts: { postinstall: "node setup.js" }, bin: { coderax: "src/cli.js" } },
        lockfile: { lockfileVersion: 3, packages: {} },
        sources: [],
      },
      expect: "INSTALL_SCRIPT",
    },
    {
      name: "process spawn",
      input: {
        packageJson: { bin: { coderax: "src/cli.js" } },
        lockfile: { lockfileVersion: 3, packages: {} },
        sources: [{ path: "src/x.js", text: "import { spawn } from \"node:child_process\";\n" }],
      },
      expect: "LOCAL_EXECUTION_SURFACE",
    },
    {
      name: "background server",
      input: {
        packageJson: { bin: { coderax: "src/cli.js" } },
        lockfile: { lockfileVersion: 3, packages: {} },
        sources: [{ path: "src/x.js", text: "export const start = () => server.listen(3000);\n" }],
      },
      expect: "BACKGROUND_SERVICE",
    },
    {
      name: "locked install script",
      input: {
        packageJson: { bin: { coderax: "src/cli.js" } },
        lockfile: { lockfileVersion: 3, packages: { "node_modules/agent": { hasInstallScript: true } } },
        sources: [],
      },
      expect: "INSTALL_SCRIPT",
    },
  ];
}
