/**
 * Fail-closed gates for the two things a thin client must never drift on:
 * the contract it was built against, and the promise that it runs nothing
 * locally.
 *
 * Both gates are pure functions so the assertions that "a violation fails the
 * build" can be tested without editing the repository. The source deliberately
 * avoids regular-expression escapes: quoted values are split, not matched.
 */

const LIFECYCLE = ["preinstall", "install", "postinstall", "prepare"];

/** Builtins a cloud client may use. Anything else needs a review, not a pass. */
export const ALLOWED_BUILTINS = new Set([
  "node:child_process",
  "node:fs",
  "node:fs/promises",
  "node:os",
  "node:path",
  "node:readline/promises",
  "node:readline",
  "node:util",
  "node:url",
  "node:crypto",
]);

/** Files allowed to spawn a process: credential-store helpers and an opt-in
 *  user notification command. Neither starts a service or runs inference. */
export const SPAWN_ALLOWED = new Set(["src/credentials.js", "src/secure-store.js", "src/workflow-commands.js"]);

/** Lowercase fragments that mean the client is doing local work. */
export const FORBIDDEN_SURFACE = [
  "node:http",
  "node:net",
  "node:dgram",
  "node:cluster",
  "node:worker_threads",
  "node:sqlite",
  "createserver",
  ".listen(",
  "docker",
  "podman",
  "ollama",
  "llama",
  "onnxruntime",
  "tensorflow",
  "transformers",
  "sqlite",
];

/** Discovery and health probes the CLI may try outside the published routes. */
export const PROBE_ALLOWLIST = new Set([
  "/api/openapi.json",
  "/.well-known/openapi.json",
  "/api/health",
]);

const QUOTES = ['"', "'", "`"];

/** A named parameter segment and a wildcard segment compare equal. */
export function normalizeRoute(path) {
  let normalized = String(path)
    .split("/")
    .map((segment) => (segment.startsWith(":") ? "*" : segment))
    .join("/");
  while (normalized.length > 1 && normalized.endsWith("/")) normalized = normalized.slice(0, -1);
  return normalized;
}

export function routeTemplates(route) {
  const templates = [];
  // Route maps mix strings, parameter functions and lists of candidates, and
  // invariant paths are usually arrays.
  const visit = (value) => {
    if (typeof value === "string") templates.push(value);
    else if (typeof value === "function") templates.push(value("*"));
    else if (Array.isArray(value)) for (const entry of value) visit(entry);
  };
  for (const value of Object.values(route ?? {})) visit(value);
  return templates.map(normalizeRoute);
}

/** Every path-looking quoted value in a source file. */
export function routeLiterals(source) {
  const literals = new Set();
  for (const line of String(source).split("\n")) {
    for (const value of quotedValues(line)) {
      // Prose that starts with a path is documentation, not a request.
      if (value.includes(" ")) continue;
      const head = value.split("$")[0];
      if (head.startsWith("/api/") || head.startsWith("/.well-known/")) literals.add(head);
    }
  }
  return literals;
}

/** Pull every quoted value out of one line, honouring the opening quote. */
function quotedValues(line) {
  const values = [];
  for (let index = 0; index < line.length; index += 1) {
    const quote = line[index];
    if (!QUOTES.includes(quote)) continue;
    const end = line.indexOf(quote, index + 1);
    if (end === -1) break;
    values.push(line.slice(index + 1, end));
    index = end;
  }
  return values;
}

/** Module specifiers from import, export-from, require and dynamic import. */
export function importSpecifiers(source) {
  const specifiers = new Set();
  for (const raw of String(source).split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    if (line.startsWith("import ")) {
      const quoted = quotedValues(line);
      const from = line.indexOf(" from ");
      if (from !== -1) {
        const specifier = quotedValues(line.slice(from)).at(0);
        if (specifier !== undefined) specifiers.add(specifier);
      } else if (line.includes("(") && quoted.length > 0) {
        specifiers.add(quoted[0]);
      } else if (quoted.length > 0) {
        specifiers.add(quoted[0]);
      }
    } else if (line.startsWith("export ") && line.includes(" from ")) {
      const specifier = quotedValues(line.slice(line.indexOf(" from "))).at(0);
      if (specifier !== undefined) specifiers.add(specifier);
    } else if (line.includes("require(") || line.includes("import(")) {
      const quoted = quotedValues(line);
      if (quoted.length > 0) specifiers.add(quoted[0]);
    }
  }
  return specifiers;
}

/**
 * Contract gate: a stale API version, a stale documented version, or a request
 * to an operation the deployment does not publish all fail the build.
 */
