import { EXIT, UsageError } from "../errors.js";
import { renderPermissionRequest } from "../ui/presenter.js";
import { renderTable } from "../ui/tables.js";

export async function permissionsCommand(runtime, positionals, { prompt = null } = {}) {
  const action = positionals[0] ?? "list";
  const client = await runtime.getEngine();

  if (action === "list") {
    const taskId = positionals[1] ?? runtime.flags.get("task");
    if (!taskId) throw new UsageError("permissions list requires a task id");
    const list = await client.permissions(taskId);
    runtime.emit("permissions.list", { taskId, ...list }, () => {
      if (list.requests.length === 0) {
        runtime.write("No permission requests for this task.");
        return;
      }
      for (const request of list.requests) {
        runtime.write(renderPermissionRequest(request, { style: runtime.style }));
        runtime.write("");
      }
    });
    return EXIT.OK;
  }

  if (action === "decide") {
    const taskId = positionals[1];
    let requestId = positionals[2];
    if (!taskId) throw new UsageError("permissions decide requires a task id");
    const approve = runtime.flags.has("approve");
    const deny = runtime.flags.has("deny");
    if (approve === deny) throw new UsageError("permissions decide requires exactly one of --approve or --deny");
    if (!requestId) {
      const list = await client.permissions(taskId);
      const pending = list.requests.filter((entry) => entry.decision === "pending");
      if (pending.length === 0) throw new UsageError("this task has no pending permission requests");
      if (!prompt) throw new UsageError("permissions decide requires a request id");
      const choice = await prompt.select({
        title: "Pending permissions",
        items: pending,
        render: (entry) => `${entry.scope} ${entry.resource} \u2014 ${entry.description}`,
      });
      requestId = choice?.requestId;
      if (!requestId) throw new UsageError("no permission request selected");
    }
    const decision = approve ? "approved" : "denied";
    const reason = runtime.flags.get("reason");
    const list = await client.decidePermission(taskId, {
      requestId,
      decision,
      ...(reason ? { reason } : {}),
    });
    const target = list.requests.find((entry) => entry.requestId === requestId);
    runtime.emit("permissions.decide", { taskId, requestId, decision, permissions: list }, () => {
      runtime.write(`${decision === "approved" ? runtime.style.green("\u2713") : runtime.style.red("\u2717")} ${decision} ${requestId}`);
      if (target) runtime.write(`  ${target.scope}  ${target.resource}`);
      const pending = list.requests.filter((entry) => entry.decision === "pending").length;
      if (pending > 0) runtime.write(`  ${pending} request(s) still pending`);
    });
    return EXIT.OK;
  }

  throw new UsageError(`unknown permissions action: ${action}`);
}

export async function choosePendingPermission({ client, taskId, prompt, style }) {
  const list = await client.permissions(taskId);
  const pending = list.requests.filter((entry) => entry.decision === "pending");
  if (pending.length === 0) return null;
  const choice = await prompt.select({
    title: "Pending permissions",
    items: pending,
    render: (entry) => `${entry.scope} ${entry.resource} \u2014 ${entry.description}`,
  });
  if (!choice) return null;
  const approved = await prompt.confirm(
    `Approve ${choice.scope} for ${choice.resource}?`,
    { defaultYes: false },
  );
  const listAfter = await client.decidePermission(taskId, {
    requestId: choice.requestId,
    decision: approved ? "approved" : "denied",
  });
  style;
  return { request: choice, approved, list: listAfter };
}

export function summarizePermissions(list) {
  return renderTable({
    headers: ["SCOPE", "DECISION", "RESOURCE", "REQUEST"],
    rows: list.requests.map((entry) => [entry.scope, entry.decision, entry.resource, entry.requestId]),
  });
}
