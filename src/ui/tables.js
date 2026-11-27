import { truncate, visibleLength } from "./ansi.js";

export function renderTable({
  headers,
  rows,
  style,
  width = 100,
  maxColumnWidth = 48,
  align = [],
} = {}) {
  if (!Array.isArray(headers) || headers.length === 0) return "";
  const columns = headers.length;
  const widths = headers.map((header, index) => {
    const values = [header, ...rows.map((row) => String(row[index] ?? ""))];
    return Math.min(maxColumnWidth, Math.max(3, ...values.map((value) => visibleLength(value))));
  });
  const available = Math.max(1, Math.floor(width));
  const borderWidth = columns * 3 + 1;
  let excess = widths.reduce((sum, value) => sum + value, 0) + borderWidth - available;
  while (excess > 0) {
    let widest = 0;
    for (let index = 1; index < widths.length; index += 1) {
      if (widths[index] > widths[widest]) widest = index;
    }
    if (widths[widest] <= 4) break;
    widths[widest] -= 1;
    excess -= 1;
  }
  if (excess > 0) {
    const clip = (text) => visibleLength(text) > available ? truncate(text, available) : text;
    if (rows.length === 0) return headers.map((header) => clip(String(header))).join("\n");
    return rows.map((row) => headers.map((header, index) => (
      clip(`${header}: ${row[index] ?? ""}`)
    )).join("\n")).join("\n\n");
  }

  const fit = (value, index) => {
    const text = String(value ?? "");
    const clipped = visibleLength(text) > widths[index] ? truncate(text, widths[index]) : text;
    const padding = " ".repeat(Math.max(0, widths[index] - visibleLength(clipped)));
    const right = align[index] === "right";
    return right ? `${padding}${clipped}` : `${clipped}${padding}`;
  };

  const line = (cells, bold = false) => {
    const rendered = cells.map((cell, index) => {
      const value = fit(cell, index);
      return bold ? (style?.bold(value) ?? value) : value;
    });
    return `\u2502 ${rendered.join(" \u2502 ")} \u2502`;
  };
  const rule = (left, middle, right) => {
    const body = widths.map((value) => "\u2500".repeat(value + 2)).join(middle);
    return style?.dim(`${left}${body}${right}`) ?? `${left}${body}${right}`;
  };

  const output = [
    rule("\u250c", "\u252c", "\u2510"),
    line(headers, true),
    rule("\u251c", "\u253c", "\u2524"),
    ...rows.map((row) => line(Array.from({ length: columns }, (_, index) => row[index] ?? ""))),
    rule("\u2514", "\u2534", "\u2518"),
  ];
  return output.join("\n");
}

export function keyValue(entries, { style, indent = 0 } = {}) {
  const width = Math.max(...entries.map(([key]) => String(key).length));
  return entries
    .map(([key, value]) => `${" ".repeat(indent)}${style?.dim(String(key).padEnd(width)) ?? String(key).padEnd(width)}  ${value}`)
    .join("\n");
}
