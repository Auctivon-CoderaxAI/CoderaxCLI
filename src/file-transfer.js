import { createHash, randomBytes } from "node:crypto";
import { lstat, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, resolve, sep } from "node:path";
import { CoderaxError } from "./client.js";
import { MAX_ARTIFACT_BYTES } from "./capability-catalog.js";

/**
 * Local file validation and transfer primitives for the authoritative artifact
 * service.
 *
 * Contract 1.1.0 transfers artifact bytes as base64 inside JSON, scoped to one
 * owner task, with the engine computing and publishing `sha256:<hex>`. Files
 * are therefore validated and hashed before they leave the owner's machine,
 * uploaded only to the task the owner just created, and downloaded into a
 * destination that is never overwritten without explicit authorization. No
 * document, inference or artifact work happens here.
 */

export const MAX_DOWNLOAD_BYTES = MAX_ARTIFACT_BYTES;

const MIME_BY_EXTENSION = Object.freeze({
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac",
  ".webm": "audio/webm",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".json": "application/json",
  ".rtf": "application/rtf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".odt": "application/vnd.oasis.opendocument.text",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ods": "application/vnd.oasis.opendocument.spreadsheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".odp": "application/vnd.oasis.opendocument.presentation",
  ".zip": "application/zip",
});

const ZIP_EXTENSIONS = new Set([".docx", ".odt", ".xlsx", ".ods", ".pptx", ".odp", ".zip"]);
const OLE_MIMES = new Set([
  "application/msword",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
]);
const TEXT_MIMES = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/tab-separated-values",
  "application/json",
]);

export function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/** Accept only the published `sha256:<64 hex>` or a bare 64-hex digest. */
export function normalizeDigest(value) {
  if (typeof value !== "string") return null;
  const match = /^(?:sha256:)?([a-f0-9]{64})$/i.exec(value.trim());
  return match ? match[1].toLowerCase() : null;
}

function canonicalMime(mime) {
  if (!mime) return mime;
  const lower = mime.split(";")[0].trim().toLowerCase();
  return lower === "audio/x-wav" ? "audio/wav" : lower;
}

function startsWith(buffer, bytes) {
  if (buffer.length < bytes.length) return false;
  return bytes.every((byte, index) => buffer[index] === byte);
}

function ascii(buffer, start, length) {
  return buffer.subarray(start, start + length).toString("latin1");
}

