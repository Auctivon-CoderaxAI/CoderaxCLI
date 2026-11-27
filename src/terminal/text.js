/**
 * Width-aware text handling for terminals.
 *
 * Terminals are cell grids, not character sequences: CJK characters and emoji
 * occupy two cells, combining marks occupy none, and tabs expand. Wrapping by
 * `string.length` corrupts the layout and breaks the cursor, so every width
 * decision goes through `Intl.Segmenter` and an East Asian width table.
 */

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
const TAB_WIDTH = 4;

const WIDE_RANGES = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f],
  [0x1f680, 0x1f6ff],
  [0x1f900, 0x1f9ff],
  [0x1fa70, 0x1faff],
  [0x20000, 0x3fffd],
];

// Pictographs that default to text presentation in most terminals.
const TEXT_DEFAULT_PICTOGRAPHS = new Set([
  0x00a9, 0x00ae, 0x2122, 0x2139, 0x2194, 0x2195, 0x2196, 0x2197, 0x2198,
  0x2199, 0x21a9, 0x21aa, 0x231a, 0x231b, 0x2328, 0x23cf, 0x23ed, 0x23ee,
  0x23ef, 0x23f1, 0x23f2, 0x23f8, 0x23f9, 0x23fa, 0x24c2, 0x25aa, 0x25ab,
  0x25b6, 0x25c0, 0x25fb, 0x25fc, 0x25fd, 0x25fe, 0x2600, 0x2601, 0x2602,
  0x2603, 0x2604, 0x260e, 0x2611, 0x2614, 0x2615, 0x2618, 0x261d, 0x2620,
  0x2622, 0x2623, 0x2626, 0x262a, 0x262e, 0x262f, 0x2638, 0x2639, 0x263a,
  0x2640, 0x2642, 0x2648, 0x2649, 0x264a, 0x264b, 0x264c, 0x264d, 0x264e,
  0x264f, 0x2650, 0x2651, 0x2652, 0x2653, 0x265f, 0x2660, 0x2663, 0x2665,
  0x2666, 0x2668, 0x267b, 0x267e, 0x267f, 0x2692, 0x2693, 0x2694, 0x2695,
  0x2696, 0x2697, 0x2699, 0x269b, 0x269c, 0x26a0, 0x26a1, 0x26a7, 0x26aa,
  0x26ab, 0x26b0, 0x26b1, 0x26bd, 0x26be, 0x26c4, 0x26c5, 0x26c8, 0x26ce,
  0x26cf, 0x26d1, 0x26d3, 0x26d4, 0x26e9, 0x26ea, 0x26f0, 0x26f1, 0x26f2,
  0x26f3, 0x26f4, 0x26f5, 0x26f7, 0x26f8, 0x26f9, 0x26fa, 0x26fd, 0x2702,
  0x2705, 0x2708, 0x2709, 0x270a, 0x270b, 0x270c, 0x270d, 0x270f, 0x2712,
  0x2714, 0x2716, 0x271d, 0x2721, 0x2728, 0x2733, 0x2734, 0x2744, 0x2747,
  0x274c, 0x274e, 0x2753, 0x2754, 0x2755, 0x2757, 0x2763, 0x2764, 0x2795,
  0x2796, 0x2797, 0x27a1, 0x27b0, 0x27bf, 0x2934, 0x2935, 0x2b05, 0x2b06,
  0x2b07, 0x2b1b, 0x2b1c, 0x2b50, 0x2b55, 0x3030, 0x303d, 0x3297, 0x3299,
]);

const graphemeWidthCache = new Map();

function codePointWidth(code) {
  if (code === 0) return 0;
  if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return 0;
  if (code === 0x200d || code === 0xfe0e || code === 0xfe0f) return 0;
  if (code >= 0x0300 && code <= 0x036f) return 0;
  if (code >= 0x1ab0 && code <= 0x1aff) return 0;
  if (code >= 0x1dc0 && code <= 0x1dff) return 0;
  if (code >= 0x20d0 && code <= 0x20ff) return 0;
  if (code >= 0xfe20 && code <= 0xfe2f) return 0;
  if (code >= 0xe0100 && code <= 0xe01ef) return 0;
  for (const [start, end] of WIDE_RANGES) {
    if (code >= start && code <= end) return 2;
  }
  return 1;
}

/** Display width of one grapheme cluster. */
export function graphemeWidth(grapheme) {
  const cached = graphemeWidthCache.get(grapheme);
  if (cached !== undefined) return cached;

  let width;
  if (grapheme === "\t") {
    width = TAB_WIDTH;
  } else if (grapheme === "\n") {
    width = 0;
  } else if (/\p{Regional_Indicator}/u.test(grapheme)) {
    width = 2;
  } else if (/\u20e3/u.test(grapheme)) {
    width = 2;
  } else if (/\uFE0F/u.test(grapheme)) {
    width = 2;
  } else if (/\p{Extended_Pictographic}/u.test(grapheme)) {
    const first = grapheme.codePointAt(0) ?? 0;
    width = TEXT_DEFAULT_PICTOGRAPHS.has(first) ? 1 : 2;
  } else {
    width = 0;
    for (const char of grapheme) {
      width = Math.max(width, codePointWidth(char.codePointAt(0) ?? 0));
    }
  }

  if (graphemeWidthCache.size > 4096) graphemeWidthCache.clear();
  graphemeWidthCache.set(grapheme, width);
  return width;
}

