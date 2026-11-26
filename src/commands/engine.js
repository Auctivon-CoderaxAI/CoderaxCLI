import { stat } from "node:fs/promises";
import { dirname } from "node:path";
import { CoderaxError, EXIT } from "../errors.js";
import { CONTRACT_VERSION } from "../engine/contract.js";
import { renderTable } from "../ui/tables.js";
import { VERSION } from "../version.js";

function capabilitiesText(capabilities) {
  const names = [];
  if (capabilities.streaming) names.push("stream");
  if (capabilities.tools) names.push("tools");
  if (capabilities.cancellation) names.push("cancel");
  if (capabilities.resume) names.push("resume");
  if (capabilities.modelSelection) names.push("models");
  if (capabilities.durable) names.push("durable");
  return names.length > 0 ? names.join(",") : "none";
}

export async function engineHealth(runtime) {
  const client = await runtime.getEngine({ negotiate: false });
  const health = await client.health();
  const compatible = health.contractVersion === CONTRACT_VERSION;
  const data = {
    health,
    clientContract: CONTRACT_VERSION,
    compatible,
  };
  runtime.emit("engine.health", data, () => {
    const marker = compatible ? runtime.style.green("\u2713") : runtime.style.red("\u2717");
    runtime.write(`${marker} engine ${health.status}  contract ${health.contractVersion}  uptime ${Math.floor(health.uptimeMs / 1000)}s`);
    if (!compatible) {
      runtime.write(`${runtime.style.yellow("\u26a0")} this CLI supports contract ${CONTRACT_VERSION}`);
    }
    if (health.checks.length > 0) {
      runtime.write("");
      runtime.write(renderTable({
        headers: ["CHECK", "STATUS", "REQUIRED", "DETAIL"],
        rows: health.checks.map((check) => [
          check.name,
          check.status,
          check.required ? "yes" : "no",
          check.detail ?? "",
        ]),
        style: runtime.style,
        width: runtime.width,
      }));
    }
    if (health.engines.length > 0) {
      runtime.write("");
      runtime.write(renderTable({
        headers: ["ENGINE", "AVAILABLE", "REASON", "CAPABILITIES"],
        rows: health.engines.map((engine) => [
          engine.id,
          engine.availability.available ? "yes" : "no",
          engine.availability.reason,
          capabilitiesText(engine.capabilities),
        ]),
        style: runtime.style,
        width: runtime.width,
      }));
    }
  });
  return compatible ? EXIT.OK : EXIT.UNSUPPORTED;
}

export async function engineReady(runtime) {
  const client = await runtime.getEngine({ negotiate: false });
  const readiness = await client.readiness();
  runtime.emit("engine.ready", { readiness }, () => {
    runtime.write(`${readiness.ready ? runtime.style.green("\u2713 ready") : runtime.style.red("\u2717 not ready")}`);
    if (readiness.missing.length > 0) runtime.write(`missing: ${readiness.missing.join(", ")}`);
    for (const check of readiness.checks) {
      runtime.write(`  ${check.status === "ok" ? "\u2713" : "\u2717"} ${check.name}${check.detail ? ` \u2014 ${check.detail}` : ""}`);
    }
  });
  return readiness.ready ? EXIT.OK : EXIT.UNAVAILABLE;
}

export async function engineContract(runtime) {
  const client = await runtime.getEngine({ negotiate: false });
  const health = await client.health();
  const compatible = health.contractVersion === CONTRACT_VERSION;
  runtime.emit("engine.contract", {
    clientContract: CONTRACT_VERSION,
    serverContract: health.contractVersion,
    compatible,
  }, () => {
    runtime.write(`client contract  ${CONTRACT_VERSION}`);
    runtime.write(`server contract  ${health.contractVersion}`);
    runtime.write(compatible
      ? runtime.style.green("\u2713 compatible")
      : runtime.style.red("\u2717 incompatible; install a matching CLI release"));
  });
  return compatible ? EXIT.OK : EXIT.UNSUPPORTED;
}

export async function listAgents(runtime) {
  const client = await runtime.getEngine();
  const agents = await client.agents({ refresh: true });
  runtime.emit("agents", agents, () => {
    runtime.write(renderTable({
      headers: ["AGENT", "ENGINE", "AVAILABLE", "REASON", "CAPABILITIES", "LABEL"],
      rows: agents.agents.map((agent) => [
        agent.id,
        agent.engine,
        agent.availability.available ? "yes" : "no",
        agent.availability.reason,
        capabilitiesText(agent.capabilities),
        agent.label,
      ]),
      style: runtime.style,
      width: runtime.width,
    }));
    if (agents.agents.some((agent) => !agent.availability.available)) {
      runtime.write("");
      runtime.write(runtime.style.dim("An unavailable agent is refused, never substituted."));
    }
  });
  return EXIT.OK;
}

export async function listModels(runtime) {
  const client = await runtime.getEngine();
  const models = await client.models();
  runtime.emit("models", models, () => {
    runtime.write(renderTable({
      headers: ["MODEL", "COST", "TOOLS", "STREAM", "AVAILABLE", "REASON"],
      rows: models.models.map((model) => [
        `${model.ref.providerId}/${model.ref.modelId}`,
        model.costClass,
        model.toolCalling ? "yes" : "no",
        model.streaming ? "yes" : "no",
        model.availability.available ? "yes" : "no",
        model.availability.reason,
      ]),
      style: runtime.style,
      width: runtime.width,
    }));
    runtime.write("");
    runtime.write(runtime.style.dim(`zero-cost route: ${models.route.map((ref) => `${ref.providerId}/${ref.modelId}`).join(" -> ") || "(empty)"}`));
  });
  return EXIT.OK;
}