function isTextBuffer(buffer) {
  if (buffer.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
}

/** Sniff a conservative file family. Returns null when no signature matches. */
export function detectFile(buffer) {
  if (startsWith(buffer, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
    return { family: "pdf", mime: "application/pdf" };
  }
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { family: "image", mime: "image/png" };
  }
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) {
    return { family: "image", mime: "image/jpeg" };
  }
  if (ascii(buffer, 0, 4) === "GIF8") {
    return { family: "image", mime: "image/gif" };
  }
  if (ascii(buffer, 0, 4) === "RIFF" && ascii(buffer, 8, 4) === "WEBP") {
    return { family: "image", mime: "image/webp" };
  }
  if (ascii(buffer, 0, 4) === "RIFF" && ascii(buffer, 8, 4) === "WAVE") {
    return { family: "audio", mime: "audio/wav" };
  }
  if (ascii(buffer, 0, 4) === "OggS") {
    return { family: "audio", mime: "audio/ogg" };
  }
  if (ascii(buffer, 0, 4) === "fLaC") {
    return { family: "audio", mime: "audio/flac" };
  }
  if (ascii(buffer, 0, 3) === "ID3" || (buffer.length >= 2 && buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0)) {
    return { family: "audio", mime: "audio/mpeg" };
  }
  if (ascii(buffer, 4, 4) === "ftyp") {
    const brand = ascii(buffer, 8, 4);
    return ["qt  ", "qt"].includes(brand)
      ? { family: "video", mime: "video/quicktime" }
      : { family: "audio", mime: "audio/mp4" };
  }
  if (startsWith(buffer, [0x1a, 0x45, 0xdf, 0xa3])) {
    return { family: "audio", mime: "audio/webm" };
  }
  if (startsWith(buffer, [0x50, 0x4b, 0x03, 0x04])) {
    return { family: "zip", mime: "application/zip" };
  }
  if (startsWith(buffer, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    return { family: "ole", mime: "application/x-ole-storage" };
  }
  if (ascii(buffer, 0, 5) === "{\\rtf") {
    return { family: "rtf", mime: "application/rtf" };
  }
  if (isTextBuffer(buffer)) {
    return { family: "text", mime: null };
  }
  return null;
}

function compatible(extension, extensionMime, detected) {
  if (detected === null) return false;
  if (detected.family === "zip") return ZIP_EXTENSIONS.has(extension);
  if (detected.family === "ole") return OLE_MIMES.has(extensionMime);
  if (detected.family === "text") return TEXT_MIMES.has(extensionMime);
  if (detected.family === "rtf") return extensionMime === "application/rtf";
  return canonicalMime(extensionMime) === canonicalMime(detected.mime);
}

function acceptedTypes(mimeTypes) {
  return (mimeTypes ?? []).map(canonicalMime);
}

function describeAccepted(mimeTypes) {
  return mimeTypes.length > 0 ? mimeTypes.join(", ") : "any supported type";
}

/**
 * Validate a regular file, sniff its real type and hash it. The whole file is
 * held in memory only up to the published limit; larger files are refused
 * before they are read.
 */
export async function inspectFile(
  filePath,
  { mimeTypes = [], maxBytes = MAX_ARTIFACT_BYTES, cwd = process.cwd() } = {},
) {
  if (typeof filePath !== "string" || filePath.trim() === "") {
    throw new CoderaxError("UPLOAD_PATH_REQUIRED", "a file path is required");
  }
  const resolved = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
  let metadata;
  try {
    metadata = await lstat(resolved);
  } catch {
    throw new CoderaxError("UPLOAD_NOT_FOUND", `cannot read ${basename(filePath)}: file does not exist`);
  }
  if (metadata.isSymbolicLink()) {
    throw new CoderaxError("UPLOAD_SYMLINK_REFUSED", "symbolic links are not uploaded; pass the real file path");
  }
  if (!metadata.isFile()) {
    throw new CoderaxError("UPLOAD_NOT_A_FILE", `${basename(filePath)} is not a regular file`);
  }
  if (metadata.size === 0) {
    throw new CoderaxError("UPLOAD_EMPTY", `${basename(filePath)} is empty`);
  }
  const limit = Math.min(maxBytes, MAX_ARTIFACT_BYTES);
  if (metadata.size > limit) {
    throw new CoderaxError(
      "UPLOAD_TOO_LARGE",
      `${basename(filePath)} is ${metadata.size} bytes; the limit for this input is ${limit} bytes`,
    );
  }

  let buffer;
  try {
    buffer = await readFile(resolved);
  } catch {
    throw new CoderaxError("UPLOAD_UNREADABLE", `cannot read ${basename(filePath)}`);
  }
  if (buffer.length === 0) {
    throw new CoderaxError("UPLOAD_EMPTY", `${basename(filePath)} is empty`);
  }
  if (buffer.length > limit) {
    throw new CoderaxError("UPLOAD_TOO_LARGE", `${basename(filePath)} grew beyond the ${limit}-byte limit while reading`);
  }

  const extension = extname(resolved).toLowerCase();
  const extensionMime = MIME_BY_EXTENSION[extension] ?? null;
  const detected = detectFile(buffer);
  const allowed = acceptedTypes(mimeTypes);

  if (detected === null) {
    throw new CoderaxError("UPLOAD_TYPE_UNSUPPORTED", `the contents of ${basename(filePath)} are not a supported file type`);
  }
  if (extensionMime !== null && !compatible(extension, extensionMime, detected)) {
    throw new CoderaxError(
      "UPLOAD_TYPE_MISMATCH",
      `the contents of ${basename(filePath)} do not match its .${extension.slice(1)} extension`,
    );
  }

  let mimeType = extensionMime;
  if (mimeType === null) {
    if (detected.mime === null) {
      throw new CoderaxError("UPLOAD_TYPE_UNSUPPORTED", `cannot determine the type of ${basename(filePath)}; use a known extension`);
    }
    mimeType = detected.mime;
  }
  mimeType = canonicalMime(mimeType);

  if (allowed.length > 0 && !allowed.includes(mimeType)) {
    throw new CoderaxError(
      "UPLOAD_TYPE_NOT_ACCEPTED",
      `${basename(filePath)} is ${mimeType}; this input accepts ${describeAccepted(allowed)}`,
    );
  }

  return {
    path: resolved,
    name: basename(resolved),
    bytes: buffer.length,
    sha256: sha256Hex(buffer),
    mimeType,
    buffer,
  };
}

/**
 * Contract 1.1.0 `ArtifactPath`: relative, no directory traversal, no absolute
 * path and no Windows drive letter. The engine validates this again; the client
 * refuses to construct an invalid one.
 */
export function artifactPath(name) {
  const safe = safeArtifactName(name);
  const normalized = safe.replace(/\\/g, "/");
  if (
    normalized.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(normalized) ||
    normalized.split("/").some((segment) => segment === "..")
  ) {
    throw new CoderaxError("ARTIFACT_PATH_INVALID", "the artifact path must be relative and may not traverse");
  }
  return normalized.slice(0, 1024);
}

export function safeArtifactName(value, fallback = "artifact.bin") {
  const raw = typeof value === "string" ? value : "";
  const name = basename(raw.replace(/\\/g, "/")).replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (name === "" || name === "." || name === "..") return fallback;
  return name.slice(0, 180);
}

/**
 * Resolve and inspect a download destination. Existence is reported to the
 * caller; only an explicit `force` authorizes replacing it.
 */
export async function prepareDestination({ out, defaultName, cwd = process.cwd(), force = false }) {
  if (out === "-") {
    throw new CoderaxError("ARTIFACT_DESTINATION_INVALID", "writing artifacts to stdout is not supported; provide a file path");
  }
  const name = safeArtifactName(defaultName);
  const destination = out
    ? isAbsolute(out)
      ? out
      : resolve(cwd, out)
    : resolve(cwd, name);
  if (destination.endsWith(sep) || destination.endsWith("/") || destination.endsWith("\\")) {
    throw new CoderaxError("ARTIFACT_DESTINATION_INVALID", "the download destination must be a file path, not a directory");
  }
  const parent = dirname(destination);
  let parentMetadata;
  try {
    parentMetadata = await stat(parent);
  } catch {
    throw new CoderaxError("ARTIFACT_DESTINATION_MISSING", `the destination directory ${parent} does not exist`);
  }
  if (!parentMetadata.isDirectory()) {
    throw new CoderaxError("ARTIFACT_DESTINATION_INVALID", `${parent} is not a directory`);
  }

  let existing = false;
  try {
    const metadata = await lstat(destination);
    if (metadata.isSymbolicLink()) {
      throw new CoderaxError("ARTIFACT_DESTINATION_SYMLINK", "refusing to write through a symbolic link");
    }
    if (metadata.isDirectory()) {
      throw new CoderaxError("ARTIFACT_DESTINATION_INVALID", "the download destination is a directory");
    }
    existing = true;
    if (!force) {
      throw new CoderaxError(
        "ARTIFACT_DESTINATION_EXISTS",
        `${destination} already exists; pass --force to replace it or --out with another path`,
      );
    }
  } catch (error) {
    if (error instanceof CoderaxError) throw error;
  }

  return { destination, name, existing, force };
}

async function replaceFile(tempPath, destination) {
  try {
    await rename(tempPath, destination);
  } catch (error) {
    // Windows does not replace an existing destination with rename().
    if (error?.code === "EEXIST" || error?.code === "EPERM") {
      await rm(destination, { force: true });
      await rename(tempPath, destination);
      return;
    }
    throw error;
  }
}

/** Encode validated bytes for the published base64 artifact request. */
export function encodeBase64(buffer) {
  return Buffer.from(buffer).toString("base64");
}

/** Decode a published base64 body under an explicit byte bound. */
export function decodeBase64(text, { maxBytes = MAX_DOWNLOAD_BYTES } = {}) {
  if (typeof text !== "string" || text.length === 0) {
    throw new CoderaxError("ARTIFACT_CONTENT_INVALID", "the engine returned no artifact content");
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text)) {
    throw new CoderaxError("ARTIFACT_CONTENT_INVALID", "the artifact content is not standard base64");
  }
  const buffer = Buffer.from(text, "base64");
  if (buffer.length === 0) {
    throw new CoderaxError("ARTIFACT_CONTENT_INVALID", "the artifact content decoded to zero bytes");
  }
  if (buffer.length > maxBytes) {
    throw new CoderaxError("ARTIFACT_TOO_LARGE", `the artifact is ${buffer.length} bytes; the limit is ${maxBytes}`);
  }
  return buffer;
}

