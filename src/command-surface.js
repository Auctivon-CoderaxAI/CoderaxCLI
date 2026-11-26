import { chmod, lstat, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { CoderaxError, formatJson, redact, redactValue, request } from "./client.js";
import { discoverOpenApi } from "./discover.js";
import {
  bindOperation,
  buildCapabilityReport,
  candidateOperations,
  checkArgumentCount,
  pathParamNames,
  renderBindings,
  renderCapabilityTable,
} from "./capability-catalog.js";

function usage(message) {
  return new CoderaxError("USAGE", message);
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

function displayOperation(op) {
  return { method: op.method, path: op.path, operationId: op.operationId ?? null };
}

function requestContext(ctx, op) {
  return {
    baseUrl: ctx.settings.baseUrl,
    token: ctx.settings.token,
    timeoutMs: ctx.settings.timeoutMs,
    fetchImpl: ctx.fetchImpl,
  };
}

function substitutionPath(spec, op, args) {
  const names = pathParamNames(op.path);
  if (names.length !== args.length) {
    const wanted = names.length === 0 ? "no path arguments" : `${names.length} (<${names.join("> <")}>)`;
    throw usage(
      `\`${spec.path.join(" ")}\` binds to ${op.method} ${op.path}, which needs ${wanted}; received ${args.length}`,
    );
  }
  let path = op.path;
  for (let index = 0; index < names.length; index += 1) {
    const value = args[index];
    if (typeof value !== "string" || value.trim() === "") {
      throw usage(`\`${spec.path.join(" ")}\` requires a non-empty value for <${names[index]}>`);
    }
    // split/join avoids a template name being interpreted as a pattern.
    path = path.split(`{${names[index]}}`).join(encodeURIComponent(value));
  }
  return path;
}

function coerceFlag(name, raw, type) {
  const text = String(raw);
  switch (type) {
    case "boolean":
      if (["true", "1", "yes", "on"].includes(text.toLowerCase())) return true;
      if (["false", "0", "no", "off"].includes(text.toLowerCase())) return false;
      throw usage(`--${name} must be true or false`);
    case "integer": {
      const value = Number(text);
      if (!Number.isInteger(value)) throw usage(`--${name} must be an integer`);
      return value;
    }
    case "number": {
      const value = Number(text);
      if (!Number.isFinite(value)) throw usage(`--${name} must be a number`);
      return value;
    }
    case "array":
      if (text.trim().startsWith("[")) {
        try {
          const parsed = JSON.parse(text);
          if (!Array.isArray(parsed)) throw new Error("not an array");
          return parsed;
        } catch {
          throw usage(`--${name} must be a JSON array or a comma-separated list`);
        }
      }
      return text.split(",").map((entry) => entry.trim()).filter(Boolean);
    case "object":
      try {
        const parsed = JSON.parse(text);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
        return parsed;
      } catch {
        throw usage(`--${name} must be a JSON object`);
      }
    case "string":
    default:
      return text;
  }
}

function validateJsonValue(field, value, schema) {
  if (!schema || typeof schema !== "object") return;
  if (value === null) {
    if (schema.nullable === true || (Array.isArray(schema.type) && schema.type.includes("null"))) return;
    throw usage(`field ${field} must not be null`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => String(option) === String(value))) {
    throw usage(`field ${field} must be one of: ${schema.enum.join(", ")}`);
  }
  const type = Array.isArray(schema.type) ? schema.type.filter((entry) => entry !== "null")[0] : schema.type;
  switch (type) {
    case "string":
      if (typeof value !== "string") throw usage(`field ${field} must be a string`);
      break;
    case "boolean":
      if (typeof value !== "boolean") throw usage(`field ${field} must be a boolean`);
      break;
    case "integer":
      if (!Number.isInteger(value)) throw usage(`field ${field} must be an integer`);
      break;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) throw usage(`field ${field} must be a number`);
      break;
    case "array":
      if (!Array.isArray(value)) throw usage(`field ${field} must be an array`);
      break;
    case "object":
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw usage(`field ${field} must be an object`);
      }
      break;
    default:
      break;
  }
}

