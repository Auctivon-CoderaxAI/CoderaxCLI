import { PRODUCTS, STATUS_LABELS, getOrderedProducts } from "./product-registry.js";
import { CoderaxError, request, streamRequest } from "./client.js";
import {
  checkCompatibility,
  detectDeploymentVersion,
  isSupportedDeploymentVersion,
} from "./compat.js";
import { collectVersionInfo } from "./diagnostics.js";
import { dirname, join } from "node:path";
import { configDir, loadConfig, maskToken, saveConfig } from "./config.js";
import { credentialBackend, readTokenFile } from "./credentials.js";
import { VERSION } from "./version.js";
import {
  CAPABILITY,
  SdkError,
  WorkflowClient,
} from "../packages/workflow-sdk/src/index.js";
import { V1Client } from "../packages/workflow-sdk/src/v1/index.js";
import { ConversationStore, historyPathFor, normalizeHistorySettings, PromptHistory } from "./terminal/history.js";
import { verifySecurePath } from "./secure-store.js";

export const EXIT = Object.freeze({
  OK: 0,
  ERROR: 1,
  USAGE: 2,
  UNAUTHENTICATED: 3,
  NETWORK: 4,
  NOT_FOUND: 5,
  UNAVAILABLE: 6,
  CANCELLED: 130,
});

function table(rows, headers) {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => String(row[index]).length)),
  );
  const line = (cells) =>
    cells
      .map((cell, index) => String(cell).padEnd(widths[index]))
      .join("  ")
      .trimEnd();
  return [line(headers), line(widths.map((width) => "\u2500".repeat(width))), ...rows.map(line)];
}

function requireBase(ctx) {
  if (!ctx.settings.baseUrl) {
    throw new CoderaxError(
      "BASE_URL_REQUIRED",
      "no deployment configured; run `coderax config set --base-url <url>` or set CODERAX_BASE_URL",
    );
  }
}

function requireAuth(ctx) {
  if (!ctx.settings.token) {
    throw new CoderaxError("UNAUTHENTICATED", "not signed in; run `coderax login` first");
  }
}

const HEALTH_CANDIDATES = ["/health", "/api/health", "/healthz"];

export async function probeHealth({ baseUrl, token, timeoutMs, fetchImpl } = {}) {
  const attempts = [];
  for (const path of HEALTH_CANDIDATES) {
    try {
      const response = await request({ baseUrl, token, path, timeoutMs, fetchImpl });
      return { path, response };
    } catch (error) {
      attempts.push(`${path} (${error.code ?? "ERROR"})`);
      if (error.code === "HTTP_404" || error.code === "HTTP_405") continue;
      throw error;
    }
  }
  throw new CoderaxError(
    "HEALTH_UNAVAILABLE",
    `no health endpoint responded. Tried ${attempts.join(", ")}`,
  );
}

export async function products(ctx) {
  const list = getOrderedProducts();

  if (ctx.json) {
    ctx.out(JSON.stringify({ products: list }, null, 2));
    return EXIT.OK;
  }

  const rows = list.map((product) => [
    product.name,
    STATUS_LABELS[product.status],
    product.status === "live" ? product.tagline : product.availabilityNote,
  ]);
  ctx.out(table(rows, ["PRODUCT", "STATUS", "DETAIL"]).join("\n"));
  ctx.out("");
  ctx.out("Launch states are verified, not aspirational. See `coderax doctor`.");
  return EXIT.OK;
}

export async function cloud(ctx) {
  const product = PRODUCTS.find((entry) => entry.id === "cloud");
  const message = `Coderax Cloud is ${STATUS_LABELS[product.status].toLowerCase()}: ${product.availabilityNote}`;

  if (ctx.json) {
    ctx.out(JSON.stringify({ status: product.status, message, roadmap: product.roadmap }, null, 2));
    return EXIT.UNAVAILABLE;
  }

  ctx.out(message);
  ctx.out("");
  ctx.out("Roadmap:");
  for (const item of product.roadmap) ctx.out(`  \u2022 ${item}`);
  ctx.err("Nothing was executed and nothing was billed.");
  return EXIT.UNAVAILABLE;
}

