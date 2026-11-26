import { createHash, randomBytes } from "node:crypto";
import { lstat, open, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, resolve, sep } from "node:path";
import { CoderaxError } from "./client.js";

/**
 * Local file validation and transfer primitives.
 *
 * Files are validated before they leave the owner's machine, uploaded with a
 * SHA-256 that the engine must echo, and downloaded into a destination that is
 * never overwritten without explicit authorization. No document, inference or
 * artifact work happens here.
 */

export const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;

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
  ".zip": "application/zip",
});

const ZIP_EXTENSIONS = new Set([".docx", ".odt", ".xlsx", ".ods", ".pptx", ".odp", ".zip"]);
const OLE_MIMES = new Set(["application/msword", "application/vnd.ms-excel", "application/vnd.ms-powerpoint"]);
const TEXT_MIMES = new Set(["text/plain", "text/markdown", "text/csv", "text/tab-separated-values", "application/json"]);

export function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

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
    return { family: "audio", mime: "audio/mp4" };
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
export async function inspectFile(filePath, { mimeTypes = [], maxBytes = 50 * 1024 * 1024, cwd = process.cwd() } = {}) {
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
  const limit = Math.min(maxBytes, 50 * 1024 * 1024);
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

function safeFieldName(name) {
  if (typeof name !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(name)) {
    throw new CoderaxError("UPLOAD_FIELD_INVALID", `invalid multipart field name: ${String(name)}`);
  }
  return name;
}

function safeHeaderValue(value) {
  const text = String(value);
  if (/[\r\n]/.test(text)) {
    throw new CoderaxError("UPLOAD_FIELD_INVALID", "multipart values must not contain newlines");
  }
  return text;
}

/** Build a deterministic multipart body with an unguessable boundary. */
export function buildMultipart({ file, fields = {} }) {
  const boundary = `----coderax-${randomBytes(16).toString("hex")}`;
  const parts = [];
  const filename = file.name.replace(/["\\\r\n]/g, "_").slice(0, 180) || "file";
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        `Content-Type: ${canonicalMime(file.mimeType)}\r\n\r\n`,
      "utf8",
    ),
  );
  parts.push(file.buffer);
  parts.push(Buffer.from("\r\n", "utf8"));
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${safeFieldName(name)}"\r\n\r\n${safeHeaderValue(value)}\r\n`,
        "utf8",
      ),
    );
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
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

/**
 * Stream a response body into a file while hashing it. A partial, oversized or
 * mismatched download is deleted instead of being left behind.
 */
export async function writeDownload({
  destination,
  force = false,
  expectedSha256,
  expectedBytes,
  maxBytes = MAX_DOWNLOAD_BYTES,
  body,
  signal,
}) {
  const expected = expectedSha256 ? normalizeDigest(expectedSha256) : null;
  if (expectedSha256 && expected === null) {
    throw new CoderaxError("ARTIFACT_DIGEST_INVALID", "the artifact metadata does not carry a SHA-256 digest");
  }
  const tempPath = force
    ? `${destination}.${process.pid}.${randomBytes(6).toString("hex")}.part`
    : destination;
  let handle;
  try {
    handle = await open(tempPath, "wx", 0o600);
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new CoderaxError(
        "ARTIFACT_DESTINATION_EXISTS",
        `${destination} already exists; pass --force to replace it or --out with another path`,
      );
    }
    throw new CoderaxError("ARTIFACT_DESTINATION_UNWRITABLE", `cannot create ${destination}`);
  }
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    const reader = body.getReader();
    for (;;) {
      if (signal?.aborted) throw new CoderaxError("CANCELLED", "download cancelled");
      const { value, done } = await reader.read();
      if (done) break;
      const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
      bytes += buffer.length;
      if (bytes > maxBytes) {
        throw new CoderaxError("ARTIFACT_TOO_LARGE", `the download exceeded the ${maxBytes}-byte limit`);
      }
      hash.update(buffer);
      await handle.write(buffer);
    }
    await handle.sync();
    await handle.close();

    const actual = hash.digest("hex");
    if (expected !== null && actual !== expected) {
      throw new CoderaxError(
        "ARTIFACT_INTEGRITY_FAILED",
        "the downloaded artifact did not match its published SHA-256 digest",
      );
    }
    if (Number.isSafeInteger(expectedBytes) && expectedBytes >= 0 && bytes !== expectedBytes) {
      throw new CoderaxError(
        "ARTIFACT_INTEGRITY_FAILED",
        `the downloaded artifact is ${bytes} bytes; the engine reported ${expectedBytes}`,
      );
    }
    if (force) await replaceFile(tempPath, destination);
    return { path: destination, bytes, sha256: actual };
  } catch (error) {
    try {
      await handle.close();
    } catch {
      // Already closed.
    }
    try {
      await rm(tempPath, { force: true });
    } catch {
      // Nothing to clean up.
    }
    if (error instanceof CoderaxError) throw error;
    if (signal?.aborted) throw new CoderaxError("CANCELLED", "artifact download cancelled");
    if (error?.name === "AbortError" || error?.name === "TimeoutError") {
      throw new CoderaxError("REQUEST_TIMEOUT", "the artifact download was interrupted");
    }
    throw new CoderaxError(
      "ARTIFACT_DOWNLOAD_FAILED",
      "the artifact download could not be completed",
    );
  }
}
