import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createDeterministicTarball } from "./tar.mjs";

import { packageFiles, normalizeText, isExecutable } from "./package-files.mjs";

export function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export async function collectEntries(root) {
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  return Promise.all((await packageFiles(root, pkg)).map(async (file) => ({
    path: `package/${file}`,
    content: normalizeText(file, await readFile(join(root, file))),
    mode: isExecutable(file) ? 0o755 : 0o644,
  })));
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
