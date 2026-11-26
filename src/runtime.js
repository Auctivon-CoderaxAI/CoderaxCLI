import { CoderaxError } from "./errors.js";
import { createEngineClient } from "./engine/client.js";
import {
  configDir,
  configPath,
  describeConfig,
  loadConfig,
  loadToken,
  normalizeBaseUrl,
  resolveEngineUrl,
  statePath,
} from "./config.js";
import { createCredentialStore } from "./credentials.js";
import { createTokenProvider } from "./auth.js";
import { StateStore } from "./state.js";
import { createRedactor, environmentSecrets } from "./redact.js";
import { createStyle, supportsColor, termWidth } from "./ui/ansi.js";
import { successDocument } from "./errors.js";
import { VERSION } from "./version.js";

function isEnabled(value) {
  return value !== undefined && value !== null && value !== "";
}

export async function readAllStdin(input = process.stdin) {
  if (input.isTTY) return "";
  let text = "";
  for await (const chunk of input) text += chunk;
  return text;
}

/**
 * Everything a command needs, assembled once. Every collaborator is injectable
 * so the whole CLI can be exercised without a terminal, a network or a real
 * operating-system credential store.
 */
export async function createRuntime({ flags, options = {}, command = "coderax" } = {}) {
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? ((text) => process.stdout.write(text));
  const stderr = options.stderr ?? ((text) => process.stderr.write(text));
  const stdoutStream = options.stdoutStream ?? process.stdout;
  const stdin = options.stdin ?? process.stdin;
  const json = flags.has("json");
  const ndjson = flags.has("ndjson");
  const noColor = flags.has("no-color");
  const quiet = flags.has("quiet");

  const overrides = {};
  if (flags.has("base-url")) overrides.baseUrl = flags.get("base-url");
  if (flags.has("engine-url")) overrides.engineUrl = flags.get("engine-url");
  if (flags.has("timeout")) overrides.timeoutMs = flags.get("timeout");

  const config = await loadConfig({
    env,
    filePath: flags.get("config") ?? options.configPath,
    overrides,
    ...(options.configDeps ?? {}),
  });

  const directory = configDir(env);
  const store = options.credentialStore ?? createCredentialStore({
    directory,
    env,
    mode: config.credentialStore,
    platform: options.platform,
    runner: options.runner,
    ...(options.credentialDeps ?? {}),
  });

  const tokenProvider = options.tokenProvider ?? await createTokenProvider({
    config,
    env,
    store,
    flagToken: flags.get("token"),
    runner: options.runner,
    onWarning: (message) => stderr(`coderax: warning: ${message}\n`),
  });

  const initial = await loadToken({ config, env, store, flagToken: flags.get("token") });
  let currentToken = initial.token;
  const envSecrets = environmentSecrets(env);
  const secretValues = () => [tokenProvider.peek?.(), currentToken, ...envSecrets];
  const redact = (text) => createRedactor(secretValues()).redact(text ?? "");
  const redactValue = (value) => createRedactor(secretValues()).redactValue(value);

  const state = options.state ?? new StateStore({
    filePath: flags.get("state") ?? statePath(env),
    ...(options.stateDeps ?? {}),
  });

  const engineUrl = flags.has("engine-url")
    ? normalizeBaseUrl(flags.get("engine-url")).baseUrl
    : resolveEngineUrl(config, env);

  const style = createStyle({
    enabled: !noColor && supportsColor({ stream: stdoutStream, env }),
    stream: stdoutStream,
  });

  const write = (text = "") => {
    const value = String(text);
    stdout(value.endsWith("\n") ? value : `${value}\n`);
  };
  const raw = (text = "") => stdout(String(text));
  const err = (text = "") => stderr(String(text).endsWith("\n") ? String(text) : `${text}\n`);

  const emit = (resultCommand, data, human = null) => {
    if (json) {
      write(JSON.stringify(successDocument(resultCommand, data), null, 2));
      return;
    }
    if (ndjson) {
      write(JSON.stringify({ type: "result", command: resultCommand, data }));
      return;
    }
    if (human) human();
  };
  const emitEvent = (resultCommand, event) => {
    if (ndjson) write(JSON.stringify({ type: "event", command: resultCommand, event }));
  };

  let engine = null;
  const getEngine = async ({ negotiate = true, force = false } = {}) => {
    if (!engineUrl) {
      throw new CoderaxError(
        "ENGINE_URL_REQUIRED",
        "no WorkflowEngine URL is configured; run `coderax config set --engine-url <url>` or set CODERAX_ENGINE_URL",
      );
    }
    if (!engine || force) {
      engine = createEngineClient({
        baseUrl: engineUrl,
        tokenProvider,
        fetchImpl: options.fetchImpl ?? fetch,
        timeoutMs: config.timeoutMs,
        secrets: envSecrets,
        onWarning: (message) => err(`coderax: warning: ${redact(message)}`),
        now: options.now,
      });
    }
    if (negotiate) await engine.negotiate({ force });
    return engine;
  };

  const runtime = {
    version: VERSION,
    command,
    flags,
    args: [],
    env,
    config,
    configPath: config.configPath,
    configDir: directory,
    statePath: state.filePath,
    state,
    store,
    tokenProvider,
    engineUrl,
    baseUrl: config.baseUrl,
    json,
    ndjson,
    quiet,
    noColor,
    style,
    width: termWidth(stdoutStream, env, 100),
    isTTY: options.stdinIsTTY ?? Boolean(stdin.isTTY),
    signal: options.signal ?? null,
    stdoutIsTTY: Boolean(stdoutStream.isTTY),
    stdin,
    fetchImpl: options.fetchImpl ?? fetch,
    stdoutStream,
    stderrStream: options.stderrStream ?? process.stderr,
    write,
    raw,
    err,
    out: write,
    emit,
    emitEvent,
    getEngine,
    setToken(token) {
      currentToken = token;
      tokenProvider.setToken?.(token, "login");
    },
    getToken() {
      return tokenProvider.get();
    },
    redact,
    redactValue,
    describe() {
      return describeConfig(config, { tokenSource: tokenProvider.describe().source, env });
    },
    tokenInfo() {
      return tokenProvider.describe();
    },
    async readStdin() {
      return readAllStdin(stdin);
    },
    async refreshEngine() {
      engine = null;
      return getEngine({ negotiate: true, force: true });
    },
  };
  return runtime;
}

export function requireFlagValue(flags, name) {
  if (!flags.has(name)) return undefined;
  const value = flags.get(name);
  return isEnabled(value) ? value : undefined;
}
