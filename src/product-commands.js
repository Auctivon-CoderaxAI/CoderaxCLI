import { PRODUCTS, STATUS_LABELS, getOrderedProducts } from "./product-registry.js";
import { CoderaxError, request, streamRequest } from "./client.js";
import { dirname, join } from "node:path";
import { configDir, loadConfig, maskToken, saveConfig } from "./config.js";
import { VERSION } from "./version.js";
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

