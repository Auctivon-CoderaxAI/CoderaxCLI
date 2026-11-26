import { CoderaxError } from "../errors.js";
import { CONTRACT_VERSION, agentCapability } from "../engine/contract.js";

/**
 * Verify the deployment the CLI is actually talking to.
 *
 * What is proven here:
 * - the configured origin served a contract this client understands;
 * - the engine reports healthy and ready;
 * - the owner bearer token is accepted for an owner-only read (`GET /v1/agents`);
 * - the selected agent is published by that engine.
 *
 * What is deliberately not claimed:
 * - a deployment identifier, because contract 1.0.0 publishes none;
 * - repository identity, because contract 1.0.0 publishes no repository
 *   operation or immutable repository id;
 * - "trust" from a server-supplied `verified` or `authorized` flag. The strict
 *   contract validators reject unknown fields, and no such flag is read here.
 *   Authorization is whatever the engine enforces for the authenticated owner.
 */
export async function verifyEnvironment(client, { agent = "coderax" } = {}) {
  const health = await client.negotiate();
  const readiness = await client.readiness();
  const agents = await client.agents({ refresh: true });
  const descriptor = agentCapability(agents, agent, null);

  const healthy = health.status !== "failed";
  const ready = healthy && readiness.ready === true && descriptor.supported;
  const toolCapableAgents = agents.agents
    .filter((entry) => entry.availability.available && entry.capabilities.tools === true)
    .map((entry) => entry.id);

  return {
    engineUrl: client.baseUrl,
    contract: {
      client: CONTRACT_VERSION,
      server: health.contractVersion,
      compatible: health.contractVersion === CONTRACT_VERSION,
    },
    health: {
      status: health.status,
      checks: health.checks,
    },
    readiness: {
      ready: readiness.ready === true,
      missing: readiness.missing,
    },
    authorization: {
      owner: true,
      proof: "authenticated owner read of GET /v1/agents",
      agents: agents.agents.map((entry) => ({
        id: entry.id,
        available: entry.availability.available,
        reason: entry.availability.reason,
        tools: entry.capabilities.tools === true,
      })),
    },
    agent: {
      id: agent,
      published: descriptor.supported,
      reason: descriptor.supported ? null : descriptor.reason,
      capabilities: descriptor.agent?.capabilities ?? null,
      availability: descriptor.agent?.availability ?? null,
    },
    ready,
    engineering: {
      available: Boolean(ready && toolCapableAgents.length > 0),
      selectedAgentTools: descriptor.agent?.capabilities?.tools === true,
      toolCapableAgents,
    },
    trust: "unverified",
    deploymentIdentity: {
      supported: false,
      detail: "contract 1.0.0 publishes no deployment identifier; this result proves an authenticated owner session and an exact contract, not infrastructure trust",
    },
    repositoryIdentity: {
      supported: false,
      detail: "contract 1.0.0 publishes no repository listing or immutable repository identifier",
    },
  };
}

export function assertWorkflowEnvironment(environment, { kind, model = false, detach = false } = {}) {
  if (environment.health.status === "failed" || environment.readiness.ready !== true) {
    throw new CoderaxError(
      "UNAVAILABLE",
      `the engine is not ready${environment.readiness.missing.length ? `: missing ${environment.readiness.missing.join(", ")}` : ""}`,
      {
        details: {
          health: environment.health.status,
          readiness: environment.readiness,
          sent: false,
        },
        hint: "Run `coderax workflow environments` and resolve the failed readiness check before submitting work.",
      },
    );
  }

  if (!environment.agent.published) {
    throw new CoderaxError("CAPABILITY_UNSUPPORTED", environment.agent.reason ?? `agent ${environment.agent.id} is unavailable`, {
      details: { agent: environment.agent.id, sent: false },
      hint: "Run `coderax agents` to see the agents this engine actually publishes.",
    });
  }

  const capabilities = environment.agent.capabilities ?? {};
  if (kind?.requiresTools && capabilities.tools !== true) {
    const capable = environment.engineering?.toolCapableAgents ?? [];
    throw new CoderaxError(
      "CAPABILITY_UNSUPPORTED",
      `agent ${environment.agent.id} does not publish the tools capability required for ${kind.label}`,
      {
        details: {
          agent: environment.agent.id,
          capability: "tools",
          toolCapableAgents: capable,
          sent: false,
        },
        hint: capable.length > 0
          ? `Select a tool-capable agent with --agent <id>: ${capable.join(", ")}.`
          : "The engine publishes no available tool-capable agent, so engineering tasks cannot run. The CLI does not simulate a coding run locally.",
      },
    );
  }
  if (detach && capabilities.durable !== true) {
    throw new CoderaxError(
      "CAPABILITY_UNSUPPORTED",
      `agent ${environment.agent.id} does not support durable tasks, so this task cannot be detached`,
      { details: { agent: environment.agent.id, capability: "durable", sent: false } },
    );
  }
  if (model && capabilities.modelSelection !== true) {
    throw new CoderaxError(
      "CAPABILITY_UNSUPPORTED",
      `agent ${environment.agent.id} does not support model selection`,
      { details: { agent: environment.agent.id, capability: "modelSelection", sent: false } },
    );
  }
  return environment.agent;
}
