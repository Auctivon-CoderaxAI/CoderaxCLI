/**
 * Dependency-free syntax highlighting for fenced code blocks.
 *
 * The output is an array of styled lines (no escape bytes), so the markdown
 * renderer can wrap and sanitize it like any other untrusted text. Unknown
 * languages are shown verbatim rather than guessed at.
 */

const KEYWORDS = {
  javascript: new Set([
    "as", "async", "await", "break", "case", "catch", "class", "const",
    "continue", "debugger", "default", "delete", "do", "else", "export",
    "extends", "false", "finally", "for", "from", "function", "get", "if",
    "import", "in", "instanceof", "let", "new", "null", "of", "return", "set",
    "static", "super", "switch", "this", "throw", "true", "try", "typeof",
    "undefined", "var", "void", "while", "with", "yield",
  ]),
  python: new Set([
    "and", "as", "assert", "async", "await", "break", "class", "continue",
    "def", "del", "elif", "else", "except", "False", "finally", "for", "from",
    "global", "if", "import", "in", "is", "lambda", "None", "nonlocal", "not",
    "or", "pass", "raise", "return", "True", "try", "while", "with", "yield",
  ]),
  shell: new Set([
    "case", "do", "done", "elif", "else", "esac", "fi", "for", "function",
    "if", "in", "select", "then", "time", "until", "while", "export", "local",
    "readonly", "shift", "source", "exit", "return", "set", "unset",
  ]),
};

const LANGUAGE_ALIASES = Object.freeze({
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "javascript",
  tsx: "javascript",
  typescript: "javascript",
  node: "javascript",
  py: "python",
  python3: "python",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  console: "shell",
  json: "json",
  jsonc: "json",
  diff: "diff",
  patch: "diff",
  text: "plain",
  plaintext: "plain",
  txt: "plain",
});

export function normalizeLanguage(language) {
  const name = String(language ?? "").trim().toLowerCase();
  return LANGUAGE_ALIASES[name] ?? (name || "plain");
}

function pushGap(segments, text) {
  if (text) segments.push({ text, style: null });
}

function tokenizeJsLine(line) {
  const segments = [];
  const pattern = /(\/\/.*$)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|\b(\d+(?:\.\d+)?(?:e[+-]?\d+)?)\b|\b([A-Za-z_$][\w$]*)\b|([{}()[\];,.:?!<>=+\-*/%&|^~]+)/gi;
  let cursor = 0;
  for (const match of line.matchAll(pattern)) {
    const index = match.index ?? 0;
    pushGap(segments, line.slice(cursor, index));
    const [raw, comment, string, number, word, punct] = match;
    if (comment) segments.push({ text: raw, style: "comment" });
    else if (string) segments.push({ text: raw, style: "string" });
    else if (number) segments.push({ text: raw, style: "number" });
    else if (word) {
      const lower = word.toLowerCase();
      if (KEYWORDS.javascript.has(word)) segments.push({ text: raw, style: "keyword" });
      else if (line[index + raw.length] === "(") segments.push({ text: raw, style: "func" });
      else if (/^(true|false|null|undefined)$/i.test(lower)) segments.push({ text: raw, style: "number" });
      else segments.push({ text: raw, style: null });
    } else if (punct) segments.push({ text: raw, style: "punct" });
    else segments.push({ text: raw, style: null });
    cursor = index + raw.length;
  }
  pushGap(segments, line.slice(cursor));
  return segments;
}

