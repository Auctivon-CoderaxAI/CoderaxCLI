import { PRODUCTS, STATUS_LABELS, getOrderedProducts } from "./product-registry.js";
import { CoderaxError, request, streamRequest } from "./client.js";
import { dirname } from "node:path";
import { configDir, maskToken } from "./config.js";
import { describeAuth, loginWithToken, logoutSession, readTokenFile } from "./auth.js";
import { EXIT } from "./exit.js";
import { table } from "./format.js";
import { VERSION } from "./version.js";

export { EXIT };

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
  const auth = await describeAuth({
    baseUrl: settings.baseUrl,
    credentialStore: settings.credentialStore,
    env: ctx.env,
  });
  const payload = {
    version: VERSION,
    baseUrl: settings.baseUrl || null,
    authenticated: Boolean(settings.token),
    token: maskToken(settings.token),
    tokenSource: settings.tokenSource ?? "none",
    legacyPlaintextToken: settings.tokenSource === "config file",
    credentialStore: auth.store,
    storedCredential: auth.stored,
    credentialError: auth.credentialError ?? settings.authError ?? null,
    account: settings.account ?? auth.account ?? null,
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
  ctx.out(
    `Credential store ${payload.credentialStore.available ? `${payload.credentialStore.name} (${payload.credentialStore.detail})` : `unavailable \u2014 ${payload.credentialStore.detail}`}`,
  );
  if (payload.credentialError) ctx.out(`Credential error ${payload.credentialError}`);
  if (payload.account) ctx.out(`Account          ${payload.account}`);
  ctx.out(`Config           ${payload.configPath}`);
  return EXIT.OK;
}

export async function login(ctx) {
  requireBase(ctx);
  const settings = ctx.settings;
  let token;
  let source;

  if (ctx.flags.has("token-file")) {
    try {
      token = await readTokenFile(ctx.flags.get("token-file"));
    } catch (error) {
      // A refused token file is a credential error, not an unexpected crash.
      throw new CoderaxError(error.code ?? "CREDENTIAL_FILE", error.message);
    }
    source = "token file";
  } else {
    token = ctx.env.CODERAX_TOKEN || (await ctx.readSecret());
    source = ctx.env.CODERAX_TOKEN ? "environment" : "stdin";
  }

  const result = await loginWithToken(
    {
      ...settings,
      credentialStore: ctx.credentialStore,
      configPath: settings.configPath,
      env: ctx.env,
      fetchImpl: ctx.fetchImpl,
    },
    token,
    { source },
  );

  ctx.out(
    ctx.json
      ? JSON.stringify(
        {
          authenticated: true,
          token: maskToken(result.token),
          account: result.account,
          store: result.store,
          source: result.source,
        },
        null,
        2,
      )
      : `Signed in${result.account ? ` as ${result.account}` : ""}. Credential stored in ${result.store}.`,
  );
  return EXIT.OK;
}

export async function logout(ctx) {
  const result = await logoutSession({
    baseUrl: ctx.settings.baseUrl,
    credentialStore: ctx.credentialStore,
    configPath: ctx.settings.configPath,
    env: ctx.env,
  });
  ctx.out(ctx.json ? JSON.stringify(result, null, 2) : result.message);
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
      ? `${maskToken(ctx.settings.token)} via ${ctx.settings.tokenSource ?? "unknown"}`
      : "no token",
    hint: ctx.settings.token ? "" : "Run `coderax login`.",
  });
  checks.push({
    name: "credential-store",
    ok: Boolean(ctx.credentialStore?.available),
    detail: ctx.credentialStore?.available
      ? `${ctx.credentialStore.name} (${ctx.credentialStore.detail})`
      : (ctx.credentialStore?.detail ?? "not available"),
    hint: ctx.credentialStore?.available
      ? ""
      : "Install an OS credential store, or set CODERAX_TOKEN for automation; no plaintext fallback exists.",
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

