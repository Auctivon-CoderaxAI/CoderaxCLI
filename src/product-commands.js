import { statSync } from "node:fs";
import { dirname } from "node:path";
import { PRODUCTS, STATUS_LABELS, getOrderedProducts } from "./product-registry.js";
import { CoderaxError, request } from "./client.js";
import { configDir } from "./config.js";
import { readTokenFile } from "./credentials.js";
import {
  checkCompatibility,
  detectDeploymentVersion,
  isSupportedDeploymentVersion,
} from "./compat.js";
import { collectVersionInfo } from "./diagnostics.js";
import { CAPABILITY } from "../packages/workflow-sdk/src/contract.js";
import { WorkflowClient } from "../packages/workflow-sdk/src/index.js";
import { VERSION } from "./version.js";
import {
  HEALTH_CANDIDATES,
  authorizedStream,
  deviceLogin,
  localAuthStatus,
  loginWithToken,
  logoutSession,
  resolveSession,
  whoamiIdentity,
} from "./auth.js";

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

function sessionLabel(report) {
  if (report.session === "active") return "active";
  if (report.session === "expired") return "expired \u2014 run `coderax login`";
  return "none \u2014 run `coderax login`";
}

export async function status(ctx) {
  const report = await localAuthStatus(ctx);
  const payload = {
    version: VERSION,
    baseUrl: report.baseUrl,
    authenticated: report.authenticated,
    session: report.session,
    source: report.source,
    token: report.tokenMask,
    account: report.account,
    subject: report.subject,
    expiresAt: report.expiresAt,
    expiresInSeconds: report.expiresInSeconds,
    refreshable: report.refreshable,
    scopes: report.scopes,
    scopesKnown: report.scopesKnown,
    credentialStore: report.credentialStore,
    legacyPlaintextToken: report.legacyPlaintextToken,
    configPath: report.configPath,
    configDir: configDir(ctx.env),
    model: ctx.settings.model || null,
    endpoint: ctx.settings.endpoint,
  };

  if (ctx.json) {
    ctx.out(JSON.stringify(payload, null, 2));
    return EXIT.OK;
  }

  ctx.out(`Coderax CLI      ${VERSION}`);
  ctx.out(`API              ${payload.baseUrl ?? "(not configured)"}`);
  ctx.out(
    `Authentication   ${payload.authenticated ? `yes (${payload.token ?? "token"}, via ${payload.source})` : `no \u2014 ${sessionLabel(report)}`}`,
  );
  if (payload.account) ctx.out(`Account          ${payload.account}`);
  ctx.out(
    `Credentials      ${payload.credentialStore.available ? payload.credentialStore.name : `unavailable \u2014 ${payload.credentialStore.detail}`}`,
  );
  if (payload.expiresAt) {
    ctx.out(`Expires          ${new Date(payload.expiresAt).toISOString()}`);
  }
  ctx.out(`Config           ${payload.configPath}`);
  if (payload.legacyPlaintextToken) {
    ctx.err(
      `warning: a legacy plaintext token is present in ${payload.configPath}; run \`coderax login --with-token\` to migrate it, or delete the token field`,
    );
  }
  return EXIT.OK;
}

/** `coderax auth status`: local credential and session report, no network. */
export async function authStatus(ctx) {
  const report = await localAuthStatus(ctx);

  if (ctx.json) {
    ctx.out(JSON.stringify(report, null, 2));
    return EXIT.OK;
  }

  ctx.out(`Deployment       ${report.baseUrl ?? "(not configured)"}`);
  ctx.out(`Session          ${sessionLabel(report)}`);
  ctx.out(`Credential source ${report.source}`);
  ctx.out(
    `Credential store ${report.credentialStore.available ? `${report.credentialStore.name} (${report.credentialStore.detail})` : `unavailable \u2014 ${report.credentialStore.detail}`}`,
  );
  if (report.account) ctx.out(`Account          ${report.account}`);
  ctx.out(
    `Expiry           ${
      report.expiresAt
        ? `${new Date(report.expiresAt).toISOString()} (${report.expirySource}, ${report.expiresInSeconds}s remaining)`
        : "not reported by the token"
    }`,
  );
  ctx.out(`Refresh          ${report.refreshable ? "available" : "not available"}`);
  ctx.out(`Scopes           ${report.scopesKnown ? report.scopes.join(" ") || "(none)" : "not reported by the deployment"}`);
  if (report.originBound !== null) ctx.out(`Origin bound     ${report.originBound ? "yes" : "no \u2014 run `coderax login`"}`);
  ctx.out(`Config           ${report.configPath}`);
  if (report.legacyPlaintextToken) {
    ctx.err(
      `warning: a legacy plaintext token is present in ${report.configPath}; run \`coderax login --with-token\` to migrate it, or delete the token field`,
    );
  }
  if (report.credentialError) ctx.err(`warning: ${report.credentialError.message}`);
  return EXIT.OK;
}

