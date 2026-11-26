import { SdkError, approvalFor } from "../packages/workflow-sdk/src/index.js";

export const APPROVAL_POLICIES = Object.freeze(["ask", "allow", "deny"]);

/**
 * The descriptor comes from task-events.js, which records that the backend has
 * no permission-request identifier: approval is addressed by step index only.
 */
export function pendingApproval(run) {
  const approval = approvalFor(run);
  if (approval === null) return null;
  const steps = Array.isArray(run.steps) ? run.steps : [];
  return { index: approval.stepIndex, step: steps[approval.stepIndex] };
}

/**
 * Approvals are never granted implicitly. In a non-interactive session the CLI
 * refuses and prints the exact command to run, instead of treating silence as
 * consent.
 */
export async function decideApproval({ ctx, policy, run }) {
  const pending = pendingApproval(run);
  if (pending === null) return { action: "none" };

  const label = pending.step.title ?? pending.step.id ?? `step ${pending.index + 1}`;

  if (policy === "deny") {
    return { action: "denied", pending, label };
  }
  if (policy === "allow") {
    return { action: "approve", pending, label };
  }
  if (!ctx.stdinIsTTY) {
    return { action: "unavailable", pending, label };
  }

  const question =
    `Approve step ${pending.index + 1} "${label}" for run ${run.id}? ` +
    "This authorizes the agent to continue. [y/N] ";
  const answer = await ctx.confirm(question);
  if (answer === true) return { action: "approve", pending, label };
  return { action: "declined", pending, label };
}

export async function approveOrExplain({ ctx, client, run, policy, apply }) {
  const decision = await decideApproval({ ctx, policy, run });
  if (decision.action === "none") return { action: "none" };

  if (decision.action === "approve") {
    try {
      const updated = await client.approveStep(run.id, decision.pending.index);
      apply?.(updated);
      ctx.err(`Approved step ${decision.pending.index + 1} (${decision.label}).`);
      return { action: "approved", run: updated };
    } catch (error) {
      if (error instanceof SdkError && error.code === "CONFLICT") {
        // Another client approved it first; the stream will report the result.
        ctx.err("The step is no longer waiting for approval; continuing to monitor.");
        return { action: "conflict" };
      }
      throw error;
    }
  }

  if (decision.action === "unavailable") {
    ctx.err(
      `Run ${run.id} is suspended waiting for approval of step ${decision.pending.index + 1} ` +
        `(${decision.label}). A non-interactive session cannot approve it.`,
    );
    ctx.err(`Next: coderax approve ${run.id} ${decision.pending.index}`);
    return { action: "unavailable" };
  }

  ctx.err(
    `Approval declined for step ${decision.pending.index + 1} (${decision.label}). ` +
      `Run ${run.id} remains suspended.`,
  );
  ctx.err(`Next: coderax approve ${run.id} ${decision.pending.index} or coderax cancel ${run.id}`);
  return { action: decision.action };
}
