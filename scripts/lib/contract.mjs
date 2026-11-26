import { readFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);

export function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(value ?? "").trim());
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function compareVersions(a, b) {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

export function collectOperations(document) {
  const operations = new Set();
  for (const [path, methods] of Object.entries(document?.paths ?? {})) {
    if (methods === null || typeof methods !== "object") continue;
    for (const method of Object.keys(methods)) {
      if (!HTTP_METHODS.has(method)) continue;
      operations.add(`${method.toUpperCase()} ${path}`);
    }
  }
  return operations;
}

async function walk(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await walk(full)));
    else if (entry.name.endsWith(".js")) found.push(full);
  }
  return found;
}

/** Every test file, keyed by repository-relative POSIX path. */
export async function readTestSources(root) {
  const sources = new Map();
  for (const file of await walk(join(root, "test"))) {
    const key = relative(root, file).split(sep).join("/");
    if (!key.endsWith(".test.js")) continue;
    sources.set(key, await readFile(file, "utf8"));
  }
  return sources;
}

/**
 * Fail closed on a stale shared client, an unsupported deployment API, a
 * missing operation, or a capability that claims support without a test.
 */
export function evaluateContract({
  contract,
  packageJson,
  versionModule,
  docsText,
  document,
  testSources,
}) {
  const violations = [];
  const add = (code, message) => violations.push({ code, message });

  const version = packageJson?.version;
  if (!version) add("CONTRACT_INVALID", "package.json has no version");

  const sharedVersion = contract?.sharedClient?.version;
  if (sharedVersion !== version) {
    add(
      "SDK_VERSION_STALE",
      `contract sharedClient.version is ${sharedVersion ?? "(missing)"} but package.json is ${version}; bump the contract with the shared client`,
    );
  }

  const moduleVersion = /export const VERSION = "([^"]+)"/.exec(versionModule ?? "")?.[1];
  if (moduleVersion !== version) {
    add(
      "SDK_VERSION_STALE",
      `src/version.js is ${moduleVersion ?? "(missing)"} but package.json is ${version}`,
    );
  }

  const docsVersion = /Version: CLI `([^`]+)`/.exec(docsText ?? "")?.[1];
  if (docsVersion !== version) {
    add(
      "DOC_VERSION_STALE",
      `docs/CONTRACT.md is ${docsVersion ?? "(missing)"} but package.json is ${version}`,
    );
  }

  const minimum = parseVersion(contract?.api?.minimum);
  if (!minimum) add("CONTRACT_INVALID", "contract API minimum is not a semantic version");
  const supportedMajors = contract?.api?.supportedMajors;
  if (!Array.isArray(supportedMajors) || supportedMajors.length === 0) {
    add("CONTRACT_INVALID", "contract API supportedMajors must be a non-empty array");
  }

  if (!document || typeof document !== "object") {
    add("DOCUMENT_MISSING", "no OpenAPI document was available to check required operations");
  } else {
    if (!String(document.openapi ?? "").startsWith("3.")) {
      add("API_DOCUMENT_UNSUPPORTED", `document declares OpenAPI ${document.openapi ?? "(none)"}, expected 3.x`);
    }
    const advertised = parseVersion(document.info?.version);
    if (!advertised) {
      add(
        "API_VERSION_MISSING",
        `document ${contract?.api?.versionField ?? "info.version"} is ${document.info?.version ?? "(none)"}; a version is required`,
      );
    } else {
      if (minimum && compareVersions(advertised, minimum) < 0) {
        add(
          "API_VERSION_STALE",
          `deployment API ${document.info.version} is older than the required ${contract.api.minimum}`,
        );
      }
      if (Array.isArray(supportedMajors) && !supportedMajors.includes(advertised.major)) {
        add(
          "API_VERSION_UNSUPPORTED",
          `deployment API major ${advertised.major} is not in supportedMajors ${JSON.stringify(supportedMajors)}`,
        );
      }
    }

    const operations = collectOperations(document);
    const required = contract?.requiredOperations ?? [];
    if (required.length === 0) add("CONTRACT_INVALID", "contract lists no required operations");
    for (const operation of required) {
      if (!operations.has(operation)) {
        add(
          "OPERATION_UNSUPPORTED",
          `required operation ${operation} is missing from the deployment; the CLI would fail at runtime`,
        );
      }
    }
    for (const operation of contract?.unsupportedOperations ?? []) {
      if (required.includes(operation)) {
        add("CONTRACT_INVALID", `${operation} is both required and explicitly unsupported`);
      }
      if (operations.has(operation) && required.includes(operation)) {
        add("CONTRACT_INVALID", `${operation} cannot be required while marked unsupported`);
      }
    }
  }

  const seen = new Set();
  const capabilities = contract?.capabilities ?? [];
  if (capabilities.length === 0) add("CONTRACT_INVALID", "contract lists no capabilities");
  for (const capability of capabilities) {
    const id = capability?.id;
    if (typeof id !== "string" || id === "") {
      add("CAPABILITY_INVALID", "every capability needs an id");
      continue;
    }
    if (seen.has(id)) add("CAPABILITY_DUPLICATE", `capability ${id} is declared twice`);
    seen.add(id);

    if (capability.status === "supported") {
      const files = capability.verifiedBy ?? [];
      if (files.length === 0) {
        add("CAPABILITY_UNVERIFIED", `capability ${id} is supported but names no verifying test`);
      }
      for (const file of files) {
        const source = testSources?.get(file);
        if (source === undefined) {
          add("CAPABILITY_UNVERIFIED", `capability ${id} cites a missing test file ${file}`);
        } else if (!source.includes(`[capability:${id}]`)) {
          add(
            "CAPABILITY_UNVERIFIED",
            `${file} has no test titled [capability:${id}], so the claim is unproven`,
          );
        }
      }
    } else if (capability.status === "unsupported") {
      if ((capability.verifiedBy ?? []).length > 0) {
        add(
          "CAPABILITY_CLAIM_MISMATCH",
          `capability ${id} is unsupported but cites verification; mark it supported only with a real test`,
        );
      }
      if (typeof capability.reason !== "string" || capability.reason.trim() === "") {
        add("CAPABILITY_CLAIM_MISMATCH", `capability ${id} is unsupported without a reason`);
      }
    } else {
      add("CAPABILITY_INVALID", `capability ${id} has unknown status ${capability.status}`);
    }
  }

  return {
    violations,
    checked: {
      version: version ?? null,
      apiVersion: document?.info?.version ?? null,
      requiredOperations: contract?.requiredOperations?.length ?? 0,
      supported: capabilities.filter((entry) => entry.status === "supported").length,
      unsupported: capabilities.filter((entry) => entry.status === "unsupported").length,
    },
  };
}

export async function loadContractInputs(root) {
  const readJson = async (path) => JSON.parse(await readFile(join(root, path), "utf8"));
  return {
    contract: await readJson("contract/workflow-engine.json"),
    packageJson: await readJson("package.json"),
    versionModule: await readFile(join(root, "src/version.js"), "utf8"),
    docsText: await readFile(join(root, "docs/CONTRACT.md"), "utf8"),
    testSources: await readTestSources(root),
  };
}