function emitLogin(ctx, result) {
  const payload = {
    authenticated: true,
    account: result.account ?? null,
    subject: result.subject ?? null,
    baseUrl: result.credential.baseUrl,
    expiresAt: result.credential.expiresAt,
    expirySource: result.credential.expirySource,
    scopes: result.credential.scopes,
    scopesKnown: result.credential.scopesKnown,
    refreshable: Boolean(result.credential.refreshToken),
    credentialStore: ctx.credentialStore.name,
    warnings: result.warnings ?? [],
  };

  if (ctx.json) {
    ctx.out(JSON.stringify(payload, null, 2));
    return;
  }

  ctx.out(`Signed in${payload.account ? ` as ${payload.account}` : ""} to ${payload.baseUrl}.`);
  ctx.out(
    `Session expires ${payload.expiresAt ? new Date(payload.expiresAt).toISOString() : "at an unknown time"}; credentials are in ${payload.credentialStore}.`,
  );
  if (payload.scopesKnown) ctx.out(`Scopes: ${payload.scopes.join(" ") || "(none)"}`);
  for (const warning of payload.warnings) ctx.err(`warning: ${warning}`);
}

export async function login(ctx) {
  requireBase(ctx);

  const tokenFile = ctx.flags.get("token-file");
  if (tokenFile !== undefined) {
    let token;
    try {
      token = await readTokenFile(tokenFile);
    } catch (error) {
      throw new CoderaxError("TOKEN_FILE", error.message);
    }
    const result = await loginWithToken(ctx, token, { source: "token-file" });
    emitLogin(ctx, result);
    return EXIT.OK;
  }

  if (ctx.flags.get("with-token")) {
    const environmentToken = typeof ctx.env.CODERAX_TOKEN === "string"
      ? ctx.env.CODERAX_TOKEN.trim()
      : "";
    const token = environmentToken || (await ctx.readSecret()).trim();
    if (!token) {
      throw new CoderaxError(
        "USAGE",
        "no token provided on stdin; pipe a deployment-issued session token to `coderax login --with-token` (never a provider API key)",
      );
    }
    const result = await loginWithToken(ctx, token, { source: environmentToken ? "environment" : "stdin" });
    emitLogin(ctx, result);
    return EXIT.OK;
  }

  const result = await deviceLogin(ctx, {
    ...(ctx.authDeps ?? {}),
    noBrowser: ctx.flags.has("no-browser"),
    notify: (text) => (ctx.json ? ctx.err(text) : ctx.out(text)),
  });
  emitLogin(ctx, result);
  return EXIT.OK;
}

export async function logout(ctx) {
  const result = await logoutSession(ctx);
  const message = result.credentialRemovalFailed
    ? "Could not fully remove the stored credential; see the warnings below."
    : result.environmentTokenActive
      ? "Stored credentials cleared. CODERAX_TOKEN is still set; unset it to sign out of this environment."
      : result.removed || result.legacyRemoved
        ? "Signed out."
        : "No stored credentials.";

  if (ctx.json) {
    ctx.out(
      JSON.stringify(
        {
          removed: result.removed,
          legacyRemoved: result.legacyRemoved,
          environmentTokenActive: result.environmentTokenActive,
          revocation: result.revocation,
          warnings: result.warnings,
          message,
        },
        null,
        2,
      ),
    );
  } else {
    ctx.out(message);
    for (const warning of result.warnings) ctx.err(`warning: ${warning}`);
  }
  return result.credentialRemovalFailed ? EXIT.ERROR : EXIT.OK;
}

