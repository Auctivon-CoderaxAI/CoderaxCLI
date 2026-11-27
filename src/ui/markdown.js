import { sanitizeTerminalText, stripAnsi, visibleLength, wrapPlain } from "./ansi.js";

const KEYWORDS = new Set([
  "const", "let", "var", "function", "return", "if", "else", "for", "while", "class",
  "import", "export", "from", "await", "async", "new", "throw", "try", "catch", "finally",
  "switch", "case", "break", "continue", "default", "extends", "implements", "interface",
  "type", "enum", "public", "private", "protected", "static", "readonly", "def", "elif",
  "except", "with", "as", "in", "is", "not", "and", "or", "None", "True", "False", "self",
  "package", "func", "go", "defer", "select", "struct", "map", "range", "fn", "impl", "use",
]);

const CODE_LANGUAGES = new Set([
  "js", "javascript", "jsx", "ts", "typescript", "tsx", "json", "bash", "sh", "shell",
  "zsh", "diff", "patch", "python", "py", "go", "rust", "rs", "sql", "yaml", "yml",
  "html", "css", "md", "markdown", "text", "txt", "console", "log",
]);

function splitTableRow(line) {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

function isTableSeparator(line) {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line);
}

function isTableLine(line) {
  return /^\s*\|.*\|\s*$/.test(line);
}

function highlight(line, language, style) {
  if (language === "diff" || language === "patch") {
    if (line.startsWith("+++") || line.startsWith("---")) return style.bold(line);
    if (line.startsWith("+")) return style.green(line);
    if (line.startsWith("-")) return style.red(line);
    if (line.startsWith("@@")) return style.cyan(line);
    return style.dim(line);
  }
  const known = CODE_LANGUAGES.has(language);
  if (!known) return line;
  const token = /(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\b\d+(?:\.\d+)?\b|\b[A-Za-z_$][\w$]*\b)/g;
  let output = "";
  let last = 0;
  for (const match of line.matchAll(token)) {
    output += line.slice(last, match.index);
    const value = match[0];
    if (value.startsWith("//") || value.startsWith("#") || value.startsWith("/*")) {
      output += style.gray(value);
    } else if (value.startsWith("\"") || value.startsWith("'") || value.startsWith("`")) {
      output += style.green(value);
    } else if (/^\d/.test(value)) {
      output += style.yellow(value);
    } else if (KEYWORDS.has(value)) {
      output += style.magenta(value);
    } else {
      output += value;
    }
    last = match.index + value.length;
  }
  output += line.slice(last);
  return output;
}

/**
 * Incremental Markdown renderer. It consumes the stream a line at a time so a
 * long answer appears while it is generated, and buffers only the constructs
 * that need lookahead (tables and an open code fence).
 */
export class MarkdownRenderer {
  constructor({ write, width = 100, style, indent = 0 } = {}) {
    if (typeof write !== "function") throw new TypeError("MarkdownRenderer requires a write function");
    this.writeRaw = write;
    this.width = Math.max(24, width);
    this.style = style;
    this.indent = indent;
    this.buffer = "";
    this.code = null;
    this.table = [];
    this.wroteAny = false;
    this.finished = false;
  }

