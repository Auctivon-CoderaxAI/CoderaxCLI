/**
 * Semantic ANSI styling. Model output never supplies escape codes; it supplies
 * a style *name* and this module decides the bytes. Colour is disabled for
 * `--no-color`, `NO_COLOR`, dumb terminals and accessible mode.
 */

const STYLE_CODES = Object.freeze({
  plain: [],
  bold: [1],
  dim: [2],
  italic: [3],
  underline: [4],
  inverse: [7],
  strike: [9],
  red: [31],
  green: [32],
  yellow: [33],
  blue: [34],
  magenta: [35],
  cyan: [36],
  gray: [90],
  white: [97],
  heading: [1, 36],
  code: [36],
  link: [4, 34],
  quote: [2, 36],
  bullet: [36],
  error: [1, 31],
  warn: [33],
  success: [32],
  accent: [35],
  muted: [2],
  tool: [2, 33],
  permission: [1, 33],
  keyword: [35],
  string: [32],
  number: [33],
  comment: [2, 90],
  func: [36],
  key: [34],
  punct: [2],
  diffAdd: [32],
  diffDel: [31],
  diffHunk: [36],
});

export function supportsColor({ env = process.env, stream = process.stdout } = {}) {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (env.FORCE_COLOR === "0") return false;
  if (env.FORCE_COLOR && env.FORCE_COLOR !== "0") return true;
  if (env.TERM === "dumb") return false;
  return Boolean(stream?.isTTY);
}

export function createTheme({ color = true, accessible = false } = {}) {
  const enabled = Boolean(color) && !accessible;

  const paint = (text, style = "plain") => {
    const value = String(text ?? "");
    if (!enabled) return value;
    const codes = STYLE_CODES[style] ?? STYLE_CODES.plain;
    if (codes.length === 0) return value;
    return `\u001b[${codes.join(";")}m${value}\u001b[0m`;
  };

  const renderSegments = (segments) =>
    (segments ?? []).map((segment) => paint(segment.text, segment.style ?? "plain")).join("");

  return { enabled, accessible, paint, renderSegments, styles: STYLE_CODES };
}

export { STYLE_CODES };
