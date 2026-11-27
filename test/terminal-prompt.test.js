import test from "node:test";
import assert from "node:assert/strict";
import {
  clearLine,
  formatPrompt,
  renderPromptLine,
  resolveTerminalProfile,
  sanitizeLabel,
  stringWidth,
  stripAnsi,
  truncateToWidth,
} from "../src/terminal/prompt.js";

test("a Linux TTY profile enables ANSI, colour, Unicode and raw mode", () => {
  const profile = resolveTerminalProfile({
    platform: "linux",
    env: { TERM: "xterm-256color" },
    isTTY: true,
    columns: 100,
  });
  assert.equal(profile.ansi, true);
  assert.equal(profile.color, true);
  assert.equal(profile.unicode, true);
  assert.equal(profile.rawMode, true);
  assert.equal(profile.columns, 100);
  assert.equal(profile.eol, "\r\n");
});

test("piped output on every platform has no ANSI and a plain LF", () => {
  for (const platform of ["linux", "darwin", "win32"]) {
    const profile = resolveTerminalProfile({
      platform,
      env: { TERM: "xterm-256color" },
      isTTY: false,
    });
    assert.equal(profile.ansi, false, platform);
    assert.equal(profile.color, false, platform);
    assert.equal(profile.rawMode, false, platform);
    if (platform !== "win32") assert.equal(profile.eol, "\n", platform);
  }
});

test("NO_COLOR disables colour but keeps line control", () => {
  const profile = resolveTerminalProfile({
    platform: "darwin",
    env: { TERM: "xterm-256color", NO_COLOR: "1" },
    isTTY: true,
  });
  assert.equal(profile.ansi, true);
  assert.equal(profile.color, false);
});

test("TERM=dumb disables ANSI and Unicode frames", () => {
  const profile = resolveTerminalProfile({
    platform: "linux",
    env: { TERM: "dumb" },
    isTTY: true,
  });
  assert.equal(profile.ansi, false);
  assert.equal(profile.unicode, false);
});

test("legacy Windows consoles avoid VT sequences and Unicode frames", () => {
  const legacy = resolveTerminalProfile({ platform: "win32", env: {}, isTTY: true });
  assert.equal(legacy.ansi, false);
  assert.equal(legacy.color, false);
  assert.equal(legacy.unicode, false);
  assert.equal(legacy.eol, "\r\n");

  const windowsTerminal = resolveTerminalProfile({
    platform: "win32",
    env: { WT_SESSION: "abc" },
    isTTY: true,
  });
  assert.equal(windowsTerminal.ansi, true);
  assert.equal(windowsTerminal.unicode, true);

  const vscode = resolveTerminalProfile({
    platform: "win32",
    env: { TERM_PROGRAM: "vscode" },
    isTTY: true,
  });
  assert.equal(vscode.ansi, true);
});

test("the prompt renders identically with and without colour", () => {
  const plain = resolveTerminalProfile({
    platform: "linux",
    env: { TERM: "xterm", NO_COLOR: "1" },
    isTTY: true,
  });
  assert.equal(formatPrompt({ label: "coderax", profile: plain }), "coderax> ");

  const coloured = resolveTerminalProfile({ platform: "darwin", env: { TERM: "xterm" }, isTTY: true });
  assert.equal(formatPrompt({ label: "coderax", profile: coloured }), "\u001b[36mcoderax> \u001b[0m");
});

test("prompt labels are stripped of control characters and newlines", () => {
  assert.equal(sanitizeLabel("a\r\nb\tc \u001b[31mred\u001b[0m"), "a b c red");
  assert.equal(sanitizeLabel("\u0000\u0007bad"), "bad");
  assert.equal(sanitizeLabel("  spaced   label  "), "spaced label");
  assert.equal(stripAnsi("\u001b[31mx\u001b[0m"), "x");
});

test("width counts wide and combining characters", () => {
  assert.equal(stringWidth("abc"), 3);
  assert.equal(stringWidth("\u4f60\u597d"), 4);
  assert.equal(stringWidth("e\u0301"), 1);
  assert.equal(stringWidth("\u001b[31mab\u001b[0m"), 2);
});

test("truncation respects the column budget and never splits a wide glyph", () => {
  assert.equal(truncateToWidth("abcdef", 4), "abc\u2026");
  assert.equal(truncateToWidth("\u4f60\u597d\u4e16\u754c", 5), "\u4f60\u597d\u2026");
  assert.equal(truncateToWidth("ab", 2), "ab");
  assert.equal(truncateToWidth("ab", 0), "");
});

test("clearLine uses CSI on ANSI terminals and spaces on legacy consoles", () => {
  const ansi = resolveTerminalProfile({ platform: "linux", env: { TERM: "xterm" }, isTTY: true });
  assert.equal(clearLine({ profile: ansi, columns: 20 }), "\r\u001b[2K");

  const legacy = resolveTerminalProfile({ platform: "win32", env: {}, isTTY: true, columns: 5 });
  assert.equal(clearLine({ profile: legacy, columns: 5 }), "\r     \r");

  const piped = resolveTerminalProfile({ platform: "linux", env: {}, isTTY: false });
  assert.equal(clearLine({ profile: piped }), "");
});

test("renderPromptLine clears and clips the prompt to the terminal width", () => {
  const profile = resolveTerminalProfile({
    platform: "linux",
    env: { TERM: "xterm" },
    isTTY: true,
    columns: 8,
  });
  assert.equal(renderPromptLine({ label: "coderax", profile, columns: 8 }), "\r\u001b[2Kcoderax\u2026");

  const roomy = resolveTerminalProfile({
    platform: "linux",
    env: { TERM: "xterm" },
    isTTY: true,
    columns: 40,
  });
  assert.equal(
    renderPromptLine({ label: "coderax", profile: roomy, columns: 40 }),
    "\r\u001b[2K\u001b[36mcoderax> \u001b[0m",
  );
});
