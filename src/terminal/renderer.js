/**
 * Terminal presentation.
 *
 * Interactive mode draws a prompt region below streaming output and repaints
 * only when its state changes. The last response block is kept, bounded, so a
 * resize can reflow it; everything else lives in the terminal's own scrollback,
 * not in this process. Accessible mode is line-oriented and performs no cursor
 * addressing or animation.
 */

import { sanitizeTerminalText, sanitizeOneLine } from "./sanitize.js";
import { displayWidth, truncateToWidth, wrapSegments } from "./text.js";
import { createTheme } from "./theme.js";

const MAX_BLOCK_LINES = 200;
const MAX_BLOCK_CHARS = 64 * 1024;

function safeSegments(segments) {
  return segments.map((segment) => ({
    text: sanitizeTerminalText(segment.text ?? "", { maxChars: 100_000 }),
    style: segment.style ?? null,
  }));
}

export class TerminalRenderer {
  constructor({
    write = (text) => process.stdout.write(text),
    width = 80,
    mode = "interactive",
    theme = createTheme(),
    maxBlockLines = MAX_BLOCK_LINES,
    maxBlockChars = MAX_BLOCK_CHARS,
  } = {}) {
    this.write = write;
    this.width = Math.max(20, Math.floor(width) || 80);
    this.mode = mode === "accessible" || mode === "plain" ? "accessible" : "interactive";
    this.theme = theme;
    this.maxBlockLines = maxBlockLines;
    this.maxBlockChars = maxBlockChars;

    this.promptRows = 0;
    this.cursorRow = 0;
    this.promptOpen = false;
    this.block = null;
    this.lastStateKey = null;
    this.preview = "";
    this.status = null;
  }

  get interactive() {
    return this.mode === "interactive";
  }

  _raw(text) {
    if (text) this.write(text);
  }

  /** Erase the prompt region and leave the cursor at its first row. */
  erasePrompt() {
    if (!this.interactive || this.promptRows === 0) {
      this.promptRows = 0;
      this.cursorRow = 0;
      return;
    }
    const below = Math.max(0, this.promptRows - 1 - this.cursorRow);
    let sequence = "";
    if (below > 0) sequence += `\u001b[${below}B`;
    sequence += "\r";
    if (this.promptRows > 1) sequence += `\u001b[${this.promptRows - 1}A`;
    sequence += "\u001b[0J";
    this._raw(sequence);
    this.promptRows = 0;
    this.cursorRow = 0;
    this.lastStateKey = null;
  }

  startResponse() {
    this.block = { lines: [], rows: 0, chars: 0, redrawable: true };
  }

  endResponse() {
    // Keep the block for a resize reflow, but never grow it further.
    if (this.block) {
      this.block.lines = this.block.lines.slice(-this.maxBlockLines);
    }
  }

  _appendBlock(lines) {
    if (!this.block) return;
    this.block.rows += lines.length;
    for (const line of lines) {
      const chars = line.reduce((sum, segment) => sum + String(segment.text ?? "").length, 0);
      if (this.block.lines.length >= this.maxBlockLines || this.block.chars + chars > this.maxBlockChars) {
        this.block.redrawable = false;
        continue;
      }
      this.block.lines.push(line);
      this.block.chars += chars;
    }
  }

  /**
   * Write completed lines above the prompt.
   * @param {Array<Array<{text:string,style?:string}>>} lines
   */
  writeLines(lines, { record = true } = {}) {
    if (!Array.isArray(lines) || lines.length === 0) return;
    if (this.mode === "accessible") {
      for (const line of lines) {
        const text = line.map((segment) => segment.text ?? "").join("");
        this._raw(`${sanitizeTerminalText(text)}\n`);
      }
      return;
    }

    this.erasePrompt();
    const rows = [];
    for (const line of lines) {
      const wrapped = wrapSegments(safeSegments(line), this.width);
      for (const row of wrapped) rows.push(row);
    }
    for (const row of rows) {
      this._raw(`${this.theme.renderSegments(row)}\r\n`);
    }
    if (record) this._appendBlock(rows);
    // Output that is not part of the block (a notice) sits between the block
    // and the prompt, so the block can no longer be erased by row count alone.
    else if (this.block) this.block.redrawable = false;
    this.lastStateKey = null;
  }