/**
 * Write published artifact bytes after proving the digest and byte count the
 * engine reported. A mismatch is never written: the temporary file is removed
 * and the destination is left untouched.
 */
export async function writeArtifactBytes({
  destination,
  force = false,
  expectedSha256,
  expectedBytes,
  contentBase64,
  maxBytes = MAX_DOWNLOAD_BYTES,
}) {
  const expected = normalizeDigest(expectedSha256);
  if (expected === null) {
    throw new CoderaxError(
      "ARTIFACT_DIGEST_INVALID",
      "the artifact metadata does not carry a published sha256 digest",
    );
  }
  const buffer = decodeBase64(contentBase64, { maxBytes });
  const actual = sha256Hex(buffer);
  if (actual !== expected) {
    throw new CoderaxError(
      "ARTIFACT_INTEGRITY_FAILED",
      "the downloaded artifact did not match its published SHA-256 digest",
    );
  }
  if (Number.isSafeInteger(expectedBytes) && expectedBytes >= 0 && buffer.length !== expectedBytes) {
    throw new CoderaxError(
      "ARTIFACT_INTEGRITY_FAILED",
      `the downloaded artifact is ${buffer.length} bytes; the engine reported ${expectedBytes}`,
    );
  }

  const tempPath = force
    ? `${destination}.${process.pid}.${randomBytes(6).toString("hex")}.part`
    : destination;
  try {
    await writeFile(tempPath, buffer, { flag: "wx", mode: 0o600 });
    if (force) await replaceFile(tempPath, destination);
    return { path: destination, bytes: buffer.length, sha256: actual };
  } catch (error) {
    try {
      await rm(tempPath, { force: true });
    } catch {
      // Nothing to clean up.
    }
    if (error instanceof CoderaxError) throw error;
    if (error?.code === "EEXIST") {
      throw new CoderaxError(
        "ARTIFACT_DESTINATION_EXISTS",
        `${destination} already exists; pass --force to replace it or --out with another path`,
      );
    }
    throw new CoderaxError("ARTIFACT_DESTINATION_UNWRITABLE", `cannot write ${destination}`);
  }
}

