import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { runInteractive } from "../src/interactive.js";
import { startWorkflowHarness } from "./support/workflow-harness.js";

/**
 * The interactive REPL, driven through its real `PromptSession`/readline path.
 *
 * The streams are pass-throughs that advertise a TTY, so the session takes the
 * same branch a terminal does (including Ctrl+D handling) without a platform
 * PTY. Answers are written only after a prompt appears: real readline pauses the
 * input between questions, so pre-buffered answers would be dropped.
 */

const PROMPT = "coderax \u203a ";

function fakeInput() {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => {};
  return input;
}

function fakeOutput() {
  const output = new PassThrough();
  output.isTTY = true;
  output.columns = 100;
  return output;
}

/** Feed one answer per prompt; a `null` answer sends Ctrl+D (clean EOF). */
function drive(answers) {
  const input = fakeInput();
  const stdout = fakeOutput();
  const stderr = new PassThrough();
  let output = "";
  let errors = "";
  let prompts = 0;
  let sent = 0;

  function pump() {
    const seen = output.split(PROMPT).length - 1;
    while (prompts < seen && sent < answers.length) {
      prompts += 1;
      const answer = answers[sent];
      sent += 1;
      setTimeout(() => {
        // A real terminal delivers Ctrl+D as a keypress. Ending the stream
        // instead would leave readline's pending question unresolved.
        if (answer === null) input.write("\u0004");
        else input.write(`${answer}\n`);
      }, 5);
    }
  }

  stdout.on("data", (chunk) => {
    output += chunk.toString();
    pump();
  });
  stderr.on("data", (chunk) => {
    errors += chunk.toString();
  });

  return {
    input,
    stdout,
    stderr,
    output: () => output,
    errors: () => errors,
    answered: () => sent,
  };
}

function context(settings) {
  return { settings, env: { NO_COLOR: "1" } };
}

const DEPS = { env: { NO_COLOR: "1" }, fetchImpl: fetch };

const TIMEOUT = { timeout: 20000 };

test("interactive mode refuses a non-terminal stdin", async () => {
  await assert.rejects(
    runInteractive(
      context({ baseUrl: "https://coderax.test", token: "owner-token", timeoutMs: 10000 }),
      {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        env: { NO_COLOR: "1" },
      },
    ),
    (error) => error.code === "USAGE" && /requires a terminal/.test(error.message),
  );
});

test("chat streams a reply and exits cleanly on /quit", TIMEOUT, async (t) => {
  const server = await startWorkflowHarness();
  t.after(() => server.close());
  const driver = drive(["hello terminal", "/quit"]);

  const code = await runInteractive(context({
    baseUrl: server.url,
    token: server.token,
    timeoutMs: 10000,
    model: "",
  }), { ...DEPS, stdin: driver.input, stdout: driver.stdout, stderr: driver.stderr });

  assert.equal(code, 0, driver.errors());
  assert.match(driver.output(), /contract 1\.1\.0/);
  assert.match(driver.output(), /reply: hello terminal/);
  assert.equal(driver.errors(), "");
  assert.equal(driver.answered(), 2);
});

test("Work submits a durable task and reports its artifact", TIMEOUT, async (t) => {
  const server = await startWorkflowHarness();
  t.after(() => server.close());
  const driver = drive(["build the release", "/quit"]);

  const code = await runInteractive(context({
    baseUrl: server.url,
    token: server.token,
    timeoutMs: 10000,
    model: "",
  }), {
    ...DEPS,
    mode: "work",
    stdin: driver.input,
    stdout: driver.stdout,
    stderr: driver.stderr,
  });

  assert.equal(code, 0, driver.errors());
  assert.match(driver.output(), /accepted task-0001/);
  assert.match(driver.output(), /completed/);
  assert.match(driver.output(), /result\.md/);
  const submissions = server.state.requests.filter(
    (request) => request.method === "POST" && request.path === "/v1/work",
  );
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0].body.objective, "build the release");
  assert.equal(submissions[0].body.mode, "cloud");
  assert.equal(submissions[0].body.requireApproval, true);
});

test("a clean EOF ends the session without an error", TIMEOUT, async (t) => {
  const server = await startWorkflowHarness();
  t.after(() => server.close());
  const driver = drive(["hello terminal", null]);

  const code = await runInteractive(context({
    baseUrl: server.url,
    token: server.token,
    timeoutMs: 10000,
    model: "",
  }), { ...DEPS, stdin: driver.input, stdout: driver.stdout, stderr: driver.stderr });

  assert.equal(code, 0);
  assert.match(driver.output(), /reply: hello terminal/);
  assert.doesNotMatch(driver.errors(), /unexpected failure|AbortError|INPUT_CLOSED/);
  assert.equal(
    server.state.requests.some((request) => request.path === "/v1/work"),
    false,
  );
});

test("slash commands stay in the session and report unknown input", TIMEOUT, async (t) => {
  const server = await startWorkflowHarness();
  t.after(() => server.close());
  const driver = drive(["/nonsense", "/help", "/version", "/quit"]);

  const code = await runInteractive(context({
    baseUrl: server.url,
    token: server.token,
    timeoutMs: 10000,
    model: "",
  }), { ...DEPS, stdin: driver.input, stdout: driver.stdout, stderr: driver.stderr });

  assert.equal(code, 0, driver.errors());
  assert.match(driver.output(), /unknown command: \/nonsense/);
  assert.match(driver.output(), /Interactive commands/);
  assert.match(driver.output(), /coderax-cli 0\.3\.0/);
});
