/**
 * Explicit, reviewed local-file attachments.
 *
 * The CLI is an access and control client, so a referenced file is only read
 * after the operator approves that exact file for that exact send. Symlinks are
 * refused unless explicitly enabled, sensitive paths are always refused, and
 * content never appears in a prompt, a history file or a log.
 */

import { createHash } from "node:crypto";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { sanitizeOneLine } from "./sanitize.js";

const MAX_FILE_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024;
const MAX_FILES = 5;
const BINARY_SNIFF_BYTES = 8192;

const SENSITIVE_SEGMENTS = new Set([
  ".ssh",
  ".aws",
  ".gnupg",
  ".coderax",
  ".git",
  ".azure",
  ".kube",
  ".docker",
]);
const SENSITIVE_NAMES = new Set([
  ".env",
  ".netrc",
  ".npmrc",
  ".pgpass",
  ".git-credentials",
  "credentials",
  "credentials.json",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "known_hosts",
  "authorized_keys",
]);
const SENSITIVE_EXTENSIONS = new Set([
  ".pem",
  ".key",
  ".p12",
  ".pfx",
  ".kdbx",
  ".keystore",
  ".jks",
  ".mobileprovision",
  ".ovpn",
  ".tfstate",
  ".tfvars",
]);
const SENSITIVE_WORDS = /(^|[._-])(secret|secrets|credential|credentials|password|passwd|token|private[-_]?key)([._-]|$)/i;

export class AttachmentError extends Error {
  constructor(code, message, { path: filePath } = {}) {
    super(message);
    this.name = "AttachmentError";
    this.code = code;
    if (filePath) this.path = filePath;
  }
}

/** Find `@path` and `@"quoted path"` references, ignoring email addresses. */
export function findAttachmentRefs(text) {
  const source = String(text ?? "");
  const pattern = /(^|[\s(])@"([^"\n]+)"|(^|[\s(])@([^\s"'<>]+)/g;
  const refs = [];
  for (const match of source.matchAll(pattern)) {
    const prefix = match[1] ?? match[3] ?? "";
    const raw = match[2] ?? match[4] ?? "";
    const cleaned = match[2] === undefined ? raw.replace(/[;,!:?)\]}]+$/, "") : raw;
    if (cleaned === "") continue;
    const start = (match.index ?? 0) + prefix.length;
    // Include the leading `@` (and the quotes for a quoted reference).
    refs.push({ start, end: start + (match[2] === undefined ? raw.length + 1 : raw.length + 2), path: cleaned });
  }
  return refs;
}

export function isSensitivePath(filePath) {
  const parts = String(filePath).split(/[\\/]+/).filter(Boolean);
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (SENSITIVE_SEGMENTS.has(lower)) return true;
    if (SENSITIVE_NAMES.has(lower)) return true;
    if (lower.startsWith(".env.")) return true;
    if (SENSITIVE_WORDS.test(lower)) return true;
    const extension = lower.slice(lower.lastIndexOf("."));
    if (SENSITIVE_EXTENSIONS.has(extension)) return true;
  }
  return false;
}

