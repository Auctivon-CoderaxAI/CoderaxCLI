import { createKeyDecoder } from "../../src/terminal/keys.js";
import { formatPrompt, resolveTerminalProfile } from "../../src/terminal/prompt.js";

// Runs only inside a real PTY (test/terminal-pty.test.js). It reports raw-mode
// state and decoded key events, then exits on Ctrl+D or after five seconds.

const writeLine = (line) => process.stdout.write(`${line}\r\n`);

if (!process.stdin.isTTY) {
  writeLine("ERROR stdin is not a TTY");
  process.exit(2);
}

const decoder = createKeyDecoder();
let finished = false;

function finish() {
  if (finished) return;
  finished = true;
  try {
    if (process.stdin.isRaw) process.stdin.setRawMode(false);
  } catch {
    // The PTY may already be gone; nothing to restore.
  }
  process.stdin.pause();
  process.exit(0);
}

process.stdin.setRawMode(true);
process.stdin.resume();
writeLine(`READY tty=${process.stdin.isTTY} raw=${process.stdin.isRaw}`);

const profile = resolveTerminalProfile({
  platform: process.platform,
  env: process.env,
  isTTY: true,
  columns: process.stdout.columns ?? 80,
});
writeLine(`PROMPT ${JSON.stringify(formatPrompt({ label: "coderax", profile }))}`);
writeLine(`EOL ${JSON.stringify(profile.eol)}`);

process.stdin.on("data", (chunk) => {
  for (const event of decoder.push(chunk)) {
    writeLine(`EVENT ${event.type} ${JSON.stringify(event.text ?? event.sequence ?? "")}`);
    if (event.type === "ctrl+d") finish();
  }
});

setTimeout(finish, 5000).unref?.();