export async function whoami(ctx) {
  requireBase(ctx);
  const result = await whoamiIdentity(ctx);
  const payload = {
    authenticated: true,
    baseUrl: result.session.baseUrl,
    account: result.account,
    subject: result.subject,
    role: result.role,
    owner: result.owner,
    source: result.session.source,
    scopes: result.session.scopes,
    scopesKnown: result.session.scopesKnown,
    expiresAt: result.session.expiresAt,
    expiresInSeconds: result.session.expiresAt === null
      ? null
      : Math.max(0, Math.floor((result.session.expiresAt - Date.now()) / 1000)),
    refreshable: result.session.refreshable,
    remoteIdentity: result.remote.available,
  };

  if (ctx.json) {
    ctx.out(JSON.stringify(payload, null, 2));
    return EXIT.OK;
  }

  ctx.out(`Signed in to ${payload.baseUrl}`);
  if (payload.account) ctx.out(`Account          ${payload.account}`);
  if (payload.subject) ctx.out(`Subject          ${payload.subject}`);
  ctx.out(`Role             ${payload.role ?? "(not reported)"}`);
  ctx.out(`Owner            ${payload.owner ? "yes" : "no"}`);
  ctx.out(`Source           ${payload.source}`);
  if (payload.expiresAt) ctx.out(`Expires          ${new Date(payload.expiresAt).toISOString()}`);
  ctx.out(`Scopes           ${payload.scopesKnown ? payload.scopes.join(" ") || "(none)" : "not reported by the deployment"}`);
  if (!payload.remoteIdentity) ctx.out("Note             the deployment did not expose a userinfo endpoint");
  return payload.owner ? EXIT.OK : EXIT.UNAUTHENTICATED;
}