function within(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function defaultConfirm() {
  return false;
}

/**
 * Resolve, authorise and read file references.
 *
 * @returns {Promise<{text:string, files:Array<{name:string,bytes:number,sha256:string,content:string}>}>}
 */
export async function prepareAttachments({
  text,
  cwd = process.cwd(),
  confirm = defaultConfirm,
  env = process.env,
  platform = process.platform,
  deps = {},
} = {}) {
  const {
    lstatImpl = lstat,
    statImpl = stat,
    readFileImpl = readFile,
    realpathImpl = realpath,
  } = deps;

  const refs = findAttachmentRefs(text);
  if (refs.length === 0) return { text: String(text ?? ""), files: [] };
  if (typeof confirm !== "function") {
    throw new AttachmentError(
      "ATTACHMENT_AUTHORIZATION_REQUIRED",
      "local file references require an interactive approval before they can be sent",
    );
  }
  if (refs.length > MAX_FILES) {
    throw new AttachmentError("ATTACHMENT_TOO_MANY", `at most ${MAX_FILES} files can be attached to one prompt`);
  }

  const allowOutside = env.CODERAX_ATTACHMENTS_OUTSIDE_CWD === "1";
  const allowSymlinks = env.CODERAX_ATTACHMENTS_FOLLOW_SYMLINKS === "1";
  // A symlink target is compared in its real form, so the root has to be real
  // too. The working directory is routinely reached through a symlink (/var is
  // /private/var on macOS, /tmp is /private/tmp); comparing a resolved target
  // against an unresolved root makes a legitimate link inside the workspace
  // look like an escape.
  let root = resolve(cwd);
  try {
    root = await realpathImpl(root);
  } catch {
    // A missing or unreadable cwd keeps the plain resolution; the per-file
    // lstat below still reports the missing attachment.
  }
  const files = [];
  const seen = new Set();
  let totalBytes = 0;

  for (const ref of refs) {
    const candidate = resolve(root, ref.path);
    if (!allowOutside && !within(root, candidate)) {
      throw new AttachmentError(
        "ATTACHMENT_OUTSIDE_CWD",
        `refusing to attach ${sanitizeOneLine(ref.path, 120)}: it is outside the working directory`,
      );
    }
    if (isSensitivePath(candidate)) {
      throw new AttachmentError(
        "ATTACHMENT_SENSITIVE",
        `refusing to attach ${sanitizeOneLine(ref.path, 120)}: the path looks like a credential or secret store`,
      );
    }

    let info;
    try {
      info = await lstatImpl(candidate);
    } catch {
      throw new AttachmentError("ATTACHMENT_NOT_FOUND", `attachment not found: ${sanitizeOneLine(ref.path, 120)}`);
    }

    let target = candidate;
    let symlinkTarget = null;
    if (info.isSymbolicLink()) {
      if (!allowSymlinks) {
        throw new AttachmentError(
          "ATTACHMENT_SYMLINK",
          `refusing to follow symlink ${sanitizeOneLine(ref.path, 120)}; enable CODERAX_ATTACHMENTS_FOLLOW_SYMLINKS to review it explicitly`,
        );
      }
      target = await realpathImpl(candidate);
      if (!allowOutside && !within(root, target)) {
        throw new AttachmentError("ATTACHMENT_OUTSIDE_CWD", "symlink target is outside the working directory");
      }
      if (isSensitivePath(target)) {
        throw new AttachmentError("ATTACHMENT_SENSITIVE", "symlink target looks like a credential or secret store");
      }
      symlinkTarget = target;
      info = await statImpl(target);
    }

    if (!info.isFile()) {
      throw new AttachmentError("ATTACHMENT_NOT_A_FILE", `not a regular file: ${sanitizeOneLine(ref.path, 120)}`);
    }
    if (info.size > MAX_FILE_BYTES) {
      throw new AttachmentError(
        "ATTACHMENT_TOO_LARGE",
        `${sanitizeOneLine(ref.path, 120)} is ${info.size} bytes; the per-file limit is ${MAX_FILE_BYTES}`,
      );
    }
    totalBytes += info.size;
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new AttachmentError("ATTACHMENT_TOO_LARGE", `attachments exceed the ${MAX_TOTAL_BYTES}-byte limit`);
    }

    const buffer = await readFileImpl(target);
    if (buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
      throw new AttachmentError("ATTACHMENT_BINARY", `refusing to attach binary file ${sanitizeOneLine(ref.path, 120)}`);
    }
    const content = buffer.toString("utf8");
    const sha256 = createHash("sha256").update(buffer).digest("hex");
    const name = basename(target);
    const approved = await confirm({
      name,
      path: candidate,
      symlinkTarget,
      bytes: buffer.length,
      sha256,
      preview: content.slice(0, 200).replace(/\s+/g, " "),
    });
    if (approved !== true) {
      throw new AttachmentError("ATTACHMENT_DECLINED", `attachment not approved: ${sanitizeOneLine(ref.path, 120)}`);
    }
    if (seen.has(target)) continue;
    seen.add(target);
    files.push({ name, bytes: buffer.length, sha256, content });
  }

  // Replace references from the end so earlier indices stay valid.
  let prompt = String(text ?? "");
  for (const ref of refs.slice().sort((a, b) => b.start - a.start)) {
    const name = basename(resolve(root, ref.path));
    prompt = `${prompt.slice(0, ref.start)}[attached: ${name}]${prompt.slice(ref.end)}`;
  }

  return { text: prompt, files };
}

export { MAX_FILE_BYTES, MAX_TOTAL_BYTES, MAX_FILES };