function validateBody(spec, op, body) {
  const schema = op.requestBody?.schema;
  const requiredFields = [...(spec.requiredBody ?? [])];
  if (schema && Array.isArray(schema.required)) requiredFields.push(...schema.required);
  for (const name of new Set(requiredFields)) {
    if (body === undefined || !Object.prototype.hasOwnProperty.call(body, name)) {
      throw usage(`\`${spec.path.join(" ")}\` requires --${name} (or a --data object containing "${name}")`);
    }
  }

  if (!schema || typeof schema !== "object") return;
  const properties = schema.properties && typeof schema.properties === "object" ? schema.properties : {};
  for (const [name, value] of Object.entries(body ?? {})) {
    if (properties[name]) {
      validateJsonValue(name, value, properties[name]);
    } else if (schema.additionalProperties === false) {
      throw usage(
        `the deployment's ${op.method} ${op.path} request body does not accept "${name}". Declared fields: ${Object.keys(properties).join(", ") || "(none)"}`,
      );
    }
  }
}

function buildBody(spec, op, flags) {
  const dataRaw = flags.get("data");
  const fromFlags = {};
  for (const [name, type] of Object.entries(spec.body ?? {})) {
    if (flags.has(name)) fromFlags[name] = coerceFlag(name, flags.get(name), type);
  }

  let body;
  if (dataRaw !== undefined) {
    if (Object.keys(fromFlags).length > 0) {
      throw usage("pass request fields with --data or with field flags, not both");
    }
    try {
      body = JSON.parse(dataRaw);
    } catch {
      throw usage("--data must be valid JSON");
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      throw usage("--data must be a JSON object");
    }
  } else if (Object.keys(fromFlags).length > 0) {
    body = fromFlags;
  }

  if (spec.requireAnyBody && body === undefined) {
    throw usage(`\`${spec.path.join(" ")}\` requires at least one field flag${spec.confirm ? "" : ""}`);
  }

  validateBody(spec, op, body);

  if (body === undefined) return undefined;
  if (Object.keys(body).length === 0 && !spec.body && dataRaw === undefined) return undefined;
  return body;
}

function validateQueryValue(name, value, schema) {
  if (!schema || typeof schema !== "object") return;
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => String(option) === String(value))) {
    throw usage(`--${name} must be one of: ${schema.enum.join(", ")}`);
  }
  if (type === "integer" && !/^-?\d+$/.test(String(value))) throw usage(`--${name} must be an integer`);
  if (type === "number" && !Number.isFinite(Number(value))) throw usage(`--${name} must be a number`);
  if (type === "boolean" && !["true", "false", "1", "0"].includes(String(value))) {
    throw usage(`--${name} must be true or false`);
  }
}

function buildQuery(spec, op, flags, extraParams = []) {
  const declared = new Map(
    (op.parameters ?? [])
      .filter((parameter) => parameter.in === "query")
      .map((parameter) => [parameter.name, parameter]),
  );
  const provided = [];
  for (const name of spec.query ?? []) {
    if (flags.has(name)) provided.push([name, flags.get(name)]);
  }
  for (const [name, value] of extraParams) provided.push([name, value]);
  if (provided.length === 0) return "";

  // The document is authoritative when it describes query parameters; an
  // undocumented parameter is a usage error rather than a silent typo.
  if (declared.size > 0) {
    for (const [name] of provided) {
      if (!declared.has(name)) {
        throw usage(
          `the deployment's ${op.method} ${op.path} does not accept the query parameter "${name}". Declared: ${[...declared.keys()].join(", ")}`,
        );
      }
    }
  }

  const search = new URLSearchParams();
  for (const [name, value] of provided) {
    validateQueryValue(name, value, declared.get(name)?.schema);
    search.append(name, String(value));
  }
  return search.toString();
}

function listRows(data) {
  if (Array.isArray(data)) return data;
  if (data === null || typeof data !== "object") return null;
  for (const key of ["data", "items", "results", "records", "entries"]) {
    if (Array.isArray(data[key])) return data[key];
  }
  const arrays = Object.entries(data).filter(([, value]) => Array.isArray(value));
  if (arrays.length === 1) return arrays[0][1];
  return null;
}