export async function projects(ctx) {
  if (ctx.json) {
    ctx.out(
      JSON.stringify(
        {
          projects: [],
          unavailable: true,
          reason: "Cloud workspaces are not implemented in this repository yet.",
        },
        null,
        2,
      ),
    );
    return EXIT.UNAVAILABLE;
  }
  ctx.err("Cloud workspaces are not implemented yet, so there are no projects to list.");
  return EXIT.UNAVAILABLE;
}

export async function status(ctx) {
  const settings = ctx.settings;
  const ownerVerified = settings.role === "ADMIN" || settings.authMethod === "v1";
  const payload = {
    version: VERSION,
    baseUrl: settings.baseUrl || null,
    authenticated: Boolean(settings.token),
    role: settings.role ?? null,
    owner: ownerVerified,
    authMethod: settings.authMethod ?? null,
    token: maskToken(settings.token),
    tokenSource: ctx.env.CODERAX_TOKEN
      ? "environment"
      : settings.token
        ? "config file"
        : "none",
    account: settings.account ?? null,
    configPath: settings.configPath,
    configDir: configDir(ctx.env),
    model: settings.model || null,
    endpoint: settings.endpoint,
  };

  if (ctx.json) {
    ctx.out(JSON.stringify(payload, null, 2));
    return EXIT.OK;
  }

  ctx.out(`Coderax CLI      ${VERSION}`);
  ctx.out(`API              ${payload.baseUrl ?? "(not configured)"}`);
  ctx.out(
    `Authentication   ${payload.authenticated ? `yes (${payload.token}, via ${payload.tokenSource})` : "no \u2014 run `coderax login`"}`,
  );
  if (payload.authenticated) {
    ctx.out(
      `Owner            ${ownerVerified
        ? settings.authMethod === "v1"
          ? "verified by the /v1 owner-protected route"
          : "verified"
        : payload.role
          ? `no (role ${payload.role})`
          : "unverified \u2014 run `coderax whoami`"}`,
    );
  }
  if (payload.account) ctx.out(`Account          ${payload.account}`);
  ctx.out(`Config           ${payload.configPath}`);
  return EXIT.OK;
}

