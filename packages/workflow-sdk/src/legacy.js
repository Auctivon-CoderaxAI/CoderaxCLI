/**
 * The legacy Coderax `/api/*` adapter.
 *
 * This package is retained only so deployments that have not yet moved to the
 * WorkflowEngine `/v1` surface remain reachable. It is not a second task
 * authority: it does not define the canonical API contract, event schema or SDK
 * version, and no new capability may be added here.
 *
 * The canonical client is `src/engine-client.js` against `@coderax/sdk` 1.2.0 /
 * WorkflowEngine contract 1.2.0 (pinned in `contracts/`). Migrate the deployment
 * and this package can be deleted.
 */
export const LEGACY_ADAPTER = Object.freeze({
  marker: "coderax-legacy-api-adapter",
  contract: "coderax-api/1",
  routes: "/api/*",
  status: "temporary-compatibility-adapter",
  replacedBy: "EngineClient (WorkflowEngine contract 1.2.0, @coderax/sdk 1.2.0)",
  reason:
    "The legacy Workflow run stream emits full snapshots without event ids or sequence numbers. " +
    "Durable ordering, replay and idempotent submission are only authoritative on the /v1 engine contract.",
});

export function isLegacyAdapter() {
  return true;
}
