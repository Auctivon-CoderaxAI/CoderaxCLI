import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  artifactPath,
  decodeBase64,
  encodeBase64,
  inspectFile,
  sha256Hex,
  writeArtifactBytes,
} from "../src/file-transfer.js";

const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n", "utf8");

async function workspace() {
  return mkdtemp(join(tmpdir(), "coderax-transfer-"));
}

test("inspectFile accepts a real PDF and rejects a mismatched extension", async () => {
  const cwd = await workspace();
  await writeFile(join(cwd, "document.pdf"), PDF);
  const inspected = await inspectFile("document.pdf", { cwd, mimeTypes: ["application/pdf"] });
  assert.equal(inspected.mimeType, "application/pdf");
  assert.equal(inspected.sha256, createHash("sha256").update(PDF).digest("hex"));
  assert.equal(inspected.bytes, PDF.length);

  await writeFile(join(cwd, "fake.png"), PDF);
  await assert.rejects(
    () => inspectFile("fake.png", { cwd, mimeTypes: ["image/png"] }),
    { code: "UPLOAD_TYPE_MISMATCH" },
  );
});

test("inspectFile refuses empty and oversized files", async () => {
  const cwd = await workspace();
  await writeFile(join(cwd, "empty.pdf"), "");
  await assert.rejects(() => inspectFile("empty.pdf", { cwd }), { code: "UPLOAD_EMPTY" });

  await writeFile(join(cwd, "big.pdf"), PDF);
  await assert.rejects(() => inspectFile("big.pdf", { cwd, maxBytes: 8 }), {
    code: "UPLOAD_TOO_LARGE",
  });
});

test("inspectFile refuses a symbolic link", async (t) => {
  if (process.platform === "win32") {
    t.skip("symlink creation needs a privileged account on Windows");
    return;
  }
  const cwd = await workspace();
  await writeFile(join(cwd, "real.pdf"), PDF);
  await symlink(join(cwd, "real.pdf"), join(cwd, "link.pdf"));
  await assert.rejects(() => inspectFile("link.pdf", { cwd }), { code: "UPLOAD_SYMLINK_REFUSED" });
});

test("base64 encode and decode round-trip and reject malformed input", () => {
  const encoded = encodeBase64(PDF);
  assert.deepEqual(decodeBase64(encoded), PDF);
  assert.throws(() => decodeBase64("not base64!!!"), { code: "ARTIFACT_CONTENT_INVALID" });
  assert.throws(() => decodeBase64(""), { code: "ARTIFACT_CONTENT_INVALID" });
  assert.throws(() => decodeBase64(encoded, { maxBytes: 4 }), { code: "ARTIFACT_TOO_LARGE" });
});

test("writeArtifactBytes refuses a digest mismatch and leaves no file", async () => {
  const cwd = await workspace();
  const destination = join(cwd, "artifact.bin");
  await assert.rejects(
    () =>
      writeArtifactBytes({
        destination,
        expectedSha256: `sha256:${"0".repeat(64)}`,
        expectedBytes: PDF.length,
        content: encodeBase64(PDF),
      }),
    { code: "ARTIFACT_INTEGRITY_FAILED" },
  );
  await assert.rejects(() => access(destination));
});

test("writeArtifactBytes writes verified bytes and honors force", async () => {
  const cwd = await workspace();
  const destination = join(cwd, "artifact.bin");
  await writeFile(destination, "old\n");

  const written = await writeArtifactBytes({
    destination,
    force: true,
    expectedSha256: `sha256:${sha256Hex(PDF)}`,
    expectedBytes: PDF.length,
    content: encodeBase64(PDF),
  });
  assert.equal(written.sha256, sha256Hex(PDF));
  assert.equal(written.bytes, PDF.length);

  await assert.rejects(
    () =>
      writeArtifactBytes({
        destination,
        expectedSha256: `sha256:${sha256Hex(PDF)}`,
        expectedBytes: PDF.length,
        content: encodeBase64(PDF),
      }),
    { code: "ARTIFACT_DESTINATION_EXISTS" },
  );
});

test("artifactPath never produces an absolute or traversing path", () => {
  assert.equal(artifactPath("report.pdf"), "report.pdf");
  assert.equal(artifactPath("../../etc/passwd"), "passwd");
  assert.equal(artifactPath("/tmp/escape.txt"), "escape.txt");
  assert.equal(artifactPath("nested/dir/report.pdf"), "report.pdf");
  assert.ok(!artifactPath("C:\\Windows\\evil.txt").includes(":"));
});
