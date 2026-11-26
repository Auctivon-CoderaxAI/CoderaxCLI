import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Workflow policy: free GitHub-hosted runners only, read-only token, and every
 * action pinned to a commit. A new workflow cannot quietly broaden either.
 */
const ALLOWED_RUNNERS = new Set(["ubuntu-latest", "windows-latest", "macos-latest"]);
const PINNED_ACTION = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}$/;

const root = process.cwd();
const directory = join(root, ".github/workflows");
const violations = [];

let files = [];
try {
  files = (await readdir(directory)).filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"));
} catch {
  violations.push("no .github/workflows directory");
}

if (files.length === 0) violations.push("no workflow files found");

for (const file of files) {
  const text = await readFile(join(directory, file), "utf8");
  const add = (message) => violations.push(`${file}: ${message}`);

  if (/pull_request_target\s*:/.test(text)) add("pull_request_target is not allowed");
  if (!/^permissions:\s*$/m.test(text)) add("no explicit permissions block");
  if (!/^\s+contents:\s*read\s*$/m.test(text)) add("contents permission is not read-only");
  if (/self-hosted/.test(text)) add("self-hosted runners are not free GitHub-hosted runners");
  if (/^\s+services:\s*$/m.test(text)) add("service containers are not allowed");
  if (/secrets\./.test(text)) add("workflows must not consume repository secrets");

  for (const match of text.matchAll(/^\s*-?\s*uses:\s*(\S+)(.*)$/gm)) {
    const [, action, rest] = match;
    if (!PINNED_ACTION.test(action)) add(`action ${action} is not pinned to a full commit SHA`);
    if (!/#\s*v\d/.test(rest)) add(`action ${action} has no version comment`);
  }

  for (const match of text.matchAll(/^\s*runs-on:\s*(.+)$/gm)) {
    const runner = match[1].trim().replace(/^["']|["']$/g, "");
    if (runner === "${{ matrix.os }}") continue;
    if (!ALLOWED_RUNNERS.has(runner)) add(`runner "${runner}" is not an allowed hosted label`);
  }

  for (const match of text.matchAll(/^\s+os:\s*\[([^\]]+)\]$/gm)) {
    for (const entry of match[1].split(",").map((value) => value.trim().replace(/^["']|["']$/g, ""))) {
      if (!ALLOWED_RUNNERS.has(entry)) add(`matrix runner "${entry}" is not an allowed hosted label`);
    }
  }

  for (const match of text.matchAll(/^\s*docker:\s*/gm)) add(`docker usage at ${match.index}`);
}

if (violations.length > 0) {
  for (const violation of violations) console.error(`workflows: ${violation}`);
  console.error(`workflows: FAILED with ${violations.length} violation(s)`);
  process.exit(1);
}
console.log(`workflows: OK - ${files.length} workflow(s) on free hosted runners with pinned actions`);