export async function login(ctx) {
  requireBase(ctx);
  // Order matters: a file keeps the secret out of argv and shell history, the
  // environment is the CI path, and stdin or a hidden prompt covers interactive
  // use. Passing the token as an argument is refused by the parser.
  const tokenFile = ctx.flags.get("token-file");
  let token;
  if (tokenFile) {
    try {
      token = await readTokenFile(tokenFile);
    } catch (error) {
      throw new CoderaxError("TOKEN_FILE", error.message);
    }
  } else {
    token = ctx.env.CODERAX_TOKEN?.trim() || (await ctx.readSecret());
  }
  if (!token) {
    throw new CoderaxError(
      "USAGE",
      "no token provided; run `coderax login` at a terminal, pipe it on stdin, use `--token-file <path>`, or set CODERAX_TOKEN",
    );
  }

  // Owner-only gate. A token is not persisted until the deployment confirms
  // that this identity is the instance owner. `/api/user` is the legacy gate;
  // `CODERAX_SDK=v1` selects the canonical owner-protected `/v1/agents` route
  // instead, so a deployment that never published the legacy API can still be
  // authenticated without inventing a role the server did not report.
  const requestedSdk = String(ctx.env.CODERAX_SDK ?? "").trim().toLowerCase();
  let identity;
  let authMethod = "legacy";
  if (requestedSdk === "v1") {
    const client = new V1Client({
      baseUrl: ctx.settings.baseUrl,
      token,
      timeoutMs: ctx.settings.timeoutMs,
      fetchImpl: ctx.fetchImpl,
      clientVersion: VERSION,
      signal: ctx.signal,
    });
    try {
      await client.negotiate({ force: true });
      // The contract makes every route except health/readiness owner-gated. A
      // successful agent listing is therefore evidence that the token was
      // accepted, not a claim about an account role the engine never returns.
      await client.agents({ refresh: true });
    } catch (error) {
      if (error instanceof SdkError && (error.code === "UNAUTHENTICATED" || error.code === "FORBIDDEN")) {
        throw new SdkError(
          "OWNER_UNVERIFIABLE",
          "the /v1 owner-protected route rejected this token; it was not stored",
          { status: error.status, details: { endpoint: "/v1/agents" } },
        );
      }
      throw error;
    }
    identity = { account: null, role: null };
    authMethod = "v1";
  } else {
    const client = new WorkflowClient({
      baseUrl: ctx.settings.baseUrl,
      token,
      timeoutMs: ctx.settings.timeoutMs,
      fetchImpl: ctx.fetchImpl,
      clientVersion: VERSION,
      signal: ctx.signal,
    });

    try {
      identity = await client.requireOwner();
    } catch (error) {
      if (error instanceof SdkError && error.code === "NOT_FOUND") {
        throw new SdkError(
          "OWNER_UNVERIFIABLE",
          "/api/user is not exposed by this deployment, so owner-only access cannot be verified; " +
            "set CODERAX_SDK=v1 to verify through /v1/agents. The token was not stored",
          { status: 404, details: { endpoint: "/api/user" } },
        );
      }
      throw error;
    }
  }

  // Prefer an OS credential store that accepts the secret on stdin. When the
  // chosen store is unavailable (for example `secret-tool` is not installed),
  // fall back to the 0600 file and say so rather than pretending.
  let store = credentialBackend(ctx.env);
  const record = {
    token,
    account: identity.account,
    role: identity.role,
    authMethod,
    baseUrl: ctx.settings.baseUrl,
  };
  try {
    await saveConfig(record, {
      filePath: ctx.settings.configPath,
      credentialStore: store,
      env: ctx.env,
    });
  } catch (error) {
    if (store === "file") throw error;
    ctx.err(`coderax: credential store unavailable (${error.message}); using the 0600 config file`);
    store = "file";
    await saveConfig(record, { filePath: ctx.settings.configPath, credentialStore: "file", env: ctx.env });
  }
  ctx.out(
    ctx.json
      ? JSON.stringify(
          {
            authenticated: true,
            token: maskToken(token),
            account: identity.account,
            role: identity.role,
            owner: true,
            authMethod,
          },
          null,
          2,
        )
      : `Signed in as the deployment owner${identity.account ? ` (${identity.account})` : ""}. Token stored in ${
          store === "file" ? "the 0600 config file" : `the operating-system credential store (${store})`
        }.`,
  );
  return EXIT.OK;
}

export async function logout(ctx) {
  const stored = await loadConfig({ env: {}, filePath: ctx.settings.configPath });
  const removed = Boolean(stored.token);
  const environmentTokenActive = Boolean(ctx.env.CODERAX_TOKEN?.trim());
  await saveConfig(
    { token: null, account: null, role: null, authMethod: null, sessions: {} },
    {
      filePath: ctx.settings.configPath,
      // Clear the backend the credential was actually stored in.
      credentialStore: stored.tokenStore ?? "file",
      env: ctx.env,
    },
  );
  const message = environmentTokenActive
    ? "Stored credentials cleared. CODERAX_TOKEN is still set; unset it to sign out of this environment."
    : removed
      ? "Signed out."
      : "No stored credentials.";
  ctx.out(
    ctx.json
      ? JSON.stringify({ removed, environmentTokenActive, message }, null, 2)
      : message,
  );
  return EXIT.OK;
}

