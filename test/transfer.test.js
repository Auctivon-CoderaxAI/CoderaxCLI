import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildMultipart,
  detectFile,
  inspectFile,
  normalizeDigest,
  prepareDestination,
  safeArtifactName,
} from "../src/file-transfer.js";

async function workdir() {
  return mkdtemp(join(tmpdir(), "coderax-transfer-"));
}

test("detectFile recognises supported signatures and refuses unknown content", () => {
  assert.equal(detectFile(Buffer.from("%PDF-1.7\n")).mime, "application/pdf");
  assert.equal(detectFile(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])).mime, "image/png");
  assert.equal(detectFile(Buffer.from([0xff, 0xd8, 0xff, 0xe0])).mime, "image/jpeg");
  assert.equal(detectFile(Buffer.from("GIF89a...")).mime, "image/gif");
  assert.equal(detectFile(Buffer.from("ID3audio")).mime, "audio/mpeg");
  assert.equal(
    detectFile(Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from("webm")])).mime,
    "audio/webm",
  );
  assert.equal(detectFile(Buffer.from([0x00, 0x01, 0x02, 0x03])), null);
});

test("inspectFile enforces size, type and extension consistency before upload", async () => {
  const cwd = await workdir();
  const pdf = join(cwd, "sample.pdf");
  await writeFile(pdf, "%PDF-1.4\nhello\n");
  const inspected = await inspectFile(pdf, { mimeTypes: ["application/pdf"], cwd });
  assert.equal(inspected.mimeType, "application/pdf");
  assert.equal(inspected.name, "sample.pdf");
  assert.match(inspected.sha256, /^[a-f0-9]{64}$/);

  const tooLarge = join(cwd, "large.pdf");
  await writeFile(tooLarge, `%PDF-1.4\n${"x".repeat(100)}\n`);
  await assert.rejects(
    () => inspectFile(tooLarge, { maxBytes: 20, cwd }),
    (error) => error.code === "UPLOAD_TOO_LARGE",
  );

  const empty = join(cwd, "empty.pdf");
  await writeFile(empty, "");
  await assert.rejects(
    () => inspectFile(empty, { cwd }),
    (error) => error.code === "UPLOAD_EMPTY",
  );

  const disguised = join(cwd, "image.pdf");
  await writeFile(disguised, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  await assert.rejects(
    () => inspectFile(disguised, { cwd }),
    (error) => error.code === "UPLOAD_TYPE_MISMATCH",
  );

  const unsupported = join(cwd, "music.wav");
  await writeFile(unsupported, Buffer.from([0x00, 0x01, 0x02, 0x03]));
  await assert.rejects(
    () => inspectFile(unsupported, { cwd }),
    (error) => error.code === "UPLOAD_TYPE_MISMATCH" || error.code === "UPLOAD_TYPE_UNSUPPORTED",
  );

  const text = join(cwd, "notes.txt");
  await writeFile(text, "plain text\n");
  await assert.rejects(
    () => inspectFile(text, { mimeTypes: ["application/pdf"], cwd }),
    (error) => error.code === "UPLOAD_TYPE_NOT_ACCEPTED",
  );
});

test("audio containers are not accepted just because they share an ftyp box", async () => {
  const cwd = await workdir();
  const ftyp = Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x18]),
    Buffer.from("ftypM4A ", "latin1"),
    Buffer.from("isommp42", "latin1"),
  ]);
  const m4a = join(cwd, "clip.m4a");
  await writeFile(m4a, ftyp);
  const inspected = await inspectFile(m4a, { mimeTypes: ["audio/mp4"], cwd });
  assert.equal(inspected.mimeType, "audio/mp4");

  const mp4 = join(cwd, "clip.mp4");
  await writeFile(mp4, ftyp);
  await assert.rejects(
    () => inspectFile(mp4, { mimeTypes: ["audio/mp4"], cwd }),
    (error) => error.code === "UPLOAD_TYPE_MISMATCH",
  );
});

test("buildMultipart carries the exact bytes and does not allow header injection", async () => {
  const cwd = await workdir();
  const pdf = join(cwd, "sample.pdf");
  await writeFile(pdf, "%PDF-1.4\npayload\n");
  const inspected = await inspectFile(pdf, { cwd });
  const { body, contentType } = buildMultipart({
    file: inspected,
    fields: { sha256: inspected.sha256, projectId: "proj_alpha" },
  });
  assert.match(contentType, /^multipart\/form-data; boundary=----coderax-[a-f0-9]{32}$/);
  assert.equal(body.includes(inspected.buffer), true);
  assert.equal(body.toString("utf8").includes(`name="sha256"`), true);
  assert.equal(body.toString("utf8").includes("proj_alpha"), true);
  assert.throws(
    () => buildMultipart({ file: inspected, fields: { "bad\r\nname": "x" } }),
    (error) => error.code === "UPLOAD_FIELD_INVALID",
  );
});

test("digest parsing accepts the published forms and rejects anything else", () => {
  const digest = "a".repeat(64);
  assert.equal(normalizeDigest(digest), digest);
  assert.equal(normalizeDigest(`sha256:${digest.toUpperCase()}`), digest);
  assert.equal(normalizeDigest("sha512:abc"), null);
  assert.equal(normalizeDigest(undefined), null);
});

test("download destinations never default to overwriting and reject symlinks", async () => {
  const cwd = await workdir();
  const first = await prepareDestination({ defaultName: "../secret.pdf", cwd });
  assert.equal(first.destination, join(cwd, "secret.pdf"));
  assert.equal(first.existing, false);

  await writeFile(join(cwd, "report.pdf"), "keep");
  await assert.rejects(
    () => prepareDestination({ defaultName: "report.pdf", cwd }),
    (error) => error.code === "ARTIFACT_DESTINATION_EXISTS",
  );
  const forced = await prepareDestination({ defaultName: "report.pdf", cwd, force: true });
  assert.equal(forced.existing, true);

  await assert.rejects(
    () => prepareDestination({ out: "-", cwd }),
    (error) => error.code === "ARTIFACT_DESTINATION_INVALID",
  );

  assert.equal(safeArtifactName("../../etc/passwd"), "passwd");
  assert.equal(safeArtifactName(".."), "artifact.bin");
});
