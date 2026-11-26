import { CONTRACT_VERSION } from "./contract.js";

/**
 * Contract compatibility is explicit. A newer version is not treated as a
 * best-effort match: the 1.1.0 catalogue in engine PR #7 is not final and the
 * unified 1.2.0 contract has not been published, so neither is advertised as
 * usable by this client.
 */
const SUPPORT = Object.freeze({
  [CONTRACT_VERSION]: Object.freeze({
    status: "supported",
    supported: true,
    note: "verified WorkflowEngine v1 JSON/SSE contract",
  }),
  "1.1.0": Object.freeze({
    status: "adapter-pending",
    supported: false,
    note: "engine PR #7 serves 1.1.0; it is not the final unified contract",
  }),
  "1.2.0": Object.freeze({
    status: "adapter-pending",
    supported: false,
    note: "the unified API/SDK 1.2.0 contract is not published yet",
  }),
});

export function contractSupport(version) {
  return SUPPORT[version] ?? Object.freeze({
    status: "unsupported",
    supported: false,
    note: `no adapter exists for contract ${version}`,
  });
}
