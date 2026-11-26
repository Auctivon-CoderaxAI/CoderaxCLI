import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { buildArtifact, checksumText, sha256 } from "../scripts/lib/release.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const IS_WINDOWS = process.platform === "win32";

test("[capability:release-artifact-integrity] release artifacts are byte-reproducible with verifiable checksums", async () => {
  const first = await buildArtifact(ROOT);
  const second = await buildArtifact(ROOT);
  assert.equal(first.sha256, second.sha256, "two builds must be byte-identical");
  assert.equal(first.tarball.length, second.tarball.length);
  assert.match(checksumText(first), /^[0-9a-f]{64} {2}coderax-cli-\d+\.\d+\.\d+\.tar\.gz\n$/);

  const directory = await mkdtemp(join(tmpdir(), "coderax-release-"));
  const tarballPath = join(directory, first.filename);
  const extractDir = join(directory, "extract");
  await writeFile(tarballPath, first.tarball);
  await import("node:fs/promises").then(({ mkdir }) => mkdir(extractDir, { recursive: true }));

  const extracted = spawnSync("tar", ["-xzf", tarballPath, "-C", extractDir], { encoding: "utf8" });
  assert.equal(extracted.status, 0, `tar could not read the artifact: ${extracted.stderr}`);

  const packageDir = join(extractDir, "package");
  const found = [];
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) await walk(full);
      else found.push(relative(packageDir, full).split(sep).join("/"));
    }
  };
  await walk(packageDir);

  assert.deepEqual(found.sort(), first.files.map((file) => file.path).sort());

  for (const file of first.files) {
    const content = await readFile(join(packageDir, file.path));
    assert.equal(sha256(content), file.sha256, `${file.path} does not match the manifest`);
  }

  if (!IS_WINDOWS) {
    const mode = (await stat(join(packageDir, "src/cli.js"))).mode & 0o777;
    assert.equal(mode, 0o755, "the installed entrypoint must stay executable");
  }

  for (const forbidden of ["test/", ".github/", ".coderax/", ".env"]) {
    assert.equal(
      found.some((path) => path.startsWith(forbidden)),
      false,
      `the artifact must not contain ${forbidden}`,
    );
  }

  assert.ok(found.includes("package.json"));
  assert.ok(found.includes("docs/CONTRACT.md"));
  assert.ok(found.includes("src/cli.js"));
  assert.ok(found.includes("SECURITY.md"));
});
