import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";

const portable = (path) => path.split(sep).join("/");

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (["node_modules", ".git", "dist", "coverage"].includes(entry.name)) continue;
    const full = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

/** Resolve the npm `files` list into concrete repository-relative paths. */
export async function packageFiles(ROOT, pkg) {
  const selected = new Set(["package.json", "README.md"]);
  for (const entry of pkg.files ?? []) {
    if (entry.endsWith("/")) {
      for (const file of await walk(join(ROOT, entry))) selected.add(portable(relative(ROOT, file)));
    } else if (existsSync(join(ROOT, entry))) {
      selected.add(entry);
    }
  }
  return [...selected].sort((a, b) => a.localeCompare(b));
}

export function isExecutable(file) {
  return file === "src/cli.js" || file.endsWith(".sh");
}

const TEXT_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".json", ".md", ".sh", ".ps1", ".cmd", ".bat"]);
const CRLF_EXTENSIONS = new Set([".ps1", ".cmd", ".bat"]);

/**
 * Normalize line endings at pack time so an artifact is identical whether it
 * was built from a Linux or a Windows checkout: scripts use CRLF, everything
 * else uses LF.
 */
export function normalizeText(file, buffer) {
  const dot = file.lastIndexOf(".");
  const extension = dot === -1 ? "" : file.slice(dot);
  if (!TEXT_EXTENSIONS.has(extension)) return buffer;
  let text = buffer.toString("utf8").replace(/\r\n/g, "\n");
  if (CRLF_EXTENSIONS.has(extension)) text = text.replace(/\n/g, "\r\n");
  return Buffer.from(text, "utf8");
}
