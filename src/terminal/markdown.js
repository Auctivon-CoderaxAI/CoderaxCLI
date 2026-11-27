import { TerminalSanitizer } from "./sanitize.js";
import { displayWidth, truncateToWidth, wrapSegments } from "./text.js";
import { highlightLine, normalizeLanguage } from "./highlight.js";

const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([A-Za-z0-9_+-]*)\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*)$/;
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/;
const MAX_INLINE_DEPTH = 4;

const LINK_PATTERN = /\[([^\]]+)\]\(([^)\s]+)\)/g;

function safeUrl(raw) {
  const url = String(raw ?? "").trim();
  if (url === "" || url.length > 500) return null;
  // Control characters cannot appear in a displayed link.
  if (/[\u0000-\u001f\u007f-\u009f]/.test(url)) return null;
  if (/^https?:\/\//i.test(url) || /^mailto:/i.test(url)) return url;
  return null;
}

/**
 * Parse inline markdown into styled segments. This is deliberately small: it
 * covers emphasis, code, strikethrough and links, and never interprets HTML.
 */
export function parseInline(text, depth = 0) {
  const source = String(text ?? "");
  if (source === "" || depth > MAX_INLINE_DEPTH) return [{ text: source, style: null }];

  const segments = [];
  const pattern = /(`+)([^`]+)\1|(\*\*|__)([\s\S]+?)\3|(~~)([\s\S]+?)\5|(\*|_)([^*_\n]+?)\7|(!?\[)([^\]]+)\]\(([^)\s]+)\)|<(https?:\/\/[^>\s]+)>/g;
  let cursor = 0;

  for (const match of source.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > 0 && source[index - 1] === "\\") continue;
    if (index > cursor) segments.push({ text: source.slice(cursor, index), style: null });

    const [raw, , code, , bold, , strike, , italic, , linkText, urlText, angleUrl] = match;
    if (code !== undefined) {
      segments.push({ text: code, style: "code" });
    } else if (bold !== undefined) {
      segments.push(...parseInline(bold, depth + 1).map((part) => ({ ...part, style: "bold" })));
    } else if (strike !== undefined) {
      segments.push(...parseInline(strike, depth + 1).map((part) => ({ ...part, style: "muted" })));
    } else if (italic !== undefined) {
      segments.push(...parseInline(italic, depth + 1).map((part) => ({ ...part, style: "italic" })));
    } else if (linkText !== undefined) {
      const url = safeUrl(urlText);
      const label = linkText.replace(/^!/, "");
      segments.push({ text: label, style: "link" });
      if (url && url !== label) segments.push({ text: ` (${truncateToWidth(url, 120)})`, style: "muted" });
    } else if (angleUrl !== undefined) {
      const url = safeUrl(angleUrl);
      segments.push({ text: url ?? angleUrl, style: url ? "link" : null });
    } else {
      segments.push({ text: raw, style: null });
    }
    cursor = index + raw.length;
  }

  if (cursor < source.length) segments.push({ text: source.slice(cursor), style: null });
  if (segments.length === 0) segments.push({ text: source, style: null });
  // Backslash escapes are literal text; never leave the escape marker visible.
  return segments.map((segment) =>
    segment.style === null
      ? { ...segment, text: segment.text.replace(/\\([\\`*_{}\[\]()#+\-.!>~|])/g, "$1") }
      : segment,
  );
}

function linkifyBareUrls(segments) {
  const out = [];
  for (const segment of segments) {
    if (segment.style && segment.style !== "muted") {
      out.push(segment);
      continue;
    }
    const parts = String(segment.text).split(/(https?:\/\/[^\s<>()]+)/g);
    for (const part of parts) {
      if (/^https?:\/\//i.test(part)) out.push({ text: part, style: "link" });
      else if (part) out.push({ text: part, style: segment.style ?? null });
    }
  }
  return out;
}

/**
 * Streaming markdown renderer.
 *
 * Complete lines are rendered as they arrive; the tail of an unfinished line is
 * exposed through `preview()` so a long single-paragraph answer still appears
 * live without re-rendering earlier text. Internal buffers and total rendered
 * output are capped, so a hostile or enormous response cannot exhaust memory.
 */
export class MarkdownRenderer {
  constructor({
    width = 80,
    onLines = null,
    maxRenderedChars = 2_000_000,
    maxBufferChars = 256 * 1024,
    maxCodeLines = 4000,
    maxParagraphChars = 32 * 1024,
  } = {}) {
    this.width = Math.max(20, Math.floor(width) || 80);
    this.onLines = onLines;
    this.maxRenderedChars = maxRenderedChars;
    this.maxBufferChars = maxBufferChars;
    this.maxCodeLines = maxCodeLines;
    this.maxParagraphChars = maxParagraphChars;

    this.sanitizer = new TerminalSanitizer();
    this.buffer = "";
    this.state = "normal";
    this.fence = "";
    this.codeLanguage = "plain";
    this.codeLines = 0;
    this.codeDropped = 0;
    this.paragraph = "";
    this.tableRows = [];
    this.tableHasDivider = false;
    this.renderedChars = 0;
    this.truncated = false;
    this.lastWasBlank = false;
  }

  get stats() {
    return {
      renderedChars: this.renderedChars,
      bufferChars: this.buffer.length + this.paragraph.length,
      codeLines: this.codeLines,
      truncated: this.truncated,
    };
  }

  setWidth(width) {
    this.width = Math.max(20, Math.floor(width) || this.width);
  }

  _emit(out, segments) {
    if (this.truncated) return;
    const text = segments.map((segment) => segment.text).join("");
    this.renderedChars += text.length + 1;
    if (this.renderedChars > this.maxRenderedChars) {
      this.truncated = true;
      out.push([{ text: "\u2026 response truncated by the terminal client (rendered limit reached)", style: "warn" }]);
      this.buffer = "";
      this.paragraph = "";
      this.tableRows = [];
      return;
    }
    out.push(segments);
    this.lastWasBlank = text.trim() === "";
  }

  _blank(out) {
    if (!this.lastWasBlank) this._emit(out, [{ text: "", style: null }]);
  }

  _wrap(segments, width = this.width) {
    return wrapSegments(linkifyBareUrls(segments), width);
  }

  _emitWrapped(out, segments, { prefix = "", continuation = " ".repeat(displayWidth(prefix)), gapAfter = false } = {}) {
    const prefixWidth = displayWidth(prefix);
    const lines = this._wrap(segments, Math.max(8, this.width - prefixWidth));
    lines.forEach((line, index) => {
      const lead = index === 0 ? prefix : continuation;
      this._emit(out, [{ text: lead, style: prefix ? "bullet" : null }, ...line]);
    });
    if (gapAfter) this._blank(out);
  }

  _flushParagraph(out, { gapAfter = true } = {}) {
    const text = this.paragraph.trim();
    this.paragraph = "";
    if (!text) return;
    this._emitWrapped(out, parseInline(text));
    if (gapAfter) this._blank(out);
  }

  _startCode(fence, language, out) {
    this._flushParagraph(out);
    this.state = "code";
    this.fence = fence;
    this.codeLanguage = normalizeLanguage(language);
    this.codeLines = 0;
    this.codeDropped = 0;
  }

  _finishCode(out) {
    this.state = "normal";
    this.fence = "";
    this._blank(out);
  }

  _renderCodeLine(out, line) {
    this.codeLines += 1;
    if (this.codeLines > this.maxCodeLines) {
      this.codeDropped += 1;
      if (this.codeDropped === 1) {
        this._emit(out, [{ text: `\u2026 ${this.maxCodeLines} code lines shown; further lines are hidden`, style: "muted" }]);
      }
      return;
    }
    const highlighted = highlightLine(line, this.codeLanguage);
    for (const wrapped of this._wrap(highlighted, Math.max(8, this.width - 2))) {
      this._emit(out, [{ text: "  ", style: "muted" }, ...wrapped]);
    }
  }

  _renderHeading(out, level, text) {
    this._flushParagraph(out);
    const marker = `${"#".repeat(level)} `;
    this._emitWrapped(out, [{ text: text, style: "heading" }], {
      prefix: marker,
      continuation: " ".repeat(marker.length),
    });
    this._blank(out);
  }

  _renderList(out, indent, marker, text) {
    this._flushParagraph(out);
    const depth = Math.min(3, Math.floor(indent.length / 2));
    const ordered = /^\d/.test(marker);
    const bullet = ordered ? marker.replace(/[.)]$/, ".") : "\u2022";
    let body = text;
    let checkbox = "";
    const task = /^\[([ xX])\]\s+(.*)$/.exec(text);
    if (task) {
      checkbox = `${task[1].toLowerCase() === "x" ? "\u2611" : "\u2610"} `;
      body = task[2];
    }
    const prefix = `${"  ".repeat(depth)}${bullet} ${checkbox}`;
    this._emitWrapped(out, parseInline(body), {
      prefix,
      continuation: " ".repeat(displayWidth(prefix)),
    });
  }

  _renderQuote(out, text) {
    this._flushParagraph(out);
    if (text.trim() === "") {
      this._blank(out);
      return;
    }
    this._emitWrapped(out, [{ text, style: "quote" }], { prefix: "\u2502 " });
  }

  _renderRule(out) {
    this._flushParagraph(out);
    this._emit(out, [{ text: "\u2500".repeat(Math.min(40, this.width)), style: "muted" }]);
    this._blank(out);
  }

  _startTable(line) {
    this._flushParagraph(this._tableOut ?? []);
    this.state = "table";
    this.tableRows = [line];
    this.tableHasDivider = false;
  }

  _pushTableRow(line) {
    if (this.tableRows.length >= 200) return;
    if (TABLE_DIVIDER.test(line)) {
      this.tableHasDivider = true;
      return;
    }
    this.tableRows.push(line);
  }

  _tableCells(line) {
    let body = line.trim();
    if (body.startsWith("|")) body = body.slice(1);
    if (body.endsWith("|")) body = body.slice(0, -1);
    return body.split("|").map((cell) => cell.trim().replace(/\\\|/g, "|"));
  }

  _renderTable(out) {
    const rows = this.tableRows;
    this.tableRows = [];
    this.tableHasDivider = false;
    this.state = "normal";
    if (rows.length === 0) return;

    const parsed = rows.map((row) => this._tableCells(row)).filter((cells) => cells.length > 0);
    const columns = Math.max(...parsed.map((cells) => cells.length));
    if (columns === 0 || columns > 8) {
      for (const cells of parsed) {
        this._emitWrapped(out, [{ text: cells.join("  "), style: null }]);
      }
      this._blank(out);
      return;
    }

    const widths = Array.from({ length: columns }, (_, column) =>
      Math.min(
        Math.max(3, ...parsed.map((cells) => displayWidth(cells[column] ?? ""))),
        Math.max(3, Math.floor(this.width / columns) - 3),
      ),
    );
    const renderRow = (cells, header) => {
      const segments = [];
      for (let column = 0; column < columns; column += 1) {
        const cell = truncateToWidth(cells[column] ?? "", widths[column]);
        if (column > 0) segments.push({ text: " \u2502 ", style: "muted" });
        segments.push({ text: cell, style: header ? "heading" : null });
        const missing = widths[column] - displayWidth(cell);
        if (missing > 0) segments.push({ text: " ".repeat(missing), style: null });
      }
      this._emit(out, segments);
    };

    const header = parsed[0];
    renderRow(header, true);
    this._emit(out, [
      {
        text: widths.map((width) => "\u2500".repeat(width)).join("\u2500\u253c\u2500"),
        style: "muted",
      },
    ]);
    for (const row of parsed.slice(1)) renderRow(row, false);
    this._blank(out);
  }

  _consumeLine(line, out) {
    if (this.state === "code") {
      const fence = FENCE.exec(line);
      if (fence && fence[1][0] === this.fence[0] && fence[1].length >= this.fence.length) {
        this._finishCode(out);
        return;
      }
      this._renderCodeLine(out, line);
      return;
    }

    if (this.state === "table") {
      if (TABLE_ROW.test(line)) {
        this._pushTableRow(line);
        return;
      }
      this._renderTable(out);
      // Fall through: the current line belongs to normal markdown.
    }

    const fence = FENCE.exec(line);
    if (fence) {
      this._startCode(fence[1], fence[2], out);
      return;
    }

    if (line.trim() === "") {
      this._flushParagraph(out);
      this._blank(out);
      return;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      this._renderHeading(out, heading[1].length, heading[2].trim());
      return;
    }

    if (RULE.test(line)) {
      this._renderRule(out);
      return;
    }

    const quote = QUOTE.exec(line);
    if (quote) {
      this._renderQuote(out, quote[1]);
      return;
    }

    const list = LIST.exec(line);
    if (list) {
      this._renderList(out, list[1], list[2], list[3]);
      return;
    }

    if (TABLE_ROW.test(line) && line.includes("|", line.indexOf("|") + 1)) {
      this._flushParagraph(out);
      this.state = "table";
      this.tableRows = [line];
      this.tableHasDivider = false;
      return;
    }

    // Treat plainly indented code as a paragraph: guessing here misformats
    // ordinary prose and list continuations.
    this.paragraph = this.paragraph === "" ? line.trim() : `${this.paragraph} ${line.trim()}`;
    // A completed source line is safe to display immediately. Paragraphs that
    // wrap across several source lines still read as consecutive lines rather
    // than waiting for a blank line, which matters for streaming answers.
    this._flushParagraph(out, { gapAfter: false });
  }

  feed(chunk) {
    if (this.truncated) return [];
    const safe = this.sanitizer.push(chunk);
    if (!safe) return [];
    this.buffer += safe;

    const out = [];
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1 && !this.truncated) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      this._consumeLine(line, out);
      newline = this.buffer.indexOf("\n");
    }

    if (!this.truncated && this.buffer.length > this.maxBufferChars) {
      // A single line larger than the buffer cap: render it in bounded pieces
      // rather than growing without limit.
      if (this.state === "code") {
        const piece = this.buffer.slice(0, this.maxBufferChars);
        this.buffer = this.buffer.slice(this.maxBufferChars);
        this._renderCodeLine(out, piece);
      } else {
        this.paragraph = `${this.paragraph}${this.paragraph ? " " : ""}${this.buffer}`;
        this.buffer = "";
        if (this.paragraph.length > Math.min(this.maxParagraphChars, this.maxBufferChars)) {
          this._flushParagraph(out, { gapAfter: false });
        }
      }
    }

    if (out.length > 0) this.onLines?.(out);
    return out;
  }

  flush() {
    const out = [];
    if (this.truncated) return out;
    this.sanitizer.flush();
    if (this.buffer !== "") {
      const line = this.buffer;
      this.buffer = "";
      this._consumeLine(line, out);
    }
    if (this.state === "code") this._finishCode(out);
    if (this.state === "table") this._renderTable(out);
    this._flushParagraph(out);
    if (out.length > 0) this.onLines?.(out);
    return out;
  }

  /** A one-line tail of the unfinished block, for live rendering. */
  preview(maxChars = 240) {
    if (this.truncated) return "";
    const source =
      this.state === "table"
        ? ""
        : this.state === "code"
          ? this.buffer
          : `${this.paragraph}${this.paragraph && this.buffer ? " " : ""}${this.buffer}`;
    const text = source.replace(/\s+/g, " ").trim();
    if (text === "") return "";
    return text.length > maxChars ? `\u2026${text.slice(-maxChars)}` : text;
  }

  /** Begin a revised answer: earlier output stays, the new text is rendered. */
  replace(text, { notice = true } = {}) {
    this.sanitizer = new TerminalSanitizer();
    this.buffer = "";
    this.paragraph = "";
    this.tableRows = [];
    this.tableHasDivider = false;
    this.state = "normal";
    const out = notice
      ? [[{ text: "\u21ba response revised by the server", style: "muted" }], [{ text: "", style: null }]]
      : [];
    out.push(...this.feed(text ?? ""));
    // A replacement is a complete snapshot, so render it now instead of
    // waiting for the next newline or the end of the stream.
    out.push(...this.flush());
    return out;
  }
}

export { safeUrl };