function primitive(value) {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function renderTable(rows, columns) {
  const widths = columns.map((column) =>
    Math.max(String(column).length, ...rows.map((row) => String(formatCell(row?.[column])).length)),
  );
  const line = (cells) =>
    cells.map((cell, index) => String(cell).padEnd(widths[index])).join("  ").trimEnd();
  return [
    line(columns.map((column) => String(column).toUpperCase())),
    line(widths.map((width) => "\u2500".repeat(width))),
    ...rows.map((row) => line(columns.map((column) => formatCell(row?.[column])))),
  ];
}

function formatCell(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

const PREFERRED_COLUMNS = ["id", "name", "title", "status", "type", "schedule", "cron", "nextRunAt", "updatedAt", "createdAt"];

function pickColumns(rows) {
  const first = rows[0];
  if (first === null || typeof first !== "object" || Array.isArray(first)) return null;
  const columns = [];
  for (const key of PREFERRED_COLUMNS) {
    if (primitive(first[key]) && columns.length < 6) columns.push(key);
  }
  for (const key of Object.keys(first)) {
    if (columns.length >= 6) break;
    if (!columns.includes(key) && primitive(first[key])) columns.push(key);
  }
  return columns.length > 0 ? columns : null;
}

function renderList(ctx, spec, op, response) {
  const rows = listRows(response.json);
  const displayPath = redact(op.path, ctx.settings.token);
  const meta = rows ? { count: rows.length } : undefined;
  if (response.json && typeof response.json === "object" && !Array.isArray(response.json)) {
    if (response.json.nextCursor !== undefined) meta && (meta.nextCursor = response.json.nextCursor);
    if (response.json.total !== undefined) meta && (meta.total = response.json.total);
  }

  if (ctx.json) {
    ctx.out(formatJson({
      command: spec.path.join(" "),
      capability: spec.capability,
      operation: displayOperation({ ...op, path: displayPath }),
      status: response.status,
      data: response.json ?? (response.text === "" ? null : response.text),
      ...(meta ? { meta } : {}),
    }));
    return;
  }

  ctx.out(`${op.method} ${displayPath} -> ${response.status}`);
  if (!rows) {
    ctx.out(response.json !== null ? formatJson(response.json) : response.text);
    return;
  }
  if (rows.length === 0) {
    ctx.out("No items.");
    return;
  }
  const columns = pickColumns(rows);
  if (columns) {
    ctx.out(renderTable(rows, columns).join("\n"));
  } else {
    for (const row of rows) ctx.out(typeof row === "string" ? row : JSON.stringify(row));
  }
  const suffix = [meta?.total !== undefined ? `of ${meta.total}` : null, meta?.nextCursor ? `next cursor: ${meta.nextCursor}` : null]
    .filter(Boolean)
    .join("; ");
  ctx.out(`${rows.length} item${rows.length === 1 ? "" : "s"}${suffix ? ` (${suffix})` : ""}`);
}

function renderResource(ctx, spec, op, response, extraMeta) {
  const displayPath = redact(op.path, ctx.settings.token);
  const data = response.json ?? (response.text === "" ? null : response.text);

  if (ctx.json) {
    ctx.out(formatJson({
      command: spec.path.join(" "),
      capability: spec.capability,
      operation: displayOperation({ ...op, path: displayPath }),
      status: response.status,
      data,
      ...(extraMeta ? { meta: extraMeta } : {}),
    }));
    return;
  }

  ctx.out(`${op.method} ${displayPath} -> ${response.status}`);
  if (data !== null && data !== "") {
    ctx.out(typeof data === "string" ? data : formatJson(data));
  }
}

async function writeDownload(target, buffer, force) {
  const directory = dirname(target);
  let directoryStat = null;
  try {
    directoryStat = await stat(directory);
  } catch {
    directoryStat = null;
  }
  if (!directoryStat || !directoryStat.isDirectory()) {
    throw new CoderaxError("FILE_INVALID", `output directory does not exist: ${directory}`);
  }

  let existing = null;
  try {
    existing = await lstat(target);
  } catch {
    existing = null;
  }
  if (existing?.isDirectory()) {
    throw new CoderaxError("FILE_INVALID", `refusing to write artifact over a directory: ${target}`);
  }
  if (existing && !force) {
    throw new CoderaxError("FILE_INVALID", `refusing to overwrite ${target}; pass --force to replace it`);
  }

  const temp = join(directory, `.${basename(target)}.${process.pid}.${Date.now().toString(36)}.part`);
  try {
    await writeFile(temp, buffer, { mode: 0o600, flag: "wx" });
    try {
      await chmod(temp, 0o600);
    } catch (error) {
      if (process.platform !== "win32") throw error;
    }
    try {
      await rename(temp, target);
    } catch (error) {
      if (!(existing && force && (error.code === "EEXIST" || error.code === "EPERM"))) throw error;
      await unlink(target);
      await rename(temp, target);
    }
  } catch (error) {
    try {
      await unlink(temp);
    } catch {
      // Nothing to clean up.
    }
    if (error instanceof CoderaxError) throw error;
    throw new CoderaxError("ARTIFACT_WRITE_FAILED", `could not write ${target}: ${error.code ?? error.message}`);
  }
}

async function runUpload(spec, op, args, ctx) {
  const file = args[0];
  const info = await lstat(file).catch(() => null);
  if (!info) throw new CoderaxError("FILE_INVALID", `file not found: ${file}`);
  if (info.isSymbolicLink()) {
    throw new CoderaxError("FILE_INVALID", `refusing to upload a symbolic link: ${file}`);
  }
  if (!info.isFile()) throw new CoderaxError("FILE_INVALID", `not a regular file: ${file}`);

  const types = op.requestBody?.contentTypes ?? [];
  if (types.length > 0 && !types.some((type) => type.startsWith("multipart/form-data"))) {
    throw new CoderaxError(
      "UPLOAD_UNSUPPORTED",
      `the deployment's ${op.method} ${op.path} accepts ${types.join(", ")}, not multipart/form-data; uploads are unavailable on this deployment`,
    );
  }

  const bytes = await readFile(file);
  const form = new FormData();
  form.append("file", new Blob([bytes]), basename(file));

  const path = substitutionPath(spec, op, args.slice(1));
  const query = buildQuery(spec, op, ctx.flags, ctx.params);
  const response = await request({
    ...requestContext(ctx, op),
    path: query ? `${path}?${query}` : path,
    method: op.method,
    body: form,
  });

  const meta = { file: { path: file, bytes: bytes.length } };
  renderResource(ctx, spec, op, response, meta);
  return 0;
}

async function runDownload(spec, op, args, ctx) {
  const output = ctx.flags.get("output");
  if (!output) {
    throw usage(`\`${spec.path.join(" ")}\` requires --output <path>`);
  }
  const path = substitutionPath(spec, op, args);
  const query = buildQuery(spec, op, ctx.flags, ctx.params);
  const response = await request({
    ...requestContext(ctx, op),
    path: query ? `${path}?${query}` : path,
    method: op.method,
    responseType: "buffer",
  });

  const target = isAbsolute(output) ? output : resolve(process.cwd(), output);
  await writeDownload(target, response.buffer, ctx.flags.has("force"));

  const meta = { file: { path: target, bytes: response.buffer.length, mode: "0600" } };
  if (ctx.json) {
    ctx.out(formatJson({
      command: spec.path.join(" "),
      capability: spec.capability,
      operation: displayOperation({ ...op, path: redact(op.path, ctx.settings.token) }),
      status: response.status,
      data: null,
      meta,
    }));
  } else {
    ctx.out(`Saved ${target} (${response.buffer.length} bytes, mode 0600)`);
  }
  return 0;
}

async function executeHttp(spec, op, args, ctx) {
  const path = substitutionPath(spec, op, args);
  const query = buildQuery(spec, op, ctx.flags, ctx.params);
  const body = buildBody(spec, op, ctx.flags);
  const response = await request({
    ...requestContext(ctx, op),
    path: query ? `${path}?${query}` : path,
    method: op.method,
    body,
    responseType: "json",
  });

  if (spec.list) renderList(ctx, spec, op, response);
  else renderResource(ctx, spec, op, response);
  return 0;
}

/** Run one catalog command through a discovered, authoritative operation. */
export async function runSurfaceCommand(spec, args, ctx) {
  if (!spec) throw usage("no command matched");
  if (spec.mode === "capabilities") return capabilitiesCommand(ctx);

  // Usage and confirmation failures must not depend on configuration or network.
  checkArgumentCount(spec, args);
  if (spec.confirm && !ctx.flags.has("yes")) {
    throw new CoderaxError(
      "CONFIRMATION_REQUIRED",
      `\`${spec.path.join(" ")}\` changes server state; re-run with --yes`,
    );
  }

  requireBase(ctx);
  requireAuth(ctx);

  try {
    if (spec.fixedPath) {
      const op = {
        method: Array.isArray(spec.method) ? spec.method[0] : spec.method,
        path: spec.fixedPath,
        operationId: null,
        parameters: [],
        requestBody: null,
      };
      return await executeHttp(spec, op, args, ctx);
    }

    const discovery = await discoverOpenApi({
      baseUrl: ctx.settings.baseUrl,
      token: ctx.settings.token,
      timeoutMs: ctx.settings.timeoutMs,
      fetchImpl: ctx.fetchImpl,
    });
    const op = bindOperation(spec, discovery.operations, ctx.flags.get("operation"));

    if (spec.mode === "upload") return await runUpload(spec, op, args, ctx);
    if (spec.mode === "download") return await runDownload(spec, op, args, ctx);
    return await executeHttp(spec, op, args, ctx);
  } catch (error) {
    if (error && typeof error === "object" && !error.command) error.command = spec.path.join(" ");
    throw error;
  }
}

/** `coderax capabilities` — bind the whole catalog to the deployment. */
export async function capabilitiesCommand(ctx) {
  requireBase(ctx);

  const discovery = await discoverOpenApi({
    baseUrl: ctx.settings.baseUrl,
    token: ctx.settings.token,
    timeoutMs: ctx.settings.timeoutMs,
    fetchImpl: ctx.fetchImpl,
  });

  let serverCapabilities = null;
  const capabilitySpec = {
    method: "GET",
    operationIds: ["getCapabilities", "listCapabilities"],
    paths: [/\/capabilities\/?$/i],
  };
  const capOp = candidateOperations(capabilitySpec, discovery.operations)[0] ?? null;
  if (capOp) {
    const response = await request({
      baseUrl: ctx.settings.baseUrl,
      token: ctx.settings.token,
      timeoutMs: ctx.settings.timeoutMs,
      fetchImpl: ctx.fetchImpl,
      path: capOp.path,
    });
    serverCapabilities = response.json;
  }

  const report = redactValue(
    buildCapabilityReport(discovery.operations, serverCapabilities),
    ctx.settings.token,
  );
  const payload = {
    baseUrl: ctx.settings.baseUrl,
    contract: discovery.sourcePath,
    operationCount: discovery.operations.length,
    ...report,
  };

  if (ctx.json) {
    ctx.out(formatJson(payload));
    return 0;
  }

  const ready = report.capabilities.filter((group) => group.status === "ready").length;
  const partial = report.capabilities.filter((group) => group.status === "partial").length;
  const unavailable = report.capabilities.filter((group) => group.status === "unavailable").length;

  ctx.out(`contract: ${discovery.sourcePath} (${discovery.operations.length} operations)`);
  ctx.out(renderCapabilityTable(report).join("\n"));
  ctx.out("");
  ctx.out("Bindings:");
  for (const line of renderBindings(report)) ctx.out(line);
  ctx.out("");
  ctx.out(`${ready} ready, ${partial} partial, ${unavailable} unavailable.`);
  ctx.out("Unavailable commands are not stubbed: the deployment publishes no matching operation, so nothing is sent.");
  if (serverCapabilities) ctx.out("The deployment also publishes its own capability document (see --json).");
  return 0;
}