export async function engineCapabilities(runtime) {
  const client = await runtime.getEngine();
  const [health, agents, models] = await Promise.all([client.health(), client.agents({ refresh: true }), client.models()]);
  const data = { health, agents, models };
  runtime.emit("engine.capabilities", data, () => {
    runtime.write(`${runtime.style.bold("contract")} ${health.contractVersion}  ${runtime.style.dim(`cli ${CONTRACT_VERSION}`)}`);
    for (const engine of health.engines) {
      runtime.write(`\n${runtime.style.bold(engine.id)}  ${engine.availability.available ? "available" : `unavailable (${engine.availability.reason})`}`);
      runtime.write(`  ${capabilitiesText(engine.capabilities)}`);
    }
    runtime.write("");
    for (const agent of agents.agents) {
      runtime.write(`${agent.id.padEnd(10)} ${agent.availability.available ? "ready" : agent.availability.reason}  ${capabilitiesText(agent.capabilities)}`);
    }
  });
  return EXIT.OK;
}

function check(name, ok, detail, hint = "", required = true) {
  return { name, ok, required, detail, hint };
}

export async function doctor(runtime) {
  const checks = [];
  const major = Number(process.versions.node.split(".")[0]);
  checks.push(check("node", major >= 24, process.versions.node, major >= 24 ? "" : "Node 24 or newer is required."));

  const directory = dirname(runtime.configPath);
  const dirMode = await stat(directory).then((info) => info.mode & 0o777).catch(() => null);
  checks.push(check(
    "config-dir",
    process.platform === "win32" || dirMode === null || dirMode === 0o700,
    dirMode === null ? `${directory} (not created yet)` : `${directory} (${dirMode.toString(8)})`,
    "Run `chmod 700` on the config directory.",
  ));

  const configMode = await stat(runtime.configPath).then((info) => info.mode & 0o777).catch(() => null);
  checks.push(check(
    "config-file",
    process.platform === "win32" || configMode === null || configMode === 0o600,
    configMode === null ? `${runtime.configPath} (not created yet)` : `${runtime.configPath} (${configMode.toString(8)})`,
    "Run `chmod 600` on config.json.",
  ));

  const store = runtime.store.describe();
  checks.push(check(
    "credential-store",
    true,
    `${store.backend}${store.path ? ` (${store.path})` : ""}`,
    store.warning ?? "",
    false,
  ));
  const token = runtime.tokenInfo();
  checks.push(check("auth", token.configured, token.configured ? `${token.masked} via ${token.source}` : "no token", token.configured ? "" : "Run `coderax login`."));
  checks.push(check("engine-url", Boolean(runtime.engineUrl), runtime.engineUrl ?? "(unset)", runtime.engineUrl ? "" : "Run `coderax config set --engine-url <url>`."));

  try {
    const state = await runtime.state.load();
    checks.push(check("state", true, `${runtime.state.filePath} (${Object.keys(state.tasks).length} tasks)`));
    if (runtime.state.warnings.length > 0) {
      checks.push(check("state-warnings", false, runtime.state.warnings.join("; "), "Review the local journal.", false));
    }
  } catch (error) {
    checks.push(check("state", false, error.message, "Check permissions on the config directory."));
  }

  if (runtime.engineUrl) {
    try {
      const client = await runtime.getEngine({ negotiate: false });
      const health = await client.health();
      checks.push(check("contract", health.contractVersion === CONTRACT_VERSION, `${health.contractVersion} (client ${CONTRACT_VERSION})`, "Install a matching CLI release."));
      checks.push(check("health", health.status !== "failed", health.status));
      const readiness = await client.readiness().catch((error) => ({ ready: false, missing: [error.code ?? "REQUEST_FAILED"] }));
      checks.push(check("readiness", readiness.ready, readiness.ready ? "ready" : `missing: ${readiness.missing.join(", ")}`, "The engine has not completed startup validation."));
      if (token.configured) {
        const agents = await client.agents({ refresh: true });
        checks.push(check("agents", agents.agents.some((agent) => agent.availability.available), `${agents.agents.filter((agent) => agent.availability.available).length}/${agents.agents.length} available`));
      }
    } catch (error) {
      checks.push(check("engine", false, `${error.code ?? "ERROR"}: ${runtime.redact(error.message)}`, "Confirm the engine URL, token and that the engine is running."));
    }
  } else {
    checks.push(check("engine", false, "no engine URL", "Run `coderax config set --engine-url <url>`."));
  }

  const ok = checks.filter((entry) => entry.required).every((entry) => entry.ok);
  runtime.emit("doctor", { ok, version: VERSION, checks }, () => {
    for (const entry of checks) {
      const marker = entry.ok ? runtime.style.green("\u2713") : runtime.style.red("\u2717");
      const optional = entry.required ? "" : runtime.style.dim(" (optional)");
      runtime.write(`${marker} ${entry.name.padEnd(16)} ${entry.detail}${optional}`);
      if (!entry.ok && entry.hint) runtime.write(`  \u2192 ${entry.hint}`);
    }
  });
  return ok ? EXIT.OK : EXIT.ERROR;
}
