import { readFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else if (entry.isFile() && /\.[cm]?js$/.test(entry.name)) files.push(full);
  }
  return files;
}

export async function runtimeSources(root) {
  const sources = [];
  for (const directory of ["src", "packages/workflow-sdk/src"]) {
    for (const file of await walk(join(root, directory))) {
      sources.push({ path: relative(root, file).split(sep).join("/"), text: await readFile(file, "utf8") });
    }
  }
  return sources;
}