function tokenizePythonLine(line) {
  const segments = [];
  const pattern = /(#.*$)|("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|\b(\d+(?:\.\d+)?)\b|(@[A-Za-z_][\w.]*)|\b([A-Za-z_][\w]*)\b|([{}()[\];,.:=+\-*/%<>!&|^~]+)/g;
  let cursor = 0;
  for (const match of line.matchAll(pattern)) {
    const index = match.index ?? 0;
    pushGap(segments, line.slice(cursor, index));
    const [raw, comment, string, number, decorator, word, punct] = match;
    if (comment) segments.push({ text: raw, style: "comment" });
    else if (string) segments.push({ text: raw, style: "string" });
    else if (number) segments.push({ text: raw, style: "number" });
    else if (decorator) segments.push({ text: raw, style: "accent" });
    else if (word) {
      if (KEYWORDS.python.has(raw)) segments.push({ text: raw, style: "keyword" });
      else if (line[index + raw.length] === "(") segments.push({ text: raw, style: "func" });
      else segments.push({ text: raw, style: null });
    } else if (punct) segments.push({ text: raw, style: "punct" });
    else segments.push({ text: raw, style: null });
    cursor = index + raw.length;
  }
  pushGap(segments, line.slice(cursor));
  return segments;
}

function tokenizeShellLine(line) {
  const segments = [];
  const pattern = /(#.*$)|("(?:[^"\\]|\\.)*"|'[^']*')|\$\{?[A-Za-z_][\w]*\}?|\b([A-Za-z_][\w-]*)\b|([|&;<>(){}[\]=+\-*/%:,.]+)/g;
  let cursor = 0;
  for (const match of line.matchAll(pattern)) {
    const index = match.index ?? 0;
    pushGap(segments, line.slice(cursor, index));
    const [raw, comment, string, variable, word, punct] = match;
    if (comment) segments.push({ text: raw, style: "comment" });
    else if (string) segments.push({ text: raw, style: "string" });
    else if (variable) segments.push({ text: raw, style: "accent" });
    else if (word) {
      if (KEYWORDS.shell.has(raw)) segments.push({ text: raw, style: "keyword" });
      else segments.push({ text: raw, style: null });
    } else if (punct) segments.push({ text: raw, style: "punct" });
    else segments.push({ text: raw, style: null });
    cursor = index + raw.length;
  }
  pushGap(segments, line.slice(cursor));
  return segments;
}

function tokenizeJsonLine(line) {
  const segments = [];
  const pattern = /("(?:[^"\\]|\\.)*")\s*(:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)|([{}[\],:])/g;
  let cursor = 0;
  for (const match of line.matchAll(pattern)) {
    const index = match.index ?? 0;
    pushGap(segments, line.slice(cursor, index));
    const [raw, string, colon, literal, number, punct] = match;
    if (string) {
      segments.push({ text: string, style: colon ? "key" : "string" });
      if (colon) segments.push({ text: colon, style: "punct" });
    } else if (literal) segments.push({ text: raw, style: "number" });
    else if (number) segments.push({ text: raw, style: "number" });
    else if (punct) segments.push({ text: raw, style: "punct" });
    else segments.push({ text: raw, style: null });
    cursor = index + raw.length;
  }
  pushGap(segments, line.slice(cursor));
  return segments;
}

function highlightDiffLine(line) {
  if (line.startsWith("@@")) return [{ text: line, style: "diffHunk" }];
  if (line.startsWith("+++") || line.startsWith("---")) return [{ text: line, style: "dim" }];
  if (line.startsWith("+")) return [{ text: line, style: "diffAdd" }];
  if (line.startsWith("-")) return [{ text: line, style: "diffDel" }];
  return [{ text: line, style: null }];
}

/** Highlight one line. The line is never modified. */
export function highlightLine(line, language) {
  const text = String(line ?? "");
  const lang = normalizeLanguage(language);
  if (text.length === 0) return [{ text: "", style: null }];
  // Bound per-line tokenisation work; the tail is still displayed verbatim.
  if (text.length > 2000) {
    const head = text.slice(0, 2000);
    const tail = text.slice(2000);
    return [...highlightLine(head, lang), { text: tail, style: null }];
  }
  switch (lang) {
    case "javascript":
      return tokenizeJsLine(text);
    case "python":
      return tokenizePythonLine(text);
    case "shell":
      return tokenizeShellLine(text);
    case "json":
      return tokenizeJsonLine(text);
    case "diff":
      return highlightDiffLine(text);
    default:
      return [{ text, style: null }];
  }
}

/** Highlight a block, preserving line count and empty lines. */
export function highlight(code, language) {
  const lines = String(code ?? "").split("\n");
  return lines.map((line) => highlightLine(line, language));
}