async function streamPrompt(ctx, mode) {
  let text = ctx.args.join(" ").trim();
  if (!text && !ctx.stdinIsTTY) {
    text = (await ctx.readSecret()).trim();
  }
  if (!text) {
    throw new CoderaxError("USAGE", `no message provided; usage: coderax ${mode} "your prompt"`);
  }
  requireBase(ctx);

  const streamed = [];
  const assembled = await authorizedStream(
    ctx,
    {
      path: ctx.flags.get("url") || (mode === "work" ? "/api/work/chat" : ctx.settings.chatPath),
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
    },
    { requiredScope: mode === "work" ? "coderax:work" : "coderax:chat" },
  );

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

export async function doctor(ctx) {
  const checks = [];
  let backendDependencies = [];
  const major = Number(process.versions.node.split(".")[0]);
  checks.push({
    name: "node",
    ok: major >= 24,
    detail: process.versions.node,
    hint: major >= 24 ? "" : "Node 24 or newer is required.",
  });

  const install = ctx.install ?? collectVersionInfo({ env: ctx.env ?? process.env });
  checks.push({
    name: "install",
    ok: true,
    detail: `${install.installMethod} (${install.installPath})`,
    hint: "",
  });

  const directory = dirname(ctx.settings.configPath);
  let dirMode = null;
  try {
    dirMode = statSync(directory).mode & 0o777;
  } catch {
    dirMode = null;
  }
  checks.push({
    name: "config-dir",
    ok: process.platform === "win32" || dirMode === null || dirMode === 0o700,
    detail: dirMode === null ? `${directory} (not created yet)` : `${directory} (${dirMode.toString(8)})`,
    hint:
      process.platform === "win32" || dirMode === null || dirMode === 0o700
        ? ""
        : "Run `chmod 700` on the config directory.",
  });

  const tlsOk = String(ctx.env.NODE_TLS_REJECT_UNAUTHORIZED ?? "").trim() !== "0";
  checks.push({
    name: "tls",
    ok: tlsOk,
    detail: tlsOk ? "certificate verification enabled" : "NODE_TLS_REJECT_UNAUTHORIZED=0",
    hint: tlsOk ? "" : "Unset NODE_TLS_REJECT_UNAUTHORIZED before using credentials.",
  });

  checks.push({
    name: "base-url",
    ok: Boolean(ctx.settings.baseUrl),
    detail: ctx.settings.baseUrl || "(unset)",
    hint: ctx.settings.baseUrl ? "" : "Run `coderax config set base-url https://your-deployment`.",
  });

  const report = await localAuthStatus(ctx);
  const environmentToken = typeof ctx.env.CODERAX_TOKEN === "string" && ctx.env.CODERAX_TOKEN.trim() !== "";
  checks.push({
    name: "credential-store",
    ok: report.credentialStore.available || environmentToken,
    detail: report.credentialStore.available
      ? `${report.credentialStore.name} (${report.credentialStore.detail})`
      : environmentToken
        ? `unavailable (${report.credentialStore.detail}); CODERAX_TOKEN automation is active`
        : report.credentialStore.detail,
    hint: report.credentialStore.available
      ? ""
      : environmentToken
        ? "CODERAX_TOKEN is process-scoped and never written to disk."
        : "Install an OS credential store or use CODERAX_TOKEN for automation.",
  });

  checks.push({
    name: "session",
    ok: report.authenticated,
    detail:
      report.session === "active"
        ? `${report.account ?? "signed in"} via ${report.source}${report.expiresAt ? `, expires ${new Date(report.expiresAt).toISOString()}` : ""}`
        : report.session === "expired"
          ? "expired"
          : "no session",
    hint: report.authenticated ? "" : "Run `coderax login`.",
  });

  if (report.authenticated) {
    try {
      const identity = await whoamiIdentity(ctx);
      checks.push({
        name: "owner",
        ok: identity.owner,
        detail: identity.role ? `role ${identity.role}` : "role not reported",
        hint: identity.owner
          ? ""
          : "Sign in with the deployment owner; owner-only access cannot be verified from this identity.",
      });
    } catch (error) {
      checks.push({
        name: "owner",
        ok: false,
        detail: error.message,
        hint: "The deployment must expose an authenticated role for /api/user.",
      });
    }

    if (ctx.settings.baseUrl) {
      let token = null;
      try {
        token = (await resolveSession(ctx)).accessToken;
      } catch {
        token = null;
      }
      if (token !== null) {
        const client = new WorkflowClient({
          baseUrl: ctx.settings.baseUrl,
          token,
          timeoutMs: ctx.settings.timeoutMs,
          fetchImpl: ctx.fetchImpl,
          clientVersion: VERSION,
          signal: ctx.signal,
          strict: false,
        });
        try {
          const state = await client.negotiate();
          checks.push({
            name: "api-version",
            ok: true,
            detail: state.apiVersion === null ? "unverified (no /api/meta)" : state.apiVersion,
            hint:
              state.apiVersion === null
                ? "Publish /api/meta with { apiVersion, capabilities }; without it the CLI cannot pin compatibility."
                : "",
          });

          const deployment = await detectDeploymentVersion({
            baseUrl: ctx.settings.baseUrl,
            token,
            timeoutMs: ctx.settings.timeoutMs,
            fetchImpl: ctx.fetchImpl,
          });
          const deployed = deployment === null ? null : isSupportedDeploymentVersion(deployment.version);
          checks.push({
            name: "deployment",
            ok: deployed === null || deployed.supported !== false,
            detail:
              deployment === null
                ? "not published in the OpenAPI document"
                : `${deployment.version} (${deployment.source}) ${
                    deployed.supported === true ? "supported" : deployed.supported === false ? "unsupported" : "unknown"
                  }`,
            hint:
              deployed?.supported === false
                ? `The deployment is ${deployed.reason}. Upgrade it or install a CLI release that supports it.`
                : "",
          });

          const capabilities = [...state.capabilities].sort();
          checks.push({
            name: "capabilities",
            ok: capabilities.length > 0,
            detail: capabilities.length > 0 ? capabilities.join(", ") : "none advertised",
            hint: "The deployment publishes no capability metadata; the CLI probed safe GET routes.",
          });

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
          checks.push({
            name: "backend",
            ok: missing.length === 0,
            detail:
              missing.length === 0
                ? "required routes present"
                : `missing: ${missing.map((entry) => entry.capability).join(", ")}`,
            hint: "Deploy the matching Coderax backend; dependent commands fail closed.",
          });
        } catch (error) {
          checks.push({
            name: "api-version",
            ok: false,
            detail: error.message,
            hint: "Check the deployment URL and token.",
          });
        }
      }
    }
  }

  if (report.legacyPlaintextToken) {
    checks.push({
      name: "legacy-token",
      ok: false,
      detail: `plaintext token in ${report.configPath}`,
      hint: "Run `coderax login --with-token` to migrate it or delete the token field.",
    });
  }

  if (ctx.settings.baseUrl) {
    let token = null;
    try {
      token = (await resolveSession(ctx)).accessToken;
    } catch {
      token = null;
    }
    try {
      const { path, response } = await probeHealth({
        baseUrl: ctx.settings.baseUrl,
        token,
        timeoutMs: ctx.settings.timeoutMs,
        fetchImpl: ctx.fetchImpl,
      });
      checks.push({ name: "reachability", ok: true, detail: `GET ${path} HTTP ${response.status}`, hint: "" });
    } catch (error) {
      checks.push({
        name: "reachability",
        ok: false,
        detail: error.message,
        hint: "Confirm the deployment URL and that a health endpoint is exposed.",
      });
    }
  }

  const ok = checks.every((check) => check.ok);
  if (ctx.json) {
    ctx.out(JSON.stringify({ ok, version: VERSION, checks, backendDependencies }, null, 2));
    return ok ? EXIT.OK : EXIT.ERROR;
  }
  for (const check of checks) {
    ctx.out(`${check.ok ? "\u2713" : "\u2717"} ${check.name.padEnd(16)} ${check.detail}`);
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
