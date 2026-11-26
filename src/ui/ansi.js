const CODES = Object.freeze({
  reset: 0,
  bold: 1,
  dim: 2,
  italic: 3,
  underline: 4,
  blink: 5,
  inverse: 7,
  hidden: 8,
  strike: 9,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
  white: 37,
  gray: 90,
  brightRed: 91,
  brightGreen: 92,
  brightYellow: 93,
  brightBlue: 94,
  brightMagenta: 95,
  brightCyan: 96,
});

export function supportsColor({ stream = process.stdout, env = process.env, noColor = false } = {}) {
  if (noColor) return false;
  if (env.NO_COLOR !== undefined) return false;
  if (env.FORCE_COLOR === "0") return false;
  if (env.FORCE_COLOR === "1" || env.FORCE_COLOR === "2" || env.FORCE_COLOR === "3") return true;
  if (env.TERM === "dumb") return false;
  return Boolean(stream?.isTTY);
}

export function createStyle({ enabled = true, stream = process.stdout } = {}) {
  const paint = (code, text) => {
    if (!enabled) return String(text);
    return `\u001b[${code}m${text}\u001b[0m`;
  };
  const style = {
    enabled,
    stream,
    reset: (text) => paint(CODES.reset, text),
    bold: (text) => paint(CODES.bold, text),
    dim: (text) => paint(CODES.dim, text),
    italic: (text) => paint(CODES.italic, text),
    underline: (text) => paint(CODES.underline, text),
    strike: (text) => paint(CODES.strike, text),
    inverse: (text) => paint(CODES.inverse, text),
    red: (text) => paint(CODES.red, text),
    green: (text) => paint(CODES.green, text),
    yellow: (text) => paint(CODES.yellow, text),
    blue: (text) => paint(CODES.blue, text),
    magenta: (text) => paint(CODES.magenta, text),
    cyan: (text) => paint(CODES.cyan, text),
    gray: (text) => paint(CODES.gray, text),
    brightRed: (text) => paint(CODES.brightRed, text),
    brightGreen: (text) => paint(CODES.brightGreen, text),
    brightYellow: (text) => paint(CODES.brightYellow, text),
    brightBlue: (text) => paint(CODES.brightBlue, text),
    brightCyan: (text) => paint(CODES.brightCyan, text),
    wrap: (codes, text) => {
      if (!enabled) return String(text);
      return `${codes.map((code) => `\u001b[${code}m`).join("")}${text}\u001b[0m`;
    },
  };
  return style;
}

export function stripAnsi(text) {
  return String(text).replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "");
}

/** Remove terminal control sequences from untrusted model text. */
export function sanitizeTerminalText(text) {
  return String(text)
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b[@-_]/g, "")
    .replace(/\r/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

export function visibleLength(text) {
  return [...stripAnsi(text)].length;
}

export function truncate(text, width, ellipsis = "\u2026") {
  const plain = stripAnsi(text);
  if (width <= 0) return "";
  if (plain.length <= width) return text;
  if (width <= ellipsis.length) return ellipsis.slice(0, width);
  return `${plain.slice(0, width - ellipsis.length)}${ellipsis}`;
}

export function padEnd(text, width) {
  const length = visibleLength(text);
  if (length >= width) return text;
  return `${text}${" ".repeat(width - length)}`;
}

export function padStart(text, width) {
  const length = visibleLength(text);
  if (length >= width) return text;
  return `${" ".repeat(width - length)}${text}`;
}

/** Word-wrap plain text; ANSI styling is applied after wrapping. */
export function wrapPlain(text, width, { hangingIndent = 0 } = {}) {
  const limit = Math.max(8, width);
  const words = String(text).split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) return [""];
  const lines = [];
  let line = "";
  const indent = " ".repeat(hangingIndent);
  for (const word of words) {
    const candidate = line.length === 0 ? word : `${line} ${word}`;
    const candidateWidth = visibleLength(`${lines.length === 0 ? "" : indent}${candidate}`);
    if (candidateWidth <= limit || line.length === 0) {
      line = candidate;
    } else {
      lines.push(`${lines.length === 0 ? "" : indent}${line}`);
      line = word;
    }
  }
  lines.push(`${lines.length === 0 ? "" : indent}${line}`);
  return lines;
}

export function termWidth(stream = process.stdout, env = process.env, fallback = 100) {
  const columns = Number(env.COLUMNS);
  if (Number.isInteger(columns) && columns >= 20) return columns;
  if (Number.isInteger(stream?.columns) && stream.columns >= 20) return stream.columns;
  return fallback;
}

export function clearLine(stream = process.stdout) {
  if (stream?.isTTY) stream.write("\r\u001b[2K");
}

export function hideCursor(stream = process.stdout) {
  if (stream?.isTTY) stream.write("\u001b[?25l");
}

export function showCursor(stream = process.stdout) {
  if (stream?.isTTY) stream.write("\u001b[?25h");
}

export function moveCursor(stream, rows) {
  if (!stream?.isTTY || rows === 0) return;
  stream.write(rows > 0 ? `\u001b[${rows}A` : `\u001b[${-rows}B`);
}