async function streamPrompt(ctx, mode) {
  let text = ctx.args.join(" ").trim();
  const interactiveFlag = ctx.flags.has("interactive") || ctx.flags.has("accessible");
  if (interactiveFlag && (text || ctx.json || !ctx.stdinIsTTY)) {
    throw new CoderaxError(
      "USAGE",
      "--interactive/--accessible start a terminal session; they do not accept a prompt, --json, or piped stdin",
    );
  }
  if (ctx.flags.has("resume") && !interactiveFlag) {
    throw new CoderaxError("USAGE", "--resume is only available with --interactive");
  }
  if (!text && !ctx.stdinIsTTY) {
    text = (await ctx.readSecret()).trim();
  }
  if (!text) {
    if (ctx.stdinIsTTY) {
      requireBase(ctx);
      requireAuth(ctx);
      const runner = ctx.interactiveRunner ?? (await import("./interactive.js")).runInteractive;
      return await runner({
        settings: ctx.settings,
        mode,
        env: ctx.env,
        accessible: ctx.flags.has("accessible") || ctx.flags.has("plain"),
        noColor: ctx.flags.has("no-color"),
        resume: ctx.flags.get("resume") ?? false,
        noHistory: ctx.flags.has("no-history"),
      });
    }
    throw new CoderaxError("USAGE", `no message provided; usage: coderax ${mode} "your prompt"`);
  }
  requireBase(ctx);
  requireAuth(ctx);

  const streamed = [];
  const assembled = await streamRequest({
    baseUrl: ctx.settings.baseUrl,
    token: ctx.settings.token,
    path: ctx.flags.get("url") || (mode === "work" ? "/api/work/chat" : ctx.settings.chatPath),
    timeoutMs: ctx.settings.timeoutMs,
    fetchImpl: ctx.fetchImpl,
    signal: ctx.signal,
    body: {
      text,
      mode,
      endpoint: ctx.settings.endpoint,
      model: ctx.settings.model || undefined,
    },
    onEvent: (event) => {
      if (event.type === "delta") {
        streamed.push(event.text);
        if (!ctx.json) ctx.raw(event.text);
      } else if (event.type === "replace") {
        // A cumulative Work snapshot may revise earlier text. The interactive
        // terminal cannot erase already printed lines; display the correction.
        streamed.length = 0;
        streamed.push(event.text);
        if (!ctx.json) ctx.raw(`\n[Revised response]\n${event.text}`);
      }
    },
  });

  const answer = assembled || streamed.join("");
  if (!answer) {
    const message = "The server accepted the request but streamed no text.";
    if (ctx.json) {
      ctx.out(JSON.stringify({ mode, text: "", events: streamed.length, error: message }, null, 2));
    }
    ctx.err(message);
    return EXIT.ERROR;
  }

  if (ctx.json) {
    ctx.out(JSON.stringify({ mode, text: answer, events: streamed.length }, null, 2));
  } else {
    ctx.out("");
  }

  return EXIT.OK;
}

export async function chat(ctx) {
  return streamPrompt(ctx, "chat");
}

export async function work(ctx) {
  return streamPrompt(ctx, "work");
}

