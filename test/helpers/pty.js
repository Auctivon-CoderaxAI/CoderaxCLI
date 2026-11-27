import { spawn, spawnSync } from "node:child_process";

/**
 * Minimal PTY harness built on the system `script` utility, so the test suite
 * keeps its zero-runtime-dependency contract. Windows has no POSIX PTY
 * available this way and is skipped by the caller with a stated reason.
 */
export function ptySupport() {
  if (process.platform === "win32") {
    return {
      supported: false,
      reason: "no POSIX PTY is available to the dependency-free harness on Windows",
    };
  }
  const probe = spawnSync("sh", ["-c", "command -v script"], { encoding: "utf8" });
  const path = probe.status === 0 ? probe.stdout.trim().split("\n")[0] : "";
  if (path === "") {
    return { supported: false, reason: "the POSIX `script` utility is not installed" };
  }
  return { supported: true, path };
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

export function runPty({ fixture, input = "", steps = [], timeoutMs = 15000, env = {} }) {
  const support = ptySupport();
  if (!support.supported) {
    throw new Error(`PTY unavailable: ${support.reason}`);
  }

  // util-linux: script -q -e -f -c <command> /dev/null
  // BSD/macOS: script -q /dev/null <command> [args...]
  const args =
    process.platform === "darwin"
      ? ["-q", "/dev/null", process.execPath, fixture]
      : ["-q", "-e", "-f", "-c", `${shellQuote(process.execPath)} ${shellQuote(fixture)}`, "/dev/null"];

  return new Promise((resolve, reject) => {
    const child = spawn(support.path, args, {
      detached: process.platform !== "win32",
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let output = "";
    let sent = false;
    let stepIndex = 0;
    let matchEnd = 0;
    let settled = false;

    const stop = () => {
      if (process.platform !== "win32" && child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // The process group is already gone.
        }
      }
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      stop();
      resolve({ status: null, output, timedOut: true });
    }, timeoutMs);

    // Send each staged input once its pattern has been seen, so a test can
    // answer a prompt and then wait for the command to prompt again.
    const pump = () => {
      while (stepIndex < steps.length) {
        const step = steps[stepIndex];
        if (matchEnd > output.length) return;
        const remaining = output.slice(matchEnd);
        if (step.when instanceof RegExp) {
          const match = new RegExp(step.when).exec(remaining);
          if (!match) return;
          matchEnd += match.index + Math.max(1, match[0].length);
        } else {
          const pattern = String(step.when);
          const index = remaining.indexOf(pattern);
          if (index === -1) return;
          matchEnd += index + Math.max(1, pattern.length);
        }
        stepIndex += 1;
        if (step.input) child.stdin.write(step.input);
      }
    };

    const collect = (buffer) => {
      output += buffer.toString("utf8");
      if (!sent && output.includes("READY")) {
        sent = true;
        if (input !== "") child.stdin.write(input);
      }
      pump();
    };

    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.stdin.on("error", () => {
      // Writing after the child exits is not a test failure.
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status, output, timedOut: false });
    });
  });
}

/** Parse `EVENT <type> <json>` lines the fixture writes. */
export function parseEvents(output) {
  const events = [];
  for (const rawLine of output.split(/\r*\n/)) {
    // A PTY may translate LF to CRLF, and the fixture already writes CRLF.
    const line = rawLine.replace(/\r+$/, "");
    const match = /^EVENT (\S+) (.*)$/.exec(line);
    if (!match) continue;
    let payload = "";
    try {
      payload = JSON.parse(match[2]);
    } catch {
      payload = match[2];
    }
    events.push({ type: match[1], payload });
  }
  return events;
}