/** Split text into grapheme clusters (Unicode-safe cursor movement). */
export function graphemes(text) {
  const result = [];
  for (const part of segmenter.segment(String(text ?? ""))) result.push(part.segment);
  return result;
}

/** Expand tabs to spaces so width arithmetic is position-independent. */
export function expandTabs(text) {
  let column = 0;
  let output = "";
  for (const grapheme of graphemes(text)) {
    if (grapheme === "\n") {
      output += "\n";
      column = 0;
      continue;
    }
    if (grapheme === "\t") {
      const spaces = TAB_WIDTH - (column % TAB_WIDTH);
      output += " ".repeat(spaces);
      column += spaces;
      continue;
    }
    output += grapheme;
    column += graphemeWidth(grapheme);
  }
  return output;
}

/** Display width of a string, tabs expanded relative to the line start. */
export function displayWidth(text) {
  let width = 0;
  for (const grapheme of graphemes(text)) {
    if (grapheme === "\n") break;
    width += graphemeWidth(grapheme);
  }
  return width;
}

function mergeCells(cells) {
  const segments = [];
  for (const cell of cells) {
    if (cell.text === "") continue;
    const previous = segments[segments.length - 1];
    if (previous && previous.style === cell.style) previous.text += cell.text;
    else segments.push({ text: cell.text, style: cell.style });
  }
  return segments;
}

function cellsFromSegments(segments) {
  const cells = [];
  for (const segment of segments) {
    const style = segment.style ?? null;
    const text = expandTabs(String(segment.text ?? ""));
    for (const grapheme of graphemes(text)) {
      if (grapheme === "\n") {
        cells.push({ text: "\n", style });
        continue;
      }
      cells.push({ text: grapheme, style });
    }
  }
  return cells;
}

/**
 * Greedy word wrap that preserves styling. Long words are hard-broken so a
 * single URL cannot overflow the terminal.
 */
export function wrapSegments(segments, width) {
  const max = Math.max(1, Number.isFinite(width) ? Math.floor(width) : 1);
  const cells = cellsFromSegments(segments);
  const lines = [];
  let line = [];
  let lineWidth = 0;
  let lastSpace = -1;

  const flush = () => {
    while (line.length > 0 && line[line.length - 1].text === " ") line.pop();
    if (line.length > 0) lines.push(mergeCells(line));
    line = [];
    lineWidth = 0;
    lastSpace = -1;
  };

  for (let index = 0; index < cells.length; index += 1) {
    const cell = cells[index];
    if (cell.text === "\n") {
      flush();
      continue;
    }
    const cellWidth = graphemeWidth(cell.text);

    let skipCell = false;
    while (lineWidth + cellWidth > max && line.length > 0) {
      if (cell.text === " ") {
        // The space is the break point itself; it is not part of either line.
        flush();
        lastSpace = -1;
        skipCell = true;
        break;
      }
      if (lastSpace >= 0) {
        const carry = line.slice(lastSpace + 1);
        line = line.slice(0, lastSpace);
        const carryWidth = carry.reduce((sum, item) => sum + graphemeWidth(item.text), 0);
        flush();
        line = carry;
        lineWidth = carryWidth;
        lastSpace = -1;
        continue;
      }
      flush();
    }
    if (skipCell) continue;

    if (cell.text === " ") lastSpace = line.length;
    line.push(cell);
    lineWidth += cellWidth;
  }
  flush();

  if (lines.length === 0) lines.push([]);
  return lines;
}

/** Wrap plain text and return plain lines. */
export function wrapText(text, width) {
  return wrapSegments([{ text: String(text ?? ""), style: null }], width).map((line) =>
    line.map((segment) => segment.text).join(""),
  );
}

/** Truncate to a display width without splitting a grapheme. */
export function truncateToWidth(text, width, ellipsis = "\u2026") {
  const max = Math.max(0, Math.floor(width));
  let used = 0;
  let output = "";
  for (const grapheme of graphemes(text)) {
    const size = graphemeWidth(grapheme);
    if (used + size > max) break;
    output += grapheme;
    used += size;
  }
  if (output.length < String(text).length && used < max) {
    const ellipsisWidth = displayWidth(ellipsis);
    while (used + ellipsisWidth > max && output.length > 0) {
      const parts = graphemes(output);
      const removed = parts.pop();
      used -= graphemeWidth(removed ?? "");
      output = parts.join("");
    }
    output += ellipsis;
  }
  return output;
}

/** Pad with spaces to a target display width. */
export function padToWidth(text, width, align = "left") {
  const current = displayWidth(text);
  const missing = Math.max(0, Math.floor(width) - current);
  if (missing === 0) return String(text);
  if (align === "right") return " ".repeat(missing) + text;
  if (align === "center") {
    const left = Math.floor(missing / 2);
    return " ".repeat(left) + text + " ".repeat(missing - left);
  }
  return String(text) + " ".repeat(missing);
}

export { TAB_WIDTH };