  /** Write a plain notice line. */
  note(text, style = "muted") {
    this.writeLines([[{ text: String(text), style }]], { record: false });
  }

  setStatus(status) {
    this.status = status ?? null;
  }

  setPreview(text) {
    const line = sanitizeOneLine(text ?? "", 400);
    if (line === this.preview) return;
    this.preview = line;
    this.lastStateKey = null;
  }

  _editorRows(editor, prompt) {
    const rendered = editor.render(this.width, { prompt });
    const rows = rendered.lines.map((line) => [{ text: line.text, style: null }]);
    return { rows, cursor: rendered.cursor };
  }

  _statusRows() {
    const rows = [];
    if (this.preview) {
      rows.push([{ text: `  ${truncateToWidth(this.preview, Math.max(10, this.width - 4))}`, style: "muted" }]);
    }
    if (this.status && (this.status.busy || this.status.label || this.status.detail)) {
      const frame = this.status.busy ? `${this.status.frame ?? ""} ` : "";
      const detail = this.status.detail ? ` \u00b7 ${this.status.detail}` : "";
      rows.push([
        {
          text: `${frame}${this.status.label ?? ""}${detail}`,
          style: this.status.busy ? "accent" : "muted",
        },
      ]);
    }
    return rows;
  }

  _permissionRows(permission) {
    const request = permission.entry.request;
    const rows = [
      [{ text: "\u26a0 Permission requested", style: "permission" }],
      [{ text: `  action     ${request.action}`, style: null }],
      [{ text: `  resource   ${request.displayResource}`, style: null }],
      [{ text: `  execution  ${request.executionId}`, style: "muted" }],
      [{ text: `  request    ${request.requestId}`, style: "muted" }],
    ];
    if (request.reason) rows.push([{ text: `  reason     ${request.reason}`, style: "muted" }]);
    rows.push([{ text: "", style: null }]);
    permission.options.forEach((option, index) => {
      const selected = index === permission.selected;
      rows.push([
        {
          text: `${selected ? "\u276f" : " "} ${option.key}) ${option.label}`,
          style: selected ? "inverse" : null,
        },
      ]);
    });
    rows.push([{ text: "  Esc denies. Approval is bound to this exact request and resource.", style: "muted" }]);
    return rows;
  }

  _menuRows(menu) {
    const rows = [[{ text: menu.title ?? "Select", style: "heading" }]];
    const windowSize = 8;
    const total = menu.options.length;
    const selected = menu.selected ?? 0;
    const start = Math.max(0, Math.min(selected - Math.floor(windowSize / 2), Math.max(0, total - windowSize)));
    const end = Math.min(total, start + windowSize);
    for (let index = start; index < end; index += 1) {
      const option = menu.options[index];
      const isSelected = index === selected;
      const description = option.description ? `  ${option.description}` : "";
      rows.push([
        {
          text: `${isSelected ? "\u276f" : " "} ${option.value}${description}`,
          style: isSelected ? "inverse" : null,
        },
      ]);
    }
    if (total > windowSize) rows.push([{ text: `  ${selected + 1}/${total}`, style: "muted" }]);
    rows.push([{ text: menu.hint ?? "Enter selects \u00b7 Esc cancels", style: "muted" }]);
    return rows;
  }

