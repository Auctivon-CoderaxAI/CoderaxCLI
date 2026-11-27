/**
 * Safe archive extraction.
 *
 * `tar -xzf` and `Expand-Archive` both honour entry names. A release archive is
 * a downloaded artifact, so a compromised or corrupted one must not be able to
 * write outside the install directory, follow a planted symlink, create a
 * symlink or device node, or overwrite an existing file. This extractor refuses
 * all four instead of trusting the archive:
 *
 *   - absolute paths, drive letters, UNC paths and `..` segments,
 *   - backslashes and NUL bytes in names,
 *   - every entry type other than a regular file,
 *   - duplicate entries (a classic overwrite trick),
 *   - any destination outside the requested directory,
 *   - an existing file or symlink at a destination path.
 *
 * It is implemented with the repository's own tar/zip readers, so extraction
 * does not depend on the host's tar implementation either.
 */
import { mkdir, open, realpath, lstat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { readTar, readZip } from "./archive.mjs";

export class UnsafeArchiveError extends Error {
  constructor(message) {
    super(message);
    this.name = "UnsafeArchiveError";
  }
}

const WINDOWS_ABSOLUTE = /^[A-Za-z]:/;

/** Reject a single entry name unless it is a plain relative path. */
export function assertSafeEntryName(name) {
  if (typeof name !== "string" || name === "") throw new UnsafeArchiveError("archive contains an empty entry name");
  if (name.includes("\0")) throw new UnsafeArchiveError(`archive entry contains a NUL byte: ${JSON.stringify(name)}`);
  if (name.includes("\\")) throw new UnsafeArchiveError(`archive entry uses a backslash path separator: ${name}`);
  if (isAbsolute(name) || name.startsWith("/") || WINDOWS_ABSOLUTE.test(name) || name.startsWith("//")) {
    throw new UnsafeArchiveError(`archive entry is an absolute path: ${name}`);
  }
  for (const segment of name.split("/")) {
    if (segment === "" || segment === ".") throw new UnsafeArchiveError(`archive entry has an empty or dot segment: ${name}`);
    if (segment === "..") throw new UnsafeArchiveError(`archive entry escapes its root with '..': ${name}`);
  }
  return name;
}

function assertInside(destination, target) {
  const rel = relative(destination, target);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new UnsafeArchiveError(`archive entry resolves outside the destination: ${target}`);
  }
  return target;
}

async function prepareTarget(destination, name) {
  const target = assertInside(destination, resolve(destination, name));
  const parent = dirname(target);
  await mkdir(parent, { recursive: true, mode: 0o755 });
  // A pre-existing symlinked directory would redirect the write; compare the
  // canonical destination with the canonical parent.
  const [rootReal, parentReal] = await Promise.all([realpath(destination), realpath(parent)]);
  if (parentReal !== rootReal && !parentReal.startsWith(`${rootReal}${sep}`)) {
    throw new UnsafeArchiveError(`archive entry would be written through a symlink: ${name}`);
  }
  try {
    await lstat(target);
    throw new UnsafeArchiveError(`refusing to overwrite an existing path: ${name}`);
  } catch (error) {
    if (error instanceof UnsafeArchiveError) throw error;
    if (error?.code !== "ENOENT") throw error;
  }
  return target;
}

async function writeEntry(destination, name, data, mode) {
  const target = await prepareTarget(destination, name);
  // Strip setuid/setgid/sticky bits from archive metadata.
  const safeMode = (mode ?? 0o644) & 0o777;
  const handle = await open(target, "wx", safeMode);
  try {
    await handle.writeFile(data);
  } finally {
    await handle.close();
  }
  return data.length;
}

/**
 * Extract a .tar.gz into `destination`.
 * `destination` must be an empty directory controlled by the caller.
 */
export async function extractTarGz(archivePath, destination, { readFileImpl } = {}) {
  const { readFile } = await import("node:fs/promises");
  const read = readFileImpl ?? readFile;
  const buffer = gunzipSync(await read(archivePath));
  const duplicates = [];
  const entries = readTar(buffer, { includeSpecial: true, duplicates });
  if (duplicates.length > 0) {
    throw new UnsafeArchiveError(`archive contains a duplicate entry: ${duplicates[0]}`);
  }
  const seen = new Set();
  let bytes = 0;
  for (const [rawName, entry] of entries) {
    const name = assertSafeEntryName(rawName);
    seen.add(name);
    if (entry.type !== "0" && entry.type !== "") {
      throw new UnsafeArchiveError(`archive entry is not a regular file (type ${JSON.stringify(entry.type)}): ${name}`);
    }
    bytes += await writeEntry(destination, name, entry.data, entry.mode);
  }
  return { files: seen.size, bytes };
}

/** Extract a .zip into `destination` with the same rules. */
export async function extractZip(archivePath, destination, { readFileImpl } = {}) {
  const { readFile } = await import("node:fs/promises");
  const read = readFileImpl ?? readFile;
  const duplicates = [];
  const entries = readZip(await read(archivePath), { duplicates });
  if (duplicates.length > 0) {
    throw new UnsafeArchiveError(`archive contains a duplicate entry: ${duplicates[0]}`);
  }
  const seen = new Set();
  let bytes = 0;
  for (const [rawName, entry] of entries) {
    const name = assertSafeEntryName(rawName);
    seen.add(name);
    bytes += await writeEntry(destination, name, entry.data, entry.mode);
  }
  return { files: seen.size, bytes };
}

/** Detect the format from the file name and extract. */
export async function extractArchive(archivePath, destination) {
  return /\.zip$/i.test(archivePath)
    ? extractZip(archivePath, destination)
    : extractTarGz(archivePath, destination);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [archive, destination] = process.argv.slice(2);
  if (!archive || !destination) {
    console.error("usage: safe-extract.mjs <archive.tar.gz|archive.zip> <empty-directory>");
    process.exit(2);
  }
  try {
    await mkdir(destination, { recursive: true, mode: 0o755 });
    const result = await extractArchive(archive, resolve(destination));
    console.log(`extracted ${result.files} files (${result.bytes} bytes)`);
  } catch (error) {
    console.error(`coderax extract: ${error.name}: ${error.message}`);
    process.exit(1);
  }
}
