import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPty, ptySupport } from "./helpers/pty.js";
import { runCli } from "../src/cli.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/chat-pty.js", import.meta.url));
const support = ptySupport();
const skip = support.supported ? false : support.reason;

test("the interactive chat prompt, key decoder and wait indicator are used in a real PTY", { skip }, async (t) => {
  // Ctrl+J (LF) must insert a newline inside the message; Enter (CR) submits.
  const steps = [
    { when: /coderax> /, input: "hello\nworld\r" },
    { when: /echo "hello/, input: "/exit\r" },
  ];
  const result = await runPty({ fixture: FIXTURE, steps, env: { TERM: "xterm-256color", NO_COLOR: "", FORCE_COLOR: "1" } });

  t.diagnostic(`pty exit ${result.status}; output ${JSON.stringify(result.output)}`);
  assert.equal(result.timedOut, false, "the interactive session must exit on /exit");
  assert.equal(result.status, 0, "the session must exit successfully");

  // The prompt comes from src/terminal/prompt.js, not readline: the coloured
  // label is only produced by formatPrompt on an ANSI-capable TTY.
  assert.match(result.output, /\u001b\[36mcoderax> \u001b\[0m/);

  // The wait indicator (stderr) painted while the response was pending.
  assert.match(result.output, /working/);
  assert.match(result.output, /[\u2800-\u28ff]|-/);

  // The decoder delivered one multi-line message: Ctrl+J did not submit.
  assert.ok(
    result.output.includes('echo "hello\\nworld"'),
    "the submitted message must contain the Ctrl+J newline",
  );
  assert.equal(result.output.includes("[Revised response]"), false);
});

test("Ctrl+C cancels a streaming chat turn and resets bracketed paste", { skip }, async () => {
  const result = await runPty({
    fixture: FIXTURE,
    steps: [
      { when: "coderax> ", input: "interrupt me\r" },
      { when: "TURN STARTED", input: "\u0003" },
    ],
    env: { TERM: "xterm-256color" },
  });
  assert.equal(result.timedOut, false);
  assert.equal(result.status, 130);
  assert.match(result.output, /\u001b\[\?2004h.*coderax> /s);
  assert.ok(result.output.includes("\u001b[?2004l"));
  assert.doesNotMatch(result.output, /echo "interrupt me"/);
});

test("a non-TTY chat stays a single piped turn with no prompt, spinners or ANSI", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coderax-pipe-chat-"));
  const env = {
    CODERAX_CONFIG: join(directory, "config.json"),
    CODERAX_BASE_URL: "https://coderax.test",
    CODERAX_TOKEN: "piped-token",
  };

  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(init.body) });
    const frames = [
      { type: "text", text: "piped answer", index: 0 },
      { final: true, responseMessage: { text: "piped answer", messageId: "m1", conversationId: "c1" } },
    ];
    // Sequence ids keep the stream replayable, so stderr carries no
    // diagnostic of its own and stays empty in a piped session.
    return new Response(
      `${frames
        .map((frame, index) => `id: ${index + 1}\ndata: ${JSON.stringify(frame)}\n\n`)
        .join("")}data: [DONE]\n\n`,
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  };

  const out = [];
  const err = [];
  const code = await runCli(["chat"], {
    env,
    fetchImpl,
    stdinIsTTY: false,
    readSecret: async () => "piped message",
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
  });

  assert.equal(code, 0);
  assert.equal(out.join(""), "piped answer\n");
  assert.equal(err.join(""), "");
  assert.equal(out.join("").includes("\u001b"), false);
  assert.equal(out.join("").includes("coderax> "), false);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.text, "piped message");
  assert.equal(requests[0].body.mode, "chat");
});
