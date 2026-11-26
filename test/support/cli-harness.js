import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../../src/cli.js";

/** A throwaway working directory and owner settings for one CLI invocation. */
export async function cliWorkspace() {
  return mkdtemp(join(tmpdir(), "coderax-capability-"));
}

/**
 * Run the CLI against a harness over real HTTP. Configuration is supplied by
 * environment only, so no owner config file on the machine is read or written.
 */
export async function runCapabilityCli(argv, { harness, cwd, env = {}, token } = {}) {
  const stdout = [];
  const stderr = [];
  const code = await runCli(argv, {
    env: {
      CODERAX_BASE_URL: harness.url,
      CODERAX_TOKEN: token ?? harness.token,
      CODERAX_CONFIG_DIR: join(cwd, "config"),
      ...env,
    },
    cwd,
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
    stdinIsTTY: true,
    fetchImpl: fetch,
  });
  return { code, stdout: stdout.join(""), stderr: stderr.join("") };
}

export function json(stdout) {
  return JSON.parse(stdout);
}

export function workSubmissions(harness) {
  return harness.state.requests.filter((request) => request.method === "POST" && request.path === "/v1/work");
}