export async function history(ctx) {
  const action = ctx.args[0] ?? "list";
  const settings = normalizeHistorySettings(ctx.settings.history, ctx.env);
  const path = historyPathFor(ctx.settings.configPath, ctx.env);
  const store = await PromptHistory.open({ path, settings });

  const persist = async (patch) => {
    await saveConfig(
      { history: { ...settings, ...patch } },
      { filePath: ctx.settings.configPath },
    );
  };

  if (action === "list") {
    const entries = store.list();
    if (ctx.json) {
      ctx.out(JSON.stringify({ history: { path, enabled: store.enabled, retentionDays: store.retentionDays, entries } }, null, 2));
      return EXIT.OK;
    }
    if (!store.enabled) ctx.out("History is disabled.");
    if (entries.length === 0) {
      ctx.out("No saved prompts.");
      return EXIT.OK;
    }
    entries.forEach((entry, index) => {
      const text = entry.text.replace(/\s+/g, " ").trim();
      ctx.out(`${String(index + 1).padStart(3)}  ${new Date(entry.at).toISOString().slice(0, 16).replace("T", " ")}  ${text.slice(0, 100)}`);
    });
    return EXIT.OK;
  }

  if (action === "clear") {
    await store.clear();
    ctx.out(ctx.json ? JSON.stringify({ cleared: true, path }, null, 2) : "Prompt history cleared.");
    return EXIT.OK;
  }

  if (action === "off" || action === "on") {
    const enabled = action === "on";
    await store.setEnabled(enabled);
    if (!enabled) {
      // Conversation metadata can contain a prompt excerpt, so disabling
      // history also removes it rather than leaving it on disk.
      const conversations = await ConversationStore.open({
        path: join(dirname(ctx.settings.configPath), "conversations.json"),
      });
      await conversations.clear();
    }
    await persist({ enabled });
    ctx.out(ctx.json ? JSON.stringify({ enabled }, null, 2) : `History ${enabled ? "enabled" : "disabled"}.`);
    return EXIT.OK;
  }

  if (action === "retention") {
    const days = Number(ctx.args[1]);
    if (!Number.isInteger(days) || days < 1 || days > 3650) {
      throw new CoderaxError("USAGE", "history retention must be an integer number of days between 1 and 3650");
    }
    store.setRetentionDays(days);
    await persist({ retentionDays: days });
    if (store.enabled) await store.persist().catch(() => {});
    ctx.out(ctx.json ? JSON.stringify({ retentionDays: days }, null, 2) : `History retention set to ${days} days.`);
    return EXIT.OK;
  }

  throw new CoderaxError("USAGE", `unknown history action: ${action}`);
}

