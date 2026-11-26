import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildArtifact, writeRelease, sha256 } from "./lib/release.mjs";

const root = process.cwd();
const outIndex = process.argv.indexOf("--out-dir");
const outDir = resolve(root, outIndex === -1 ? "dist" : process.argv[outIndex + 1]);

const artifact = await writeRelease(root, outDir);

// A second build from the same inputs must be byte-identical; otherwise the
// checksum cannot be used to prove what was reviewed.
const first = await readFile(artifact.paths.tarball);
const second = (await buildArtifact(root)).tarball;
if (sha256(first) !== sha256(second)) {
  console.error("release: FAILED - two builds from the same inputs produced different bytes");
  process.exit(1);
}

console.log(`release: ${artifact.filename}`);
console.log(`release: ${artifact.sha256}  ${artifact.filename}`);
console.log(`release: ${artifact.files.length} files, reproducible across two builds`);
for (const file of artifact.files) {
  console.log(`  ${file.sha256}  ${file.path}`);
}
console.log(`release: wrote ${artifact.paths.tarball}`);
console.log(`release: wrote ${artifact.paths.checksums}`);
console.log(`release: wrote ${artifact.paths.manifest}`);
console.log("release: not published; artifacts are local only until publishing is authorized");
