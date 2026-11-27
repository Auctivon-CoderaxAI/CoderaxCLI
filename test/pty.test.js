import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripAnsi } from "../src/terminal/sanitize.js";

const CLI = fileURLToPath(new URL("../src/legacy-cli.js", import.meta.url));

/**
 * BSD `script` (macOS) calls tcgetattr on its own stdin, so it cannot be driven
 * through a pipe at all: it exits with "tcgetattr/ioctl: Operation not supported
 * on socket" before running the command. util-linux `script` tolerates a pipe,
 * so it stays the driver on Linux. The fallback below allocates a pty and pumps
 * bytes itself, without touching the parent's terminal state.
 */
const PYTHON_PTY = [
  "import os, pty, select, signal, sys",
  "pid, fd = pty.fork()",
  "if pid == 0:",
  "    os.execv('/bin/sh', ['/bin/sh', '-c', sys.argv[1]])",
  "def bye(*_):",
  "    try:",
  "        os.kill(pid, signal.SIGKILL)",
  "    except OSError:",
  "        pass",
  "    os._exit(1)",
  "signal.signal(signal.SIGTERM, bye)",
  "stdin_open = True",
  "while True:",
  "    watch = [fd] + ([0] if stdin_open else [])",
  "    ready, _, _ = select.select(watch, [], [])",
  "    if 0 in ready:",
  "        data = os.read(0, 4096)",
  "        if not data:",
  "            stdin_open = False",
  "        else:",
  "            os.write(fd, data)",
  "    if fd in ready:",
  "        try:",
  "            data = os.read(fd, 65536)",
  "        except OSError:",
  "            break",
  "        if not data:",
  "            break",
  "        os.write(1, data)",
  "os.waitpid(pid, 0)",
].join("\n");

const DRIVER = process.env.CODERAX_PTY_DRIVER === "python" || process.platform === "darwin" ? "python" : "script";
const HAS_DRIVER =
  DRIVER === "python"
    ? spawnSync("python3", ["-c", "import pty"], { encoding: "utf8" }).status === 0
    : spawnSync(process.platform === "win32" ? "where" : "which", ["script"], { encoding: "utf8" }).status === 0;

function quote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pieces(text, size = 8) {
  const chars = Array.from(text);
  const out = [];
  for (let index = 0; index < chars.length; index += size) out.push(chars.slice(index, index + size).join(""));
  return out;
}

async function startServer() {
  const requests = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "POST" && (url.pathname === "/api/ask/agents" || url.pathname === "/api/work/chat")) {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const parsed = JSON.parse(raw);
      requests.push(parsed);
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (String(parsed.text).startsWith("slow")) {
        res.write('data: {"delta":"slow start"}\n\n');
        return;
      }
      const answer =
        "streamed markdown answer with enough words to wrap across a narrow terminal and prove the renderer works\n\n"
        + (String(parsed.text).includes("世界") ? "wide answer 世界 😀\n\n- item one\n- item two\n" : "");
      for (const piece of pieces(answer)) {
        if (res.writableEnded) return;
        res.write(`data: ${JSON.stringify({ delta: piece })}\n\n`);
        await delay(4);
      }
      res.write(`data: ${JSON.stringify({ final: true, responseMessage: { text: answer } })}\n\n`);
      res.end();
      return;
    }
    if (url.pathname === "/api/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ models: ["alpha", "beta"] }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: "not found" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { server, requests, port: server.address().port };
}

function launch(port) {
  const command = `stty cols 40 rows 24 2>/dev/null; exec ${quote(process.execPath)} ${quote(CLI)} chat --interactive --base-url http://127.0.0.1:${port} --no-history --no-color`;
  const [file, args] =
    DRIVER === "python"
      ? ["python3", ["-c", PYTHON_PTY, command]]
      : ["script", ["-qec", command, "/dev/null"]];
  const child = spawn(file, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      CODERAX_CONFIG: join(tmpdir(), `coderax-pty-${process.pid}-${Date.now()}.json`),
      CODERAX_HISTORY: "off",
      // A token in argv is refused by design; the PTY test supplies it the same
      // way an operator would, through the environment.
      CODERAX_TOKEN: "pty-token",
    },
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  return {
    child,
    exited,
    get output() {
      return output;
    },
    clean() {
      return stripAnsi(output);
    },
    async waitFor(predicate, timeoutMs = 8000) {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        if (predicate(output)) return true;
        await delay(20);
      }
      throw new Error(`timed out; output so far:\n${stripAnsi(output).slice(-2000)}`);
    },
  };
}

async function stop(child) {
  if (child.killed) return;
  // Give the driver a chance to take its terminal child down with it.
  child.kill("SIGTERM");
  await delay(50);
  if (!child.killed) child.kill("SIGKILL");
}

test("a real PTY session streams a response, handles Unicode editing and exits cleanly", async (t) => {
  if (!HAS_DRIVER || process.platform === "win32") {
    t.skip("requires a POSIX pseudo-terminal");
    return;
  }
  const { server, requests, port } = await startServer();
  const term = launch(port);
  try {
    await term.waitFor((output) => output.includes("chat \u203a "));
    term.child.stdin.write("hello 世界 😀");
    await delay(80);
    term.child.stdin.write("\r");
    await term.waitFor((output) => output.includes("streamed markdown answer"));
    assert.equal(requests[0].text, "hello 世界 😀");
    assert.equal(term.output.includes("\u001b]52;"), false);
    await term.waitFor((output) => output.includes("wide answer 世界 😀"));

    // Wide-character editing: insert a CJK cell, backspace it as one grapheme,
    // then send a plain ASCII prompt.
    term.child.stdin.write("世");
    await delay(40);
    term.child.stdin.write("\u007f");
    await delay(40);
    term.child.stdin.write("a\r");
    await term.waitFor(() => requests.length >= 2);
    assert.equal(requests[1].text, "a");
    await term.waitFor((output) => output.includes("✓ done"));
    await delay(300);

    term.child.stdin.write("/quit\r");
    const code = await Promise.race([term.exited, delay(5000).then(() => "timeout")]);
    assert.notEqual(code, "timeout", stripAnsi(term.output).slice(-1000));
    assert.equal(code, 0);

    const clean = term.clean();
    assert.equal(clean.includes("\u001b"), false);
    for (const line of clean.split(/\r?\n/)) {
      if (/streamed markdown answer|enough words|narrow terminal/.test(line)) {
        assert.equal(line.length <= 40, true, `line wider than the PTY: ${JSON.stringify(line)}`);
      }
    }
  } finally {
    await stop(term.child);
    server.closeAllConnections?.();
    server.close();
  }
});

test("Ctrl+C interrupts a hanging stream and returns control to the prompt", async (t) => {
  if (!HAS_DRIVER || process.platform === "win32") {
    t.skip("requires a POSIX pseudo-terminal");
    return;
  }
  const { server, port } = await startServer();
  const term = launch(port);
  try {
    await term.waitFor((output) => output.includes("chat \u203a "));
    term.child.stdin.write("slow task\r");
    await term.waitFor((output) => output.includes("slow start"));
    await delay(300);
    term.child.stdin.write("\u0003");
    await term.waitFor((output) => /Response cancelled/.test(stripAnsi(output)));
    await delay(300);
    term.child.stdin.write("/quit\r");
    const code = await Promise.race([term.exited, delay(5000).then(() => "timeout")]);
    assert.notEqual(code, "timeout", stripAnsi(term.output).slice(-1000));
  } finally {
    await stop(term.child);
    server.closeAllConnections?.();
    server.close();
  }
});
