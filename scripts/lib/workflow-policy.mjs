// Read only the mapping levels used by policy. Reject unsupported keys,
// inline objects, aliases and ambiguous indentation at these levels.
function mapping(lines) {
  const result = new Map();
  if (!lines.length) return result;
  const indent = lines[0].search(/\S/);
  let entry;
  for (const line of lines) {
    const depth = line.search(/\S/);
    if (depth > indent && entry) {
      entry.children.push(line);
      continue;
    }
    const match = /^([\w-]+):(?:[ ]+(.*))?$/.exec(line.trim());
    if (depth !== indent || !match || result.has(match[1])) throw new Error("unsupported YAML mapping");
    entry = { value: (match[2] ?? "").replace(/(?:^|\s+)#.*$/, "").trim(), children: [] };
    result.set(match[1], entry);
  }
  return result;
}

function block(entry) {
  if (!entry || entry.value) throw new Error("expected a block mapping");
  return mapping(entry.children);
}

const ALLOWED_RUNNERS = new Set(["ubuntu-latest", "windows-latest", "macos-latest"]);
const EXISTING_WRITES = {
  "codeql.yml": { analyze: ["security-events"] },
  "release.yml": { release: ["contents", "id-token"], npm: ["id-token"] },
};

function permissions(entry, allowedWrites) {
  if (!entry) throw new Error("missing explicit permissions");
  if (!entry.children.length && (entry.value === "{}" || entry.value === "read-all")) return;
  const grants = block(entry);
  if (!grants.size) throw new Error("empty permissions block");
  for (const [name, grant] of grants) {
    if (grant.children.length || !(
      ["read", "none"].includes(grant.value) || (grant.value === "write" && allowedWrites.includes(name))
    )) throw new Error(`unexpected permission ${name}: ${grant.value}`);
  }
}

function scalar(value) {
  return value.trim().replace(/^(?:"([^"]*)"|'([^']*)')$/, (_, double, single) => double ?? single);
}

function matrixRunners(job) {
  const matrix = block(block(job.get("strategy")).get("matrix"));
  if (matrix.size !== 1 || !matrix.has("os")) throw new Error("unsupported runner matrix; use only the os axis");
  const { value, children } = matrix.get("os");
  if (!value && children.length && children.every((line) => /^\s*-\s+\S/.test(line))) {
    const indent = children[0].search(/\S/);
    if (children.every((line) => line.search(/\S/) === indent)) {
      return children.map((line) => scalar(line.trim().slice(1).replace(/\s+#.*$/, "")));
    }
  }
  if (!children.length && /^\[.+\]$/.test(value)) return value.slice(1, -1).split(",").map(scalar);

  // The verification job uses two literal arrays to keep branch and PR
  // checks on Linux, with all three hosts on main and release candidates.
  const conditional = /^\$\{\{ fromJSON\(\((?:github\.ref == 'refs\/heads\/main' \|\| startsWith\(github\.ref, 'refs\/heads\/rc\/'\))\) && '([^']+)' \|\| '([^']+)'\) \}\}$/.exec(value);
  if (!children.length && conditional) {
    const choices = conditional.slice(1).map((choice) => JSON.parse(choice));
    if (choices.every((choice) => Array.isArray(choice) && choice.length)) return choices.flat();
  }
  throw new Error("unsupported os runner values");
}

export function validateWorkflow(file, text) {
  try {
    const top = mapping(text.split(/\r?\n/).filter((line) => line.trim() && !line.trimStart().startsWith("#")));
    permissions(top.get("permissions"), []);
    const triggers = top.get("on");
    const events = triggers && !triggers.value ? block(triggers) : null;
    if (events?.has("pull_request_target") || triggers?.value?.includes("pull_request_target")) {
      throw new Error("pull_request_target is not allowed");
    }
    const jobs = block(top.get("jobs"));
    if (!jobs.size) throw new Error("no jobs found");
    for (const [id, entry] of jobs) {
      const job = block(entry);
      const allowedWrites = Object.hasOwn(EXISTING_WRITES, file) && Object.hasOwn(EXISTING_WRITES[file], id)
        ? EXISTING_WRITES[file][id] : [];
      if (allowedWrites.length && file === "release.yml" &&
          (!events || [...events.keys()].some((name) => !["push", "workflow_dispatch"].includes(name)) ||
           (events.has("push") && block(events.get("push")).get("tags")?.value !== '["v*.*.*"]'))) {
        throw new Error("release writes require tag pushes or manual dispatch");
      }
      if (job.has("permissions")) permissions(job.get("permissions"), allowedWrites);
      if (job.has("services")) throw new Error("service containers are not allowed");
      const runner = job.get("runs-on");
      if (!runner || runner.children.length) throw new Error(`unsupported runs-on for ${id}`);
      const label = scalar(runner.value);
      const values = label === "${{ matrix.os }}" ? matrixRunners(job) : [label];
      for (const value of values) {
        if (!ALLOWED_RUNNERS.has(value)) throw new Error(`runner "${value}" is not an allowed hosted label`);
      }
    }
    return [];
  } catch (error) {
    return [error.message];
  }
}
