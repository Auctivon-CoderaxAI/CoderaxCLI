/**
 * Assemble assistant text from incremental deltas and cumulative snapshots.
 *
 * A cumulative snapshot is authoritative. When it only extends what is already
 * displayed, emit the unseen suffix; when it rewrites the answer, emit one
 * replacement. A delta that repeats the tail of a snapshot is the increment the
 * snapshot was built from, not new text, so it is discarded.
 */
export class TextAssembler {
  constructor() {
    this.text = "";
    this.mode = "incremental";
  }

  delta(value) {
    if (typeof value !== "string" || value === "") return { kind: "ignored" };
    if (this.mode === "snapshot" && this.text.endsWith(value)) {
      this.mode = "incremental";
      return { kind: "duplicate" };
    }
    this.mode = "incremental";
    this.text += value;
    return { kind: "delta", text: value };
  }

  snapshot(value) {
    if (typeof value !== "string") return { kind: "ignored" };
    this.mode = "snapshot";
    if (value === this.text) return { kind: "duplicate" };
    if (value.startsWith(this.text)) {
      const suffix = value.slice(this.text.length);
      this.text = value;
      return suffix === ""
        ? { kind: "duplicate" }
        : { kind: "delta", text: suffix, snapshot: true };
    }
    this.text = value;
    return { kind: "replace", text: value };
  }
}
