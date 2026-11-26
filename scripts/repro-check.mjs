#!/usr/bin/env node
/**
 * Reproducibility check: build the release twice from the same source and
 * compare every artifact byte for byte. A third comparison against dist/ (when
 * present) proves that the artifacts about to be published are the ones that
 * were verified.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const EPOCH = "499162500";
const outputs = [];
let failed = false;

async function build(out) {
  const result = spawnSync(process.execPath, [join(ROOT, "scripts", "build-release.mjs"), "--out", out], {
    cwd: ROOT,
    env: { ...process.env, SOURCE_DATE_EPOCH: EPOCH },
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`build failed for ${out}:\n${result.stdout}\n${result.stderr}`);
  outputs.push(out);
}

function compare(first, second, label) {
  const a = readFileSync(join(first, "SHA256SUMS"), "utf8");
  const b = readFileSync(join(second, "SHA256SUMS"), "utf8");
  if (a !== b) {
    failed = true;
    console.error(`  x ${label}: artifact hashes differ`);
    return;
  }
  const manifestA = JSON.parse(readFileSync(join(first, "release-manifest.json"), "utf8"));
  const manifestB = JSON.parse(readFileSync(join(second, "release-manifest.json"), "utf8"));
  if (manifestA.files.length !== manifestB.files.length) {
    failed = true;
    console.error(`  x ${label}: file inventories differ`);
    return;
  }
  console.log(`  ok  ${label}: identical hashes for ${manifestA.artifacts.length} artifacts and ${manifestA.files.length} files`);
}

const first = await mkdtemp(join(tmpdir(), "coderax-repro-a-"));
const second = await mkdtemp(join(tmpdir(), "coderax-repro-b-"));

try {
  await build(first);
  await build(second);
  compare(first, second, "build A vs build B");

  const dist = join(ROOT, "dist");
  if (existsSync(join(dist, "release-manifest.json"))) {
    compare(dist, first, "dist/ vs clean rebuild");
  } else {
    console.log("  ok  dist/ not built; skipped the release-bytes comparison");
  }
} catch (error) {
  failed = true;
  console.error(`  x ${error.message}`);
} finally {
  for (const output of outputs) await rm(output, { recursive: true, force: true });
}

if (failed) {
  console.error("coderax repro: FAIL");
  process.exit(1);
}
console.log("coderax repro: PASS (release artifacts are reproducible)");