export function contractViolations({ packageJson, apiVersion, apiMajor, route, sources, docs = {} }) {
  const violations = [];
  const add = (code, message) => violations.push({ code, message });

  if (typeof apiVersion !== "string" || apiVersion.trim() === "") {
    add("SDK_VERSION_STALE", "the shared SDK exports no API_VERSION");
  }
  if (Number.parseInt(String(apiVersion), 10) !== apiMajor) {
    add(
      "SDK_VERSION_STALE",
      `API_VERSION ${apiVersion} and API_MAJOR ${apiMajor} disagree; the shared SDK is stale`,
    );
  }

  const tick = String.fromCharCode(96);
  const cliVersion = packageJson?.version;
  const contractDoc = docs.contract ?? "";
  if (!contractDoc.includes("Version: CLI " + tick + cliVersion + tick)) {
    add("DOC_VERSION_STALE", `docs/CONTRACT.md does not declare CLI ${cliVersion}`);
  }
  if (!contractDoc.includes("API major " + tick + apiMajor + tick)) {
    add("DOC_VERSION_STALE", `docs/CONTRACT.md does not declare API major ${apiMajor}`);
  }
  const compatibilityDoc = docs.compatibility ?? "";
  if (!compatibilityDoc.includes('API_VERSION = "' + apiVersion + '"')) {
    add("DOC_VERSION_STALE", `docs/COMPATIBILITY.md does not pin API_VERSION = "${apiVersion}"`);
  }

  const templates = routeTemplates(route);
  if (templates.length === 0) add("CONTRACT_INVALID", "the shared SDK publishes no routes");
  for (const template of templates) {
    if (!template.startsWith("/api/") && !template.startsWith("/.well-known/")) {
      add("CONTRACT_INVALID", `route ${template} is not under /api/ or /.well-known/`);
    }
  }

  for (const source of sources ?? []) {
    for (const literal of routeLiterals(source.text)) {
      const normalized = normalizeRoute(literal);
      if (PROBE_ALLOWLIST.has(normalized) || templates.includes(normalized)) continue;
      // A literal that is only a prefix is the static head of a constructed
      // path; it is covered when it prefixes a published route.
      if (literal.endsWith("/") && templates.some((template) => template.startsWith(normalized))) continue;
      add("UNSUPPORTED_OPERATION", `${source.path} calls ${literal}, which the shared SDK does not publish`);
    }
  }

  return violations;
}

/**
 * Isolation gate: installing the CLI must not add inference, a database, a
 * daemon, Docker or Ollama. It is structural, so a new dependency or a new
 * server import fails here rather than in a user's install.
 */
export function isolationViolations({ packageJson, lockfile, sources }) {
  const violations = [];
  const add = (code, message) => violations.push({ code, message });

  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    for (const name of Object.keys(packageJson?.[field] ?? {})) {
      add("RUNTIME_DEPENDENCY", `${field} declares ${name}; the CLI must stay dependency-free`);
    }
  }
  for (const script of LIFECYCLE) {
    if (packageJson?.scripts?.[script]) {
      add("INSTALL_SCRIPT", `package.json defines a "${script}" script; installing must not run code`);
    }
  }
  const bins = Object.keys(packageJson?.bin ?? {});
  if (bins.length !== 1 || bins[0] !== "coderax") {
    add("UNEXPECTED_BIN", `package.json must expose exactly the coderax bin, found ${JSON.stringify(bins)}`);
  }

  if (lockfile) {
    if (lockfile.lockfileVersion !== 3) {
      add("LOCKFILE_STALE", `lockfileVersion is ${lockfile.lockfileVersion}; use 3`);
    }
    for (const [path, entry] of Object.entries(lockfile.packages ?? {})) {
      if (path === "") continue;
      if (entry?.hasInstallScript) add("INSTALL_SCRIPT", `${path} runs an install script`);
    }
  }

  for (const source of sources ?? []) {
    for (const specifier of importSpecifiers(source.text)) {
      const allowed =
        specifier.startsWith("./") || specifier.startsWith("../") || ALLOWED_BUILTINS.has(specifier);
      if (!allowed) {
        add(
          "LOCAL_EXECUTION_SURFACE",
          `${source.path} imports ${specifier}; only relative modules and reviewed builtins are allowed`,
        );
      }
    }
    // The attachment filter denies reads from this credential directory.
    const text = source.path === "src/terminal/attachments.js"
      ? source.text.replace(/^  "\.docker",$/m, "")
      : source.text;
    const lower = String(text).toLowerCase();
    for (const fragment of FORBIDDEN_SURFACE) {
      if (lower.includes(fragment)) {
        add(
          "LOCAL_EXECUTION_SURFACE",
          `${source.path} references ${JSON.stringify(fragment)}; execution stays cloud-hosted`,
        );
      }
    }
    if ((source.text.includes("spawn(") || source.text.includes("execFile")) && !SPAWN_ALLOWED.has(source.path)) {
      add("LOCAL_EXECUTION_SURFACE", `${source.path} starts a process; only ${[...SPAWN_ALLOWED].join(", ")} may`);
    }
  }

  return violations;
}