  drawPrompt(state = {}) {
    if (this.mode === "accessible") {
      // Input is line-oriented; menus and approvals are printed as numbered
      // choices, never as a cursor-addressed screen.
      const key = JSON.stringify({ menu: state.menu ?? null, permission: state.permission ?? null });
      if (key === this.lastStateKey) return;
      this.lastStateKey = key;
      if (state.permission) {
        for (const row of this._permissionRows(state.permission)) {
          this._raw(`${row.map((segment) => segment.text).join("")}\n`);
        }
      } else if (state.menu) {
        for (const row of this._menuRows(state.menu)) {
          this._raw(`${row.map((segment) => segment.text).join("")}\n`);
        }
      }
      return;
    }

    const { editor = null, prompt = "", menu = null, permission = null } = state;
    let rows;
    let cursor = { row: 0, col: displayWidth(prompt) };
    if (permission) {
      rows = this._permissionRows(permission);
      cursor = { row: rows.length - 1, col: 0 };
    } else if (menu) {
      rows = this._menuRows(menu);
      cursor = { row: rows.length - 1, col: 0 };
    } else {
      const rendered = this._editorRows(editor, prompt);
      rows = rendered.rows;
      cursor = rendered.cursor;
      const statusRows = this._statusRows();
      rows = [...rows, ...statusRows];
    }

    // Never let a prompt region exceed the terminal height.
    if (rows.length > 3) rows = rows.slice(-Math.max(3, rows.length));
    const key = JSON.stringify({
      rows: rows.map((row) => row.map((segment) => `${segment.style ?? ""}:${segment.text}`).join("")),
      cursor,
    });
    if (key === this.lastStateKey && this.promptRows > 0) return;
    this.lastStateKey = key;

    this.erasePrompt();
    rows.forEach((row, index) => {
      this._raw(`\r${this.theme.renderSegments(safeSegments(row))}`);
      if (index < rows.length - 1) this._raw("\r\n");
    });
    this.promptRows = rows.length;
    this.cursorRow = cursor.row;

    const up = rows.length - 1 - cursor.row;
    let sequence = "\r";
    if (up > 0) sequence += `\u001b[${up}A`;
    if (cursor.col > 0) sequence += `\u001b[${cursor.col}C`;
    this._raw(sequence);
    this.promptOpen = true;
  }

  /** Start a prompt: interactive draws it, accessible prints the label once. */
  beginInput({ prompt = "\u203a ", editor = null } = {}) {
    if (this.mode === "accessible") {
      this._raw(prompt);
      this.promptOpen = true;
      return;
    }
    this.drawPrompt({ prompt, editor });
  }

  updateInput({ prompt = "\u203a ", editor = null } = {}) {
    if (this.mode === "accessible") return;
    this.drawPrompt({ prompt, editor });
  }

  /** The user submitted input; accessible mode ends the echoed line. */
  endInput() {
    if (this.mode === "accessible") {
      if (this.promptOpen) this._raw("\n");
      this.promptOpen = false;
      return;
    }
    this.erasePrompt();
    this.promptOpen = false;
  }

  showMenu(menu) {
    if (this.mode === "accessible") {
      const rows = this._menuRows(menu);
      for (const row of rows) this._raw(`${row.map((segment) => segment.text).join("")}\n`);
      this.lastStateKey = JSON.stringify({ menu, permission: null });
      return;
    }
    this.drawPrompt({ menu });
  }

  showPermission(permission) {
    if (this.mode === "accessible") {
      for (const row of this._permissionRows(permission)) {
        this._raw(`${row.map((segment) => segment.text).join("")}\n`);
      }
      this.lastStateKey = JSON.stringify({ menu: null, permission });
      return;
    }
    this.drawPrompt({ permission });
  }

  clearScreen() {
    if (this.mode === "interactive") {
      this.erasePrompt();
      this._raw("\u001b[2J\u001b[H");
      this.block = null;
      this.lastStateKey = null;
    }
  }

  resize(width) {
    const next = Math.max(20, Math.floor(width) || this.width);
    if (next === this.width) return;
    const previous = this.width;
    this.width = next;
    if (this.mode === "accessible") return;

    this.erasePrompt();
    if (this.block && this.block.redrawable && this.block.rows > 0) {
      this._raw(`\u001b[${this.block.rows}A\r\u001b[0J`);
      const rows = [];
      for (const line of this.block.lines) {
        for (const row of wrapSegments(safeSegments(line), this.width)) rows.push(row);
      }
      for (const row of rows) this._raw(`${this.theme.renderSegments(row)}\r\n`);
      this.block.rows = rows.length;
      this.block.chars = rows.reduce(
        (sum, row) => sum + row.reduce((lineSum, segment) => lineSum + segment.text.length, 0),
        0,
      );
    } else {
      this._raw(`\u001b[2m[resized ${previous} \u2192 ${this.width} columns]\u001b[0m\r\n`);
    }
    this.lastStateKey = null;
  }

  /** Count rows a response block currently occupies. */
  get blockRows() {
    return this.block?.rows ?? 0;
  }
}
