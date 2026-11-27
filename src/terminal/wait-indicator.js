import { clearLine, resolveTerminalProfile, sanitizeLabel, truncateToWidth } from "./prompt.js";

/**
 * Wait indicator for an interactive session.
 *
 * It writes only when the target stream is a TTY, so `--json` and piped output
 * stay clean. Start is idempotent, stop is idempotent, and the timer is
 * unref'd so a forgotten indicator never keeps the process alive.
 */
export const BRAILLE_FRAMES = Object.freeze([
  "\u280b",
  "\u2819",
  "\u2839",
  "\u2838",
  "\u283c",
  "\u2834",
  "\u2826",
  "\u2827",
  "\u2807",
  "\u280f",
]);

export const ASCII_FRAMES = Object.freeze(["-", "\\", "|", "/"]);

export const DEFAULT_INTERVAL_MS = 80;

export function selectFrames(profile) {
  return profile?.unicode === false ? ASCII_FRAMES : BRAILLE_FRAMES;
}

export function renderWaitFrame({ frames, index = 0, label = "", columns = 80 } = {}) {
  const list = Array.isArray(frames) && frames.length > 0 ? frames : BRAILLE_FRAMES;
  const frame = list[((index % list.length) + list.length) % list.length];
  const text = sanitizeLabel(label);
  const line = text === "" ? frame : `${frame} ${text}`;
  return truncateToWidth(line, Math.max(1, columns));
}

export function createWaitIndicator({
  stream = process.stderr,
  isTTY = Boolean(stream?.isTTY),
  profile,
  label = "working",
  intervalMs = DEFAULT_INTERVAL_MS,
  frames,
  columns,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
} = {}) {
  const resolved =
    profile ??
    resolveTerminalProfile({
      isTTY,
      columns: columns ?? stream?.columns ?? null,
    });
  const width = Math.max(1, Number(columns ?? resolved.columns) || 80);
  const activeFrames = Array.isArray(frames) && frames.length > 0 ? frames : selectFrames(resolved);
  const enabled = Boolean(isTTY && typeof stream?.write === "function");
  let timer = null;
  let index = 0;
  let active = false;
  let currentLabel = sanitizeLabel(label);

  const write = (text) => {
    if (text === "" || typeof stream?.write !== "function") return;
    stream.write(text);
  };

  const paint = () => {
    if (!active) return;
    write(
      `${clearLine({ profile: resolved, columns: width })}${renderWaitFrame({
        frames: activeFrames,
        index,
        label: currentLabel,
        columns: width,
      })}`,
    );
  };

  const indicator = {
    get active() {
      return active;
    },
    get label() {
      return currentLabel;
    },
    get frames() {
      return activeFrames;
    },
    start(nextLabel) {
      if (nextLabel !== undefined) currentLabel = sanitizeLabel(nextLabel);
      if (!enabled || active) return indicator;
      active = true;
      index = 0;
      paint();
      timer = setIntervalImpl(() => {
        index += 1;
        paint();
      }, intervalMs);
      timer?.unref?.();
      return indicator;
    },
    update(nextLabel) {
      currentLabel = sanitizeLabel(nextLabel);
      if (active) paint();
      return indicator;
    },
    stop({ clear = true } = {}) {
      if (!active) return indicator;
      active = false;
      if (timer !== null) {
        clearIntervalImpl(timer);
        timer = null;
      }
      if (clear) write(clearLine({ profile: resolved, columns: width }));
      return indicator;
    },
    /** Stop, then leave one final line (TTY only). */
    finish(text = "", { ok = true, symbol } = {}) {
      indicator.stop();
      if (!enabled) return indicator;
      const mark = symbol ?? (resolved.unicode ? (ok ? "\u2713" : "\u2717") : ok ? "OK" : "FAIL");
      const detail = sanitizeLabel(text);
      const line = truncateToWidth(detail === "" ? mark : `${mark} ${detail}`, width);
      write(`${line}${resolved.eol}`);
      return indicator;
    },
    succeed(text) {
      return indicator.finish(text, { ok: true });
    },
    fail(text) {
      return indicator.finish(text, { ok: false });
    },
  };

  return indicator;
}
