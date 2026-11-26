/**
 * Multiline line editor.
 *
 * State is stored as grapheme arrays so cursor movement and backspace never
 * split a surrogate pair, combining mark or emoji sequence. Rendering returns
 * styled lines plus a display-column cursor position for the renderer.
 */

import { displayWidth, graphemes, wrapText } from "./text.js";

const DEFAULT_MAX_CHARS = 100_000;
const DEFAULT_MAX_LINES = 200;

export class Editor {
  constructor({ text = "", maxChars = DEFAULT_MAX_CHARS, maxLines = DEFAULT_MAX_LINES } = {}) {
    this.maxChars = maxChars;
    this.maxLines = maxLines;
    this.lines = [[]];
    this.row = 0;
    this.col = 0;
    this.historyIndex = 0;
    this.setValue(text);
  }

  get length() {
    return this.lines.reduce((sum, line) => sum + line.length, 0) + this.lines.length - 1;
  }

  setValue(text) {
    const normalized = String(text ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const parts = normalized.split("\n");
    this.lines = parts.map((line) => graphemes(line));
    this.row = this.lines.length - 1;
    this.col = this.lines[this.row].length;
  }

  get value() {
    return this.lines.map((line) => line.join("")).join("\n");
  }

  get isEmpty() {
    return this.value.trim() === "";
  }

  clear() {
    this.lines = [[]];
    this.row = 0;
    this.col = 0;
  }

  _clamp() {
    this.row = Math.max(0, Math.min(this.row, this.lines.length - 1));
    this.col = Math.max(0, Math.min(this.col, this.lines[this.row].length));
  }

  _overLimit(extraLines = 0, extraChars = 0) {
    return (
      this.length + extraLines + extraChars > this.maxChars ||
      this.lines.length + extraLines > this.maxLines
    );
  }

  insert(text) {
    const parts = String(text ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    const graphemeParts = parts.map((part) => graphemes(part));
    const addedChars = graphemeParts.reduce((sum, part) => sum + part.length, 0);
    if (this._overLimit(graphemeParts.length - 1, addedChars)) {
      // Keep the editor bounded; the prefix that fits is still inserted.
      const remaining = Math.max(0, this.maxChars - this.length);
      if (remaining === 0) return { action: "too-large", inserted: false };
      const head = graphemeParts[0].slice(0, remaining);
      graphemeParts[0] = head;
      graphemeParts.length = 1;
    }
    if (graphemeParts.length === 1) {
      this.lines[this.row].splice(this.col, 0, ...graphemeParts[0]);
      this.col += graphemeParts[0].length;
      return { action: null, inserted: true };
    }

    const [first, ...rest] = graphemeParts;
    const current = this.lines[this.row];
    const before = current.slice(0, this.col);
    const after = current.slice(this.col);
    const last = rest.pop() ?? [];
    this.lines.splice(
      this.row,
      1,
      [...before, ...first],
      ...rest.map((line) => [...line]),
      [...last, ...after],
    );
    this.row += graphemeParts.length - 1;
    this.col = last.length;
    this._clamp();
    return { action: null, inserted: true };
  }

  backspace() {
    if (this.col > 0) {
      this.lines[this.row].splice(this.col - 1, 1);
      this.col -= 1;
      return;
    }
    if (this.row > 0) {
      const previous = this.lines[this.row - 1];
      const current = this.lines[this.row];
      this.col = previous.length;
      this.lines[this.row - 1] = [...previous, ...current];
      this.lines.splice(this.row, 1);
      this.row -= 1;
    }
  }

  deleteForward() {
    const line = this.lines[this.row];
    if (this.col < line.length) {
      line.splice(this.col, 1);
      return;
    }
    if (this.row < this.lines.length - 1) {
      line.push(...this.lines[this.row + 1]);
      this.lines.splice(this.row + 1, 1);
    }
  }

  deleteWordBefore() {
    if (this.col === 0) {
      this.backspace();
      return;
    }
    const line = this.lines[this.row];
    let index = this.col;
    while (index > 0 && /\s/.test(line[index - 1])) index -= 1;
    while (index > 0 && !/\s/.test(line[index - 1])) index -= 1;
    line.splice(index, this.col - index);
    this.col = index;
  }

  killToEnd() {
    this.lines[this.row] = this.lines[this.row].slice(0, this.col);
  }

  killToStart() {
    this.lines[this.row] = this.lines[this.row].slice(this.col);
    this.col = 0;
  }

  newline() {
    if (this._overLimit(1)) return { action: "too-large" };
    const line = this.lines[this.row];
    const after = line.slice(this.col);
    this.lines[this.row] = line.slice(0, this.col);
    this.lines.splice(this.row + 1, 0, after);
    this.row += 1;
    this.col = 0;
    return { action: null };
  }

  moveLeft() {
    if (this.col > 0) this.col -= 1;
    else if (this.row > 0) {
      this.row -= 1;
      this.col = this.lines[this.row].length;
    }
  }

  moveRight() {
    if (this.col < this.lines[this.row].length) this.col += 1;
    else if (this.row < this.lines.length - 1) {
      this.row += 1;
      this.col = 0;
    }
  }

  moveWordLeft() {
    let line = this.lines[this.row];
    let index = this.col;
    while (index > 0 && /\s/.test(line[index - 1])) index -= 1;
    while (index > 0 && !/\s/.test(line[index - 1])) index -= 1;
    if (index === 0 && this.col === 0 && this.row > 0) {
      this.row -= 1;
      this.col = this.lines[this.row].length;
      return;
    }
    this.col = index;
  }

  moveWordRight() {
    const line = this.lines[this.row];
    let index = this.col;
    while (index < line.length && !/\s/.test(line[index])) index += 1;
    while (index < line.length && /\s/.test(line[index])) index += 1;
    this.col = index;
  }

  moveUp() {
    if (this.row === 0) return false;
    this.row -= 1;
    this._clamp();
    return true;
  }

  moveDown() {
    if (this.row >= this.lines.length - 1) return false;
    this.row += 1;
    this._clamp();
    return true;
  }

  moveHome() {
    this.col = 0;
  }

  moveEnd() {
    this.col = this.lines[this.row].length;
  }

  setCursor(row, col) {
    this.row = row;
    this.col = col;
    this._clamp();
  }

  /**
   * Apply a semantic key event. Returns an action for the session to handle.
   */
  handleKey(event) {
    if (!event) return { action: null };
    if (event.type === "paste") {
      this.insert(event.text);
      return { action: null };
    }
    if (event.type === "text") {
      this.insert(event.text);
      return { action: null };
    }
    if (event.type !== "key") return { action: null };

    const { name, ctrl = false, alt = false } = event;

    if (ctrl) {
      switch (name) {
        case "a": this.moveHome(); return { action: null };
        case "e": this.moveEnd(); return { action: null };
        case "b": this.moveLeft(); return { action: null };
        case "f": this.moveRight(); return { action: null };
        case "left": this.moveWordLeft(); return { action: null };
        case "right": this.moveWordRight(); return { action: null };
        case "h": this.backspace(); return { action: null };
        case "d": return this.isEmpty ? { action: "eof" } : (this.deleteForward(), { action: null });
        case "k": this.killToEnd(); return { action: null };
        case "u": this.killToStart(); return { action: null };
        case "w": this.deleteWordBefore(); return { action: null };
        case "j": return this.newline();
        case "l": return { action: "redraw" };
        case "c": return { action: "cancel" };
        case "p": return { action: "history-prev" };
        case "n": return { action: "history-next" };
        case "r": return { action: "search" };
        default: return { action: null };
      }
    }

    if (alt) {
      switch (name) {
        case "enter": return this.newline();
        case "b": this.moveWordLeft(); return { action: null };
        case "f": this.moveWordRight(); return { action: null };
        case "left": this.moveWordLeft(); return { action: null };
        case "right": this.moveWordRight(); return { action: null };
        default: return { action: null };
      }
    }

    switch (name) {
      case "enter":
        return { action: "submit" };
      case "tab":
        return { action: "complete" };
      case "backspace":
        this.backspace();
        return { action: null };
      case "delete":
        this.deleteForward();
        return { action: null };
      case "left":
        this.moveLeft();
        return { action: null };
      case "right":
        this.moveRight();
        return { action: null };
      case "up":
        if (this.moveUp()) return { action: null };
        return { action: "history-prev" };
      case "down":
        if (this.moveDown()) return { action: null };
        return { action: "history-next" };
      case "home":
        this.moveHome();
        return { action: null };
      case "end":
        this.moveEnd();
        return { action: null };
      case "pageup":
        return { action: "history-prev" };
      case "pagedown":
        return { action: "history-next" };
      case "escape":
        return { action: "cancel" };
      case "alt":
        this.insert(event.char ?? "");
        return { action: null };
      default:
        return { action: null };
    }
  }

  /**
   * Render the editor into display lines. The prompt occupies cells on the
   * first line only; continuation lines are indented to align with it.
   */
  render(width, { prompt = "" } = {}) {
    const safeWidth = Math.max(4, Math.floor(width) || 80);
    const promptWidth = displayWidth(prompt);
    const available = Math.max(1, safeWidth - promptWidth);
    const lines = [];
    let cursor = { row: 0, col: promptWidth };

    this.lines.forEach((line, lineIndex) => {
      const text = line.join("");
      const segments = wrapText(text, available);
      let cursorColumn = null;
      if (lineIndex === this.row) {
        cursorColumn = displayWidth(line.slice(0, this.col).join(""));
      }
      let offset = 0;
      segments.forEach((segment, segmentIndex) => {
        const lead = lineIndex === 0 && segmentIndex === 0 ? prompt : " ".repeat(promptWidth);
        lines.push({ text: `${lead}${segment}`, promptWidth });
        if (cursorColumn !== null && cursorColumn >= offset && cursorColumn <= offset + displayWidth(segment)) {
          cursor = { row: lines.length - 1, col: promptWidth + (cursorColumn - offset) };
        }
        offset += displayWidth(segment);
      });
      // An empty line still needs a row to hold the prompt/cursor.
      if (segments.length === 0) {
        lines.push({ text: lineIndex === 0 ? prompt : " ".repeat(promptWidth), promptWidth });
        if (lineIndex === this.row) cursor = { row: lines.length - 1, col: promptWidth };
      }
    });

    // A cursor at the exact right edge wraps; add a continuation row so it is
    // visible instead of sitting beyond the terminal edge.
    if (cursor.col >= safeWidth) {
      lines.push({ text: " ".repeat(promptWidth), promptWidth });
      cursor = { row: lines.length - 1, col: promptWidth };
    }

    return { lines, cursor };
  }
}
