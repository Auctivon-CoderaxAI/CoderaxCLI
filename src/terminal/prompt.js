/**
 * Cross-platform prompt rendering.
 *
 * The terminal profile is resolved from an explicit platform/environment so it
 * can be tested for Linux, macOS and Windows without running on each one. The
 * pure formatters take the profile, which keeps rendering deterministic in
 * tests and lets the caller decide whether output is a TTY.
 *
 * Line endings: interactive terminal output uses CRLF while the profile is a
 * TTY. Node's raw mode (`setRawMode(true)`, used by hidden prompts) disables
 * output post-processing on POSIX, so a bare LF moves down without returning
 * the carriage and produces a staircase. CRLF is correct on every platform and
 * on pipes it is never written because callers skip interactive output when
 * `isTTY` is false.
 */
const ANSI_PATTERN =
  /\u001b\][^\u0007]*(?:\u0007|\u001b\\)|\u001b\[[0-?]*[ -/]*[@-~]/g;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/g;
const COMBINING_PATTERN = /\p{Mn}|\p{Me}|\p{Cf}/u;

export function stripAnsi(value) {
  return String(value ?? "").replace(ANSI_PATTERN, "");
}

/** Turn arbitrary text into one safe, single-line prompt label. */
export function sanitizeLabel(value) {
  return stripAnsi(value)
    .replace(/[\r\n\t]+/g, " ")
    .replace(CONTROL_PATTERN, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isWideCodePoint(codePoint) {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    codePoint === 0x2329 ||
    codePoint === 0x232a ||
    (codePoint >= 0x2e80 && codePoint <= 0x303e) ||
    (codePoint >= 0x3041 && codePoint <= 0x33ff) ||
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0xa000 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xa960 && codePoint <= 0xa97f) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
    (codePoint >= 0x1f680 && codePoint <= 0x1f6ff) ||
    (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  );
}

/** Display width in terminal columns: ANSI-free, wide and combining aware. */
export function stringWidth(value) {
  const text = stripAnsi(value);
  let width = 0;
  for (const char of text) {
    const codePoint = char.codePointAt(0);
    if (COMBINING_PATTERN.test(char)) continue;
    if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f)) continue;
    width += isWideCodePoint(codePoint) ? 2 : 1;
  }
  return width;
}

/** Cut plain text to a column budget without splitting a wide character. */
export function truncateToWidth(value, columns, ellipsis = "\u2026") {
  const text = stripAnsi(value);
  const limit = Number.isFinite(columns) ? Math.max(0, Math.floor(columns)) : Infinity;
  if (stringWidth(text) <= limit) return text;
  if (limit === 0) return "";
  const marker = stringWidth(ellipsis) <= limit ? ellipsis : "";
  const budget = limit - stringWidth(marker);
  let used = 0;
  let result = "";
  for (const char of text) {
    const width = stringWidth(char);
    if (used + width > budget) break;
    result += char;
    used += width;
  }
  return `${result}${marker}`;
}

export function resolveTerminalProfile({
  platform = process.platform,
  env = process.env ?? {},
  isTTY = Boolean(process.stdout?.isTTY),
  columns = null,
} = {}) {
  const term = String(env.TERM ?? "").toLowerCase();
  const dumb = term === "dumb";
  const windows = platform === "win32";
  // Legacy Windows consoles do not interpret VT sequences. Windows Terminal,
  // VS Code, ConEmu and MSYS/Cygwin all identify themselves in the environment.
  const modernWindows = Boolean(
    env.WT_SESSION ||
      env.TERM_PROGRAM ||
      env.ConEmuANSI === "ON" ||
      env.ANSICON ||
      (term !== "" && !dumb),
  );
  const ansi = isTTY && !dumb && (!windows || modernWindows);
  const noColor = (Object.hasOwn(env, "NO_COLOR") && env.NO_COLOR !== "") || env.FORCE_COLOR === "0";
  const color = ansi && !noColor;
  const unicode = !dumb && (!windows || modernWindows);
  const width = Number.isFinite(columns) && columns > 0 ? Math.floor(columns) : 80;

  return Object.freeze({
    platform,
    isTTY,
    rawMode: isTTY,
    ansi,
    color,
    unicode,
    noColor,
    columns: width,
    eol: isTTY || windows ? "\r\n" : "\n",
  });
}

/** Render "coderax> " with optional label colour. */
export function formatPrompt({ label = "coderax", marker = ">", profile } = {}) {
  const resolved = profile ?? resolveTerminalProfile();
  const clean = sanitizeLabel(label) || "coderax";
  const cleanMarker = sanitizeLabel(marker) || ">";
  const plain = `${clean}${cleanMarker} `;
  return resolved.color ? `\u001b[36m${plain}\u001b[0m` : plain;
}

/**
 * Return a sequence that puts the cursor at column 0 and erases the line.
 * Legacy consoles get spaces because they do not parse CSI.
 */
export function clearLine({ profile, columns } = {}) {
  const resolved = profile ?? resolveTerminalProfile();
  if (!resolved.isTTY) return "";
  if (resolved.ansi) return "\r\u001b[2K";
  const width = Math.max(0, Math.min(Number(columns ?? resolved.columns) || 80, 4096));
  return `\r${" ".repeat(width)}\r`;
}

/** A complete prompt line, cleared first and clipped to the terminal width. */
export function renderPromptLine({ label = "coderax", marker = ">", profile, columns } = {}) {
  const resolved = profile ?? resolveTerminalProfile();
  const width = Number(columns ?? resolved.columns);
  const prompt = formatPrompt({ label, marker, profile: resolved });
  // Keep colour codes when the prompt fits; truncation works on plain text.
  const fitted = stringWidth(prompt) > width ? truncateToWidth(prompt, width) : prompt;
  return `${clearLine({ profile: resolved, columns: width })}${fitted}`;
}

/** Write a prompt to a stream and return the profile that was used. */
export function writePrompt(stream, { label = "coderax", marker = ">", profile } = {}) {
  const resolved =
    profile ??
    resolveTerminalProfile({
      isTTY: Boolean(stream?.isTTY),
      columns: stream?.columns ?? null,
    });
  if (typeof stream?.write === "function") {
    stream.write(renderPromptLine({ label, marker, profile: resolved, columns: resolved.columns }));
  }
  return resolved;
}
