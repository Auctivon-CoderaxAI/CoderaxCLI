#!/usr/bin/env node
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Start the real WorkflowEngine HTTP application from a checkout of
 * `Auctivon-CoderaxAI/Coderax-WorkflowEngine` at the pinned commit and run the
 * CLI's acceptance test against it.
 *
 * Usage:
 *   node scripts/run-engine-acceptance.mjs --engine ../Coderax-WorkflowEngine
 *
 * The engine checkout must already be built (`npm ci && npm run build`). The
 * harness uses the engine's own `startTestApp()`, which composes the production
 * router, service, auth and event streams with a deterministic model gateway.
 * No credential, database or network service is required.
 */

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const engineDir = resolve(argument("--engine") ?? process.env.CODERAX_ENGINE_DIR ?? "");
if (!engineDir) {
  console.error("run-engine-acceptance: pass --engine <path> or CODERAX_ENGINE_DIR");
  process.exit(2);
}

const helpersPath = join(engineDir, "dist/tests/helpers.js");
try {
  await access(helpersPath);
} catch {
  console.error(
    `run-engine-acceptance: ${helpersPath} is missing; run \`npm ci && npm run build\` in the engine checkout`,
  );
  process.exit(2);
}

const helpers = await import(pathToFileURL(helpersPath).href);
const started = await helpers.startTestApp();
console.log(`engine application listening at ${started.url}`);

try {
  const exitCode = await new Promise((resolveExit, reject) => {
    const child = spawn(
      process.execPath,
      ["--test", "test/engine-acceptance.test.js"],
      {
        cwd: resolve(new URL("..", import.meta.url).pathname),
        stdio: "inherit",
        env: {
          ...process.env,
          CODERAX_ENGINE_URL: started.url,
          CODERAX_ENGINE_TOKEN: helpers.OWNER_TOKEN,
        },
      },
    );
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) reject(new Error(`acceptance process terminated by ${signal}`));
      else resolveExit(code ?? 1);
    });
  });
  process.exitCode = exitCode;
} finally {
  await started.close();
}
