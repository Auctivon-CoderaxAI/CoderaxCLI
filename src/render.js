export const STATUS_LABELS = Object.freeze({
  queued: "queued",
  running: "running",
  paused: "suspended (paused)",
  waiting_approval: "suspended (waiting for approval)",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
  pending: "pending",
  skipped: "skipped",
});

export function statusLabel(status) {
  return STATUS_LABELS[status] ?? String(status ?? "unknown");
}

export function table(rows, headers) {
  if (rows.length === 0) return headers.join("  ");
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => String(row[index] ?? "").length)),
  );
  const line = (cells) =>
    cells
      .map((cell, index) => String(cell ?? "").padEnd(widths[index]))
      .join("  ")
      .trimEnd();
  return [
    line(headers),
    line(widths.map((width) => "\u2500".repeat(width))),
    ...rows.map(line),
  ].join("\n");
}

export function truncate(value, limit = 60) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}\u2026` : text;
}

export function taskId(task) {
  return task?.id ?? task?.conversationId ?? task?.taskId ?? "(unknown)";
}

export function taskState(task) {
  return task?.state ?? task?.workState ?? task?.status ?? "unknown";
}

export function taskTitle(task) {
  return task?.title ?? task?.name ?? task?.summary ?? "";
}

export function taskUpdated(task) {
  return task?.updatedAt ?? task?.createdAt ?? task?.settledAt ?? "";
}

export function renderRun(run, write) {
  write(`run ${run.id}  ${statusLabel(run.status)}`);
  if (run.workflowName || run.workflowId) {
    write(`workflow  ${run.workflowName ?? "(unnamed)"}  ${run.workflowId ?? ""}`.trimEnd());
  }
  if (run.conversationId) write(`conversation  ${run.conversationId}`);
  if (typeof run.error === "string" && run.error !== "") write(`error  ${run.error}`);
  const steps = Array.isArray(run.steps) ? run.steps : [];
  if (steps.length > 0) {
    const rows = steps.map((step, index) => [
      String(index + 1),
      step.status ?? "unknown",
      step.approvalRequired ? "yes" : "no",
      truncate(step.title ?? step.id ?? "", 60),
    ]);
    write(table(rows, ["#", "STATUS", "APPROVAL", "STEP"]));
  }
  if (run.status === "failed") {
    write(`Next: coderax retry ${run.id} (starts a fresh run) or coderax run ${run.id} --no-follow`);
  } else if (run.status === "paused") {
    write(`Next: coderax resume ${run.id}`);
  } else if (run.status === "waiting_approval") {
    write(`Next: coderax approve ${run.id} <step-index>`);
  }
}

export function diagnosticsForJson(diagnostics) {
  return Array.isArray(diagnostics) && diagnostics.length > 0 ? { diagnostics } : {};
}

export function printDiagnostics(ctx, diagnostics) {
  if (ctx.json || !Array.isArray(diagnostics)) return;
  for (const entry of diagnostics) {
    ctx.err(`coderax: ${entry.severity ?? "warning"}: ${entry.code}: ${entry.message}`);
  }
}
