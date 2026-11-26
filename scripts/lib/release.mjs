import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createDeterministicTarball } from "./tar.mjs";

/** Files a release needs to run; tests, workflows and local config stay out. */
const FIXED_FILES = ["package.json", "README.md", "SECURITY.md", "docs/CONTRACT.md"];

export function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export async function collectEntries(root) {
  const entries = [];
  const add = async (file, mode) => {
    entries.push({
      path: `package/${file}`,
      content: await readFile(join(root, file)),
      mode,
    });
  };

  for (const file of FIXED_FILES) await add(file, 0o644);
  const sourceFiles = (await readdir(join(root, "src"))).filter((name) => name.endsWith(".js")).sort();
  for (const name of sourceFiles) await add(`src/${name}`, name === "cli.js" ? 0o755 : 0o644);

  return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export async function buildArtifact(root) {
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const entries = await collectEntries(root);
  const tarball = createDeterministicTarball(entries);

  return {
    name: packageJson.name,
    version: packageJson.version,
    filename: `${packageJson.name}-${packageJson.version}.tar.gz`,
    tarball,
    sha256: sha256(tarball),
    files: entries.map((entry) => ({
      path: entry.path.replace(/^package\//, ""),
      sha256: sha256(entry.content),
      mode: entry.mode,
      size: entry.content.length,
    })),
  };
}

export function checksumText(artifact) {
  return `${artifact.sha256}  ${artifact.filename}\n`;
}

export function manifestText(artifact) {
  return `${JSON.stringify(
    {
      name: artifact.name,
      version: artifact.version,
      filename: artifact.filename,
      sha256: artifact.sha256,
      files: artifact.files,
    },
    null,
    2,
  )}\n`;
}

export async function writeRelease(root, outDir) {
  const artifact = await buildArtifact(root);
  await mkdir(outDir, { recursive: true });
  const tarballPath = join(outDir, artifact.filename);
  const checksumPath = join(outDir, "SHA256SUMS");
  const manifestPath = join(outDir, "artifact-manifest.json");

  await writeFile(tarballPath, artifact.tarball);
  await writeFile(checksumPath, checksumText(artifact));
  await writeFile(manifestPath, manifestText(artifact));

  return { ...artifact, paths: { tarball: tarballPath, checksums: checksumPath, manifest: manifestPath } };
}
