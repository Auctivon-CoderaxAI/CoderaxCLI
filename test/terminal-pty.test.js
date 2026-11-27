import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { parseEvents, ptySupport, runPty } from "./helpers/pty.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/pty-probe.js", import.meta.url));
const support = ptySupport();
const skip = support.supported ? false : support.reason;

test("a real PTY enables raw mode and decodes Enter versus Ctrl+J", { skip }, async (t) => {
  // Sent after the child reports READY, so raw mode is already active and the
  // PTY cannot translate CR into LF before the decoder sees it.
  const input = "a\rb\r\nc\n\u0004";
  const result = await runPty({ fixture: FIXTURE, input });

  t.diagnostic(`pty exit ${result.status}; output ${JSON.stringify(result.output)}`);
  assert.equal(result.timedOut, false, "the PTY child must exit on Ctrl+D");
  assert.equal(result.status, 0, "the PTY child must exit successfully");

  assert.match(result.output, /READY tty=true raw=true/);
  assert.match(result.output, /PROMPT ".*coderax> .*"/);
  // Raw mode on POSIX disables output post-processing, so the fixture's prompt
  // profile must choose CRLF rather than a bare LF.
  assert.match(result.output, /EOL "\\r\\n"/);

  const events = parseEvents(result.output);
  assert.deepEqual(
    events.map((event) => event.type),
    ["text", "enter", "text", "enter", "text", "ctrl+j", "ctrl+d"],
  );
  assert.deepEqual(
    events.filter((event) => event.type === "text").map((event) => event.payload),
    ["a", "b", "c"],
  );
});