  #line(text) {
    this.wroteAny = true;
    this.writeRaw(`${text}\n`);
  }

  #blank() {
    this.writeRaw("\n");
  }

  write(chunk) {
    if (this.finished) return;
    const clean = sanitizeTerminalText(String(chunk)).replace(/\r\n/g, "\n");
    if (clean.length === 0) return;
    this.buffer += clean;
    let index = this.buffer.indexOf("\n");
    while (index !== -1) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      this.#lineFeed(line);
      index = this.buffer.indexOf("\n");
    }
  }

  end() {
    if (this.finished) return;
    if (this.buffer.length > 0) {
      this.#lineFeed(this.buffer);
      this.buffer = "";
    }
    this.#flushTable();
    if (this.code) {
      this.#codeClose();
      this.code = null;
    }
    this.finished = true;
  }

  #lineFeed(line) {
    const normalized = line.replace(/\t/g, "  ");

    if (this.code) {
      const closing = normalized.match(/^\s*(`{3,}|~{3,})\s*$/);
      if (closing && closing[1][0] === this.code.marker && closing[1].length >= this.code.length) {
        this.#codeClose();
        this.code = null;
        return;
      }
      this.#codeLine(normalized);
      return;
    }

    if (isTableLine(normalized)) {
      this.table.push(normalized);
      return;
    }
    this.#flushTable();

    const fence = normalized.match(/^\s*(`{3,}|~{3,})\s*([\w+-]*)\s*$/);
    if (fence) {
      this.code = { marker: fence[1][0], length: fence[1].length, language: (fence[2] || "text").toLowerCase(), lines: 0 };
      const label = this.code.language;
      this.#line(`${" ".repeat(this.indent)}${this.style.dim(`\u250c\u2500 ${label}`)}`);
      return;
    }

    const heading = normalized.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      const text = this.#inline(heading[2]);
      this.#blank();
      this.#line(`${" ".repeat(this.indent)}${this.style.bold(level <= 2 ? this.style.brightCyan(text) : text)}`);
      if (level <= 2) this.#line(`${" ".repeat(this.indent)}${this.style.dim("\u2500".repeat(Math.min(this.width - this.indent, Math.max(8, stripAnsi(text).length))))}`);
      this.#blank();
      return;
    }

    const rule = normalized.match(/^\s*([-*_])\s*\1\s*\1[\s\1]*$/);
    if (rule) {
      this.#line(`${" ".repeat(this.indent)}${this.style.dim("\u2500".repeat(Math.min(this.width - this.indent, 60)))}`);
      return;
    }

    const quote = normalized.match(/^\s*>\s?(.*)$/);
    if (quote) {
      for (const wrapped of wrapPlain(quote[1], this.width - this.indent - 2)) {
        this.#line(`${" ".repeat(this.indent)}${this.style.gray("\u2502")} ${this.style.italic(this.#inline(wrapped))}`);
      }
      return;
    }

    const list = normalized.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (list) {
      const depth = Math.floor(list[1].length / 2);
      const marker = /^\d/.test(list[2]) ? list[2] : "\u2022";
      const prefix = `${" ".repeat(this.indent + depth * 2)}${this.style.cyan(marker)} `;
      const bodyWidth = this.width - visibleLength(prefix);
      const wrapped = wrapPlain(list[3], bodyWidth, { hangingIndent: visibleLength(prefix) });
      wrapped.forEach((entry, index) => {
        if (index === 0) {
          this.#line(`${prefix}${this.#inline(entry)}`);
        } else {
          this.#line(`${" ".repeat(visibleLength(prefix))}${this.#inline(entry.trimStart())}`);
        }
      });
      return;
    }

    if (normalized.trim() === "") {
      this.#blank();
      return;
    }

    const wrapped = wrapPlain(normalized.trim(), this.width - this.indent);
    for (const entry of wrapped) {
      this.#line(`${" ".repeat(this.indent)}${this.#inline(entry)}`);
    }
  }

  #codeLine(line) {
    this.code.lines += 1;
    const prefix = `${" ".repeat(this.indent)}${this.style.dim("\u2502")} `;
    this.#line(`${prefix}${highlight(line, this.code.language, this.style)}`);
  }

  #codeClose() {
    this.#line(`${" ".repeat(this.indent)}${this.style.dim("\u2514\u2500")}`);
  }

  #flushTable() {
    if (this.table.length === 0) return;
    const lines = this.table;
    this.table = [];
    if (lines.length < 2 || !isTableSeparator(lines[1])) {
      for (const line of lines) this.#line(`${" ".repeat(this.indent)}${this.#inline(line)}`);
      return;
    }
    const header = splitTableRow(lines[0]);
    const rows = lines.slice(2).map(splitTableRow).filter((row) => row.length > 0);
    const columns = header.length;
    const widths = header.map((cell, index) => {
      const values = [cell, ...rows.map((row) => row[index] ?? "")];
      return Math.min(48, Math.max(3, ...values.map((value) => visibleLength(value))));
    });
    const total = widths.reduce((sum, value) => sum + value, 0) + (columns - 1) * 3;
    const available = this.width - this.indent;
    if (total > available) {
      let excess = total - available;
      while (excess > 0) {
        const widest = widths.indexOf(Math.max(...widths));
        if (widths[widest] <= 3) break;
        widths[widest] -= 1;
        excess -= 1;
      }
    }
    const renderRow = (cells, bold) => {
      const parts = cells.map((cell, index) => {
        const text = visibleLength(cell) > widths[index] ? `${cell.slice(0, widths[index] - 1)}\u2026` : cell;
        return bold ? this.style.bold(text.padEnd(widths[index])) : text.padEnd(widths[index]);
      });
      return `${" ".repeat(this.indent)}\u2502 ${parts.join(" \u2502 ")} \u2502`;
    };
    const border = (left, mid, right) =>
      `${" ".repeat(this.indent)}${left}${widths.map((width) => "\u2500".repeat(width + 2)).join(mid)}${right}`;
    this.#line(this.style.dim(border("\u250c", "\u252c", "\u2510")));
    this.#line(renderRow(header, true));
    this.#line(this.style.dim(border("\u251c", "\u253c", "\u2524")));
    for (const row of rows) {
      this.#line(renderRow(Array.from({ length: columns }, (_, index) => row[index] ?? ""), false));
    }
    this.#line(this.style.dim(border("\u2514", "\u2534", "\u2518")));
  }

  #inline(text) {
    const source = String(text);
    const pattern = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*\s][^*]*\*|_[^_\s][^_]*_|~~[^~]+~~|\[[^\]]+\]\([^)]+\))/g;
    let output = "";
    let last = 0;
    for (const match of source.matchAll(pattern)) {
      output += source.slice(last, match.index);
      const token = match[0];
      if (token.startsWith("`")) {
        output += this.style.wrap([36], token.slice(1, -1));
      } else if (token.startsWith("**") || token.startsWith("__")) {
        output += this.style.bold(token.slice(2, -2));
      } else if (token.startsWith("~~")) {
        output += this.style.strike(token.slice(2, -2));
      } else if (token.startsWith("[")) {
        const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
        output += link ? `${this.style.underline(link[1])} ${this.style.gray(`(${link[2]})`)}` : token;
      } else {
        output += this.style.italic(token.slice(1, -1));
      }
      last = match.index + token.length;
    }
    output += source.slice(last);
    return output;
  }
}

export function renderMarkdown(text, { width = 100, style, write = (value) => process.stdout.write(value), indent = 0 } = {}) {
  const renderer = new MarkdownRenderer({ write, width, style, indent });
  renderer.write(text);
  renderer.end();
  return renderer;
}