export async function doctor(ctx) {
  const checks = [];
  let backendDependencies = [];
  const add = (name, ok, detail, hint, severity = "error") => {
    checks.push({ name, ok, detail, hint, severity });
  };

  const major = Number(process.versions.node.split(".")[0]);
  add("node", major >= 24, process.versions.node, major >= 24 ? "" : "Node 24 or newer is required.");

  const install = ctx.install ?? collectVersionInfo({ env: ctx.env ?? process.env });
  add("install", true, `${install.installMethod} (${install.installPath})`, "");

  const directory = dirname(ctx.settings.configPath);
  let dirMode = null;
  try {
    dirMode = (await import("node:fs")).statSync(directory).mode & 0o777;
  } catch {
    dirMode = null;
  }
  add(
    "config-dir",
    process.platform === "win32" || dirMode === null || dirMode === 0o700,
    dirMode === null ? `${directory} (not created yet)` : `${directory} (${dirMode.toString(8)})`,
    process.platform === "win32" || dirMode === null || dirMode === 0o700
      ? ""
      : "Run `chmod 700` on the config directory.",
  );

  add(
    "config-file",
    true,
    ctx.settings.configPath,
    "The config file is created with mode 0600 and refused if group/other readable.",
    "warning",
  );

  add(
    "base-url",
    Boolean(ctx.settings.baseUrl),
    ctx.settings.baseUrl || "(unset)",
    ctx.settings.baseUrl ? "" : "Run `coderax config set base-url https://your-deployment`.",
  );
  add(
    "auth",
    Boolean(ctx.settings.token),
    ctx.settings.token
      ? `${maskToken(ctx.settings.token)} via ${ctx.env.CODERAX_TOKEN ? "environment" : "config file"}`
      : "no token",
    ctx.settings.token ? "" : "Run `coderax login`.",
  );

  if (ctx.settings.baseUrl && ctx.settings.token) {
    const client = new WorkflowClient({
      baseUrl: ctx.settings.baseUrl,
      token: ctx.settings.token,
      timeoutMs: ctx.settings.timeoutMs,
      fetchImpl: ctx.fetchImpl,
      clientVersion: VERSION,
      signal: ctx.signal,
      strict: false,
    });

    try {
      const identity = await client.requireOwner();
      add("owner", true, `role ${identity.role}${identity.account ? ` (${identity.account})` : ""}`, "");
    } catch (error) {
      add(
        "owner",
        false,
        error.message,
        error.code === "OWNER_UNVERIFIABLE"
          ? "The deployment must expose /api/user with the authenticated role."
          : "Sign in with the deployment owner's token; the CLI is owner-only.",
      );
    }

    try {
      const state = await client.negotiate();
      if (state.apiVersion === null) {
        add(
          "api-version",
          true,
          "unverified (no /api/meta)",
          "Publish /api/meta with { apiVersion, capabilities }; without it the CLI cannot pin compatibility or verify replay support.",
          "warning",
        );
      } else {
        add("api-version", true, state.apiVersion, "");
      }

      const deployment = await detectDeploymentVersion({
        baseUrl: ctx.settings.baseUrl,
        token: ctx.settings.token,
        timeoutMs: ctx.settings.timeoutMs,
        fetchImpl: ctx.fetchImpl,
      });
      const deployed = deployment === null ? null : isSupportedDeploymentVersion(deployment.version);
      add(
        "deployment",
        deployed === null || deployed.supported !== false,
        deployment === null
          ? "not published in the OpenAPI document"
          : `${deployment.version} (${deployment.source}) ${
              deployed.supported === true ? "supported" : deployed.supported === false ? "unsupported" : "unknown"
            }`,
        deployed?.supported === false
          ? `The deployment is ${deployed.reason}. Upgrade it or install a CLI release that supports it.`
          : "",
        deployed === null ? "warning" : "error",
      );

      const capabilities = [...state.capabilities].sort();
      add(
        "capabilities",
        capabilities.length > 0,
        capabilities.length > 0 ? capabilities.join(", ") : "none advertised",
        "The deployment publishes no capability metadata; the CLI probed safe GET routes.",
        "warning",
      );

      const workflows = state.capabilities.has(CAPABILITY.workflows);
      backendDependencies = [
        {
          capability: CAPABILITY.chat,
          status: "enforced-per-request",
          endpoint: "/api/work/chat",
          note: "SSE vs JSON is rejected at the response boundary",
        },
        {
          capability: CAPABILITY.workTasks,
          status: state.capabilities.has(CAPABILITY.workTasks) ? "available" : "missing",
          endpoint: "/api/work/tasks",
        },
        {
          capability: CAPABILITY.workflows,
          status: workflows ? "available" : "missing",
          endpoint: "/api/workflows",
        },
        {
          capability: CAPABILITY.builds,
          status: workflows ? "inferred" : "missing",
          endpoint: "/api/workflows/builds",
          note: "POST 404 is reported as CAPABILITY_UNAVAILABLE",
        },
        {
          capability: CAPABILITY.runStream,
          status: workflows ? "inferred" : "missing",
          endpoint: "/api/workflows/runs/:id/stream",
          note: "snapshot-only; no Last-Event-ID support in the current backend",
        },
        {
          capability: CAPABILITY.repos,
          status: state.capabilities.has(CAPABILITY.repos) ? "available" : "missing",
          endpoint: "/api/repos",
          note: "absent: pass --repo <owner/name> to work submit",
        },
      ];
      const missing = backendDependencies.filter((entry) => entry.status === "missing");
      add(
        "backend",
        missing.length === 0,
        missing.length === 0
          ? "required routes present"
          : `missing: ${missing.map((entry) => entry.capability).join(", ")}`,
        "Deploy the matching Coderax backend; dependent commands fail closed.",
        "warning",
      );
    } catch (error) {
      add("api-version", false, error.message, "Check the deployment URL and token.");
    }
  }

  if (ctx.settings.baseUrl) {
    try {
      const { path, response } = await probeHealth({
        baseUrl: ctx.settings.baseUrl,
        token: ctx.settings.token,
        timeoutMs: ctx.settings.timeoutMs,
        fetchImpl: ctx.fetchImpl,
      });
      add("reachability", true, `GET ${path} HTTP ${response.status}`, "");
    } catch (error) {
      add(
        "reachability",
        false,
        error.message,
        "Confirm the deployment URL and that a health endpoint is exposed.",
      );
    }
  }

  const historyPath = historyPathFor(ctx.settings.configPath, ctx.env);
  const historyVerification = await verifySecurePath(historyPath, { platform: process.platform });
  const historyExists = historyVerification.reason !== "MISSING";
  checks.push({
    name: "history",
    ok: !historyExists || historyVerification.ok,
    detail: historyExists ? historyVerification.detail : `${historyPath} (not created yet)`,
    hint:
      !historyExists || historyVerification.ok
        ? ""
        : "Run `coderax history off` or restrict the history file; prompts are not stored until it is private.",
  });
  checks.push({
    name: "terminal",
    ok: true,
    detail: process.stdout.isTTY
      ? `${process.stdout.columns || "?"}x${process.stdout.rows || "?"} TTY`
      : "non-interactive (pipes/CI)",
    hint: "",
  });

  const failed = checks.filter((check) => !check.ok && check.severity !== "warning");
  const ok = failed.length === 0;
  if (ctx.json) {
    ctx.out(
      JSON.stringify({ ok, version: VERSION, checks, backendDependencies }, null, 2),
    );
    return ok ? EXIT.OK : EXIT.ERROR;
  }
  for (const check of checks) {
    const mark = check.ok ? "\u2713" : check.severity === "warning" ? "!" : "\u2717";
    ctx.out(`${mark} ${check.name.padEnd(14)} ${check.detail}`);
    if (!check.ok && check.hint) ctx.out(`  \u2192 ${check.hint}`);
  }
  return ok ? EXIT.OK : EXIT.ERROR;
}

