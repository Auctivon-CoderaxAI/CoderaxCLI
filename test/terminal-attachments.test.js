import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AttachmentError,
  findAttachmentRefs,
  isSensitivePath,
  prepareAttachments,
} from "../src/terminal/attachments.js";

async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), "coderax-attach-"));
  await writeFile(join(dir, "notes.txt"), "hello attachment\n", "utf8");
  await writeFile(join(dir, "space name.txt"), "spaced\n", "utf8");
  await writeFile(join(dir, ".env"), "SECRET=1\n", "utf8");
  await writeFile(join(dir, "binary.bin"), Buffer.from([0, 1, 2, 3]));
  await writeFile(join(dir, "large.txt"), "x".repeat(300 * 1024), "utf8");
  return dir;
}

const approve = (calls = []) => async (info) => {
  calls.push(info);
  return true;
};

test("no references means no authorisation and no reads", async () => {
  const dir = await workspace();
  const result = await prepareAttachments({ text: "hello", cwd: dir, confirm: null, env: {} });
  assert.deepEqual(result, { text: "hello", files: [] });
});

test("an approved file is read, hashed and replaced by a safe reference", async () => {
  const dir = await workspace();
  const calls = [];
  const result = await prepareAttachments({
    text: "summarize @notes.txt please",
    cwd: dir,
    confirm: approve(calls),
    env: {},
  });
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].name, "notes.txt");
  assert.equal(result.files[0].content, "hello attachment\n");
  assert.equal(result.files[0].bytes, 17);
  assert.equal(result.files[0].sha256.length, 64);
  assert.equal(result.text, "summarize [attached: notes.txt] please");
  assert.equal(calls.length, 1);
  // macOS reaches its temporary directory through /var -> /private/var, so
  // compare the real path the CLI reports with the real path on disk.
  assert.equal(calls[0].path, await realpath(join(dir, "notes.txt")));
  assert.equal(calls[0].preview.includes("hello"), true);
});

test("quoted paths with spaces work", async () => {
  const dir = await workspace();
  const result = await prepareAttachments({
    text: 'read @"space name.txt"',
    cwd: dir,
    confirm: approve(),
    env: {},
  });
  assert.equal(result.files[0].content, "spaced\n");
  assert.match(result.text, /\[attached: space name\.txt\]/);
});

test("a declined confirmation aborts the send", async () => {
  const dir = await workspace();
  await assert.rejects(
    () => prepareAttachments({ text: "read @notes.txt", cwd: dir, confirm: async () => false, env: {} }),
    (error) => error instanceof AttachmentError && error.code === "ATTACHMENT_DECLINED",
  );
});

test("without a confirmation channel, local files are refused", async () => {
  const dir = await workspace();
  await assert.rejects(
    () => prepareAttachments({ text: "read @notes.txt", cwd: dir, confirm: null, env: {} }),
    (error) => error.code === "ATTACHMENT_AUTHORIZATION_REQUIRED",
  );
});

test("credential-like paths are always refused, even when approved", async () => {
  const dir = await workspace();
  assert.equal(isSensitivePath(join(dir, ".env")), true);
  await assert.rejects(
    () => prepareAttachments({ text: "read @.env", cwd: dir, confirm: approve(), env: {} }),
    (error) => error.code === "ATTACHMENT_SENSITIVE",
  );
});

test("paths outside the working directory are refused by default", async () => {
  const dir = await workspace();
  const outside = join(dir, "..", "outside.txt");
  await writeFile(outside, "outside", "utf8");
  await assert.rejects(
    () => prepareAttachments({ text: "read @../outside.txt", cwd: dir, confirm: approve(), env: {} }),
    (error) => error.code === "ATTACHMENT_OUTSIDE_CWD",
  );
});

test("symlinks are not followed unless explicitly enabled and approved", async (t) => {
  if (process.platform === "win32") {
    t.skip("symlink creation requires elevated privileges on Windows");
    return;
  }
  const dir = await workspace();
  await symlink(join(dir, "notes.txt"), join(dir, "link.txt"));
  await assert.rejects(
    () => prepareAttachments({ text: "read @link.txt", cwd: dir, confirm: approve(), env: {} }),
    (error) => error.code === "ATTACHMENT_SYMLINK",
  );
  const calls = [];
  const result = await prepareAttachments({
    text: "read @link.txt",
    cwd: dir,
    confirm: approve(calls),
    env: { CODERAX_ATTACHMENTS_FOLLOW_SYMLINKS: "1" },
  });
  assert.equal(result.files[0].content, "hello attachment\n");
  assert.equal(calls[0].symlinkTarget, await realpath(join(dir, "notes.txt")));
});

test("a symlink to a credential path is refused even when symlinks are enabled", async (t) => {
  if (process.platform === "win32") {
    t.skip("symlink creation requires elevated privileges on Windows");
    return;
  }
  const dir = await workspace();
  await symlink(join(dir, ".env"), join(dir, "link-env.txt"));
  await assert.rejects(
    () =>
      prepareAttachments({
        text: "read @link-env.txt",
        cwd: dir,
        confirm: approve(),
        env: { CODERAX_ATTACHMENTS_FOLLOW_SYMLINKS: "1" },
      }),
    (error) => error.code === "ATTACHMENT_SENSITIVE",
  );
});

test("binary and oversized files are refused", async () => {
  const dir = await workspace();
  await assert.rejects(
    () => prepareAttachments({ text: "read @binary.bin", cwd: dir, confirm: approve(), env: {} }),
    (error) => error.code === "ATTACHMENT_BINARY",
  );
  await assert.rejects(
    () => prepareAttachments({ text: "read @large.txt", cwd: dir, confirm: approve(), env: {} }),
    (error) => error.code === "ATTACHMENT_TOO_LARGE",
  );
});

test("email addresses are not file references", () => {
  assert.deepEqual(findAttachmentRefs("contact dev@example.com"), []);
  assert.equal(findAttachmentRefs("see @notes.txt").length, 1);
});

test("at most five files can be attached", async () => {
  const dir = await workspace();
  for (let index = 0; index < 6; index += 1) {
    await writeFile(join(dir, `file${index}.txt`), "x", "utf8");
  }
  await assert.rejects(
    () =>
      prepareAttachments({
        text: Array.from({ length: 6 }, (_, index) => `@file${index}.txt`).join(" "),
        cwd: dir,
        confirm: approve(),
        env: {},
      }),
    (error) => error.code === "ATTACHMENT_TOO_MANY",
  );
});

test("directories and missing files are refused", async () => {
  const dir = await workspace();
  await mkdir(join(dir, "nested"));
  await assert.rejects(
    () => prepareAttachments({ text: "read @nested", cwd: dir, confirm: approve(), env: {} }),
    (error) => error.code === "ATTACHMENT_NOT_A_FILE",
  );
  await assert.rejects(
    () => prepareAttachments({ text: "read @missing.txt", cwd: dir, confirm: approve(), env: {} }),
    (error) => error.code === "ATTACHMENT_NOT_FOUND",
  );
});
