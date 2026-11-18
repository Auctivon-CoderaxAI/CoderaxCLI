import { PRODUCTS, STATUS_LABELS, getOrderedProducts } from "./product-registry.js";
import { CoderaxError, request, streamRequest } from "./client.js";
import { dirname } from "node:path";
import { configDir, loadConfig, maskToken, saveConfig } from "./config.js";
import { VERSION } from "./version.js";

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
  const payload = {
    version: VERSION,
    baseUrl: settings.baseUrl || null,
    authenticated: Boolean(settings.token),
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
  if (payload.account) ctx.out(`Account          ${payload.account}`);
  ctx.out(`Config           ${payload.configPath}`);
  return EXIT.OK;
}

export async function login(ctx) {
  requireBase(ctx);
  const token = ctx.flags.get("token") || ctx.env.CODERAX_TOKEN || (await ctx.readSecret());
  if (!token) {
    throw new CoderaxError("USAGE", "no token provided; use `coderax login --token <token>` or pipe it on stdin");
  }

  let account = null;
  try {
    const user = await request({
      baseUrl: ctx.settings.baseUrl,
      token,
      path: "/api/user",
      timeoutMs: ctx.settings.timeoutMs,
      fetchImpl: ctx.fetchImpl,
    });
    account = user.json?.email ?? user.json?.username ?? user.json?.name ?? null;
  } catch (error) {
    // A 404 means the deployment does not expose /api/user; anything else is a
    // real rejection and must not be stored.
    if (error?.status !== 404) throw error;
  }

  await saveConfig({ token, account, baseUrl: ctx.settings.baseUrl }, { filePath: ctx.settings.configPath });
  ctx.out(
    ctx.json
      ? JSON.stringify({ authenticated: true, token: maskToken(token), account }, null, 2)
      : `Signed in${account ? ` as ${account}` : ""}. Token stored with 0600 permissions.`,
  );
  return EXIT.OK;
}

export async function logout(ctx) {
  const stored = await loadConfig({ env: {}, filePath: ctx.settings.configPath });
  const removed = Boolean(stored.token);
  const environmentTokenActive = Boolean(ctx.env.CODERAX_TOKEN?.trim());
  await saveConfig({ token: null, account: null }, { filePath: ctx.settings.configPath });
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
  if (!text && !ctx.stdinIsTTY) {
    text = (await ctx.readSecret()).trim();
  }
  if (!text) {
    throw new CoderaxError("USAGE", `no message provided; usage: coderax ${mode} "your prompt"`);
  }
  requireBase(ctx);
  requireAuth(ctx);

  const streamed = [];
  const assembled = await streamRequest({
    baseUrl: ctx.settings.baseUrl,
    token: ctx.settings.token,
    path: ctx.flags.get("url") || ctx.settings.chatPath,
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

export async function doctor(ctx) {
  const checks = [];
  const major = Number(process.versions.node.split(".")[0]);
  checks.push({
    name: "node",
    ok: major >= 24,
    detail: process.versions.node,
    hint: major >= 24 ? "" : "Node 24 or newer is required.",
  });

  const directory = dirname(ctx.settings.configPath);
  let dirMode = null;
  try {
    dirMode = (await import("node:fs")).statSync(directory).mode & 0o777;
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

  checks.push({
    name: "base-url",
    ok: Boolean(ctx.settings.baseUrl),
    detail: ctx.settings.baseUrl || "(unset)",
    hint: ctx.settings.baseUrl ? "" : "Run `coderax config set base-url https://your-deployment`.",
  });
  checks.push({
    name: "auth",
    ok: Boolean(ctx.settings.token),
    detail: ctx.settings.token
      ? `${maskToken(ctx.settings.token)} via ${ctx.env.CODERAX_TOKEN ? "environment" : "config file"}`
      : "no token",
    hint: ctx.settings.token ? "" : "Run `coderax login`.",
  });

  if (ctx.settings.baseUrl) {
    try {
      const { path, response } = await probeHealth({
        baseUrl: ctx.settings.baseUrl,
        token: ctx.settings.token,
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
    ctx.out(JSON.stringify({ ok, version: VERSION, checks }, null, 2));
    return ok ? EXIT.OK : EXIT.ERROR;
  }
  for (const check of checks) {
    ctx.out(`${check.ok ? "\u2713" : "\u2717"} ${check.name.padEnd(14)} ${check.detail}`);
    if (!check.ok && check.hint) ctx.out(`  \u2192 ${check.hint}`);
  }
  return ok ? EXIT.OK : EXIT.ERROR;
}

export async function update(ctx) {
  const message =
    "This build is not published to a registry yet. Update by pulling the "
    + "Coderax-CLI repository and running `node src/cli.js` again, or reinstall "
    + "once coderax-cli is published.";
  ctx.out(ctx.json ? JSON.stringify({ version: VERSION, message }, null, 2) : message);
  return EXIT.OK;
}