export async function compat(ctx) {
  requireBase(ctx);
  const verdict = await checkCompatibility({
    baseUrl: ctx.settings.baseUrl,
    token: ctx.settings.token,
    timeoutMs: ctx.settings.timeoutMs,
    fetchImpl: ctx.fetchImpl,
    signal: ctx.signal,
  });
  const status =
    verdict.supported === true ? "compatible" : verdict.supported === false ? "incompatible" : "unknown";
  const payload = { cliVersion: VERSION, status, ...verdict };

  if (ctx.json) {
    ctx.out(JSON.stringify(payload, null, 2));
    return verdict.supported === true ? EXIT.OK : EXIT.ERROR;
  }

  ctx.out(`CLI              ${VERSION} (API ${verdict.apiRange})`);
  ctx.out(`API version      ${verdict.apiVersion ?? "(not reported)"}${verdict.apiSource ? ` (${verdict.apiSource})` : ""}`);
  ctx.out(
    `Deployment       ${verdict.deploymentVersion ?? "(not published)"}${
      verdict.deploymentSource ? ` (${verdict.deploymentSource})` : ""
    }`,
  );
  ctx.out(`Supported        ${verdict.range} deployments, API ${verdict.apiRange}`);
  ctx.out(`Basis            ${verdict.basis}`);
  ctx.out(`Compatibility    ${status} \u2014 ${verdict.reason}`);
  return verdict.supported === true ? EXIT.OK : EXIT.ERROR;
}

export async function update(ctx) {
  const message =
    "This build is not published to a registry yet. Update by pulling the "
    + "Coderax-CLI repository and running `node src/cli.js` again, or reinstall "
    + "once coderax-cli is published.";
  ctx.out(ctx.json ? JSON.stringify({ version: VERSION, message }, null, 2) : message);
  return EXIT.OK;
}

