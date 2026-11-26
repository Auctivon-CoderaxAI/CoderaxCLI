import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli.js";
import {
  defaultRegistry,
  digestOf,
  pdfBytes,
  startHarness,
} from "./support/workflow-harness.js";

function capture() {
  const out = [];
  const err = [];
  return {
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

async function run(harness, argv, options = {}) {
  const io = capture();
  const directory = await mkdtemp(join(tmpdir(), "coderax-art-"));
  const cwd = options.cwd ?? (await mkdtemp(join(tmpdir(), "coderax-work-")));
  const code = await runCli(argv, {
    env: {
      CODERAX_CONFIG: join(directory, "config.json"),
      CODERAX_BASE_URL: harness.url,
      CODERAX_TOKEN: harness.token,
      CODERAX_TIMEOUT_MS: "5000",
      ...(options.env ?? {}),
    },
    stdout: io.stdout,
    stderr: io.stderr,
    stdinIsTTY: false,
    cwd,
    signal: options.signal,
  });
  return { code, out: io.out(), err: io.err(), cwd };
}

function artifactSet() {
  const pdf = pdfBytes("download me");
  return [
    {
      artifactId: "art_report",
      name: "report.pdf",
      path: "artifacts/report.pdf",
      mimeType: "application/pdf",
      content: pdf,
      projectId: "proj_alpha",
      conversationId: "conv_alpha",
      taskId: "task_alpha",
    },
    {
      artifactId: "art_speech",
      name: "speech.mp3",
      path: "artifacts/speech.mp3",
      mimeType: "audio/mpeg",
      content: Buffer.from("ID3harness-speech", "utf8"),
      projectId: null,
      conversationId: "conv_alpha",
    },
  ];
}

test("artifacts list, inspect and associate use the owner-scoped engine catalog", async () => {
  const harness = await startHarness({ artifacts: artifactSet() });
  try {
    const list = await run(harness, ["artifacts", "list", "--json"]);
    assert.equal(list.code, 0, list.err);
    assert.deepEqual(
      JSON.parse(list.out).artifacts.map((artifact) => artifact.artifactId),
      ["art_report", "art_speech"],
    );

    const filtered = await run(harness, ["artifacts", "list", "--project", "proj_alpha", "--json"]);
    assert.equal(filtered.code, 0, filtered.err);
    assert.deepEqual(
      JSON.parse(filtered.out).artifacts.map((artifact) => artifact.artifactId),
      ["art_report"],
    );

    const inspected = await run(harness, ["artifacts", "inspect", "art_report", "--json"]);
    assert.equal(inspected.code, 0, inspected.err);
    const metadata = JSON.parse(inspected.out);
    assert.equal(metadata.name, "report.pdf");
    assert.equal(metadata.bytes, pdfBytes("download me").length);

    const associated = await run(harness, [
      "artifacts",
      "associate",
      "art_speech",
      "--project",
      "proj_alpha",
      "--json",
    ]);
    assert.equal(associated.code, 0, associated.err);
    assert.equal(JSON.parse(associated.out).projectId, "proj_alpha");

    const human = await run(harness, ["artifacts", "list"]);
    assert.equal(human.code, 0);
    assert.match(human.out, /ARTIFACT\s+NAME\s+SIZE\s+PROJECT\s+CREATED/);
  } finally {
    await harness.close();
  }
});

test("artifact download verifies the published SHA-256 and never overwrites by default", async () => {
  const artifacts = artifactSet();
  const harness = await startHarness({ artifacts });
  try {
    const cwd = await mkdtemp(join(tmpdir(), "coderax-work-"));
    const destination = join(cwd, "report.pdf");

    const first = await run(harness, ["artifacts", "download", "art_report", "--out", destination, "--json"], { cwd });
    assert.equal(first.code, 0, first.err);
    const body = JSON.parse(first.out);
    assert.equal(body.verified, true);
    assert.equal(body.bytes, artifacts[0].content.length);
    assert.equal(body.sha256, digestOf(artifacts[0].content));
    assert.deepEqual(await readFile(destination), artifacts[0].content);

    const before = await readFile(destination);
    const second = await run(harness, ["artifacts", "download", "art_report", "--out", destination], { cwd });
    assert.equal(second.code, 2);
    assert.match(second.err, /already exists/);
    assert.deepEqual(await readFile(destination), before);

    const explicitFalse = await run(
      harness,
      ["artifacts", "download", "art_report", "--out", destination, "--force=false"],
      { cwd },
    );
    assert.equal(explicitFalse.code, 2);
    assert.deepEqual(await readFile(destination), before);

    const forced = await run(
      harness,
      ["artifacts", "download", "art_report", "--out", destination, "--force", "--json"],
      { cwd },
    );
    assert.equal(forced.code, 0, forced.err);
    assert.deepEqual(await readFile(destination), before);
  } finally {
    await harness.close();
  }
});

test("a tampered artifact is deleted and reported as an integrity failure", async () => {
  const good = pdfBytes("good");
  const harness = await startHarness({
    artifacts: [
      {
        artifactId: "art_tampered",
        name: "tampered.pdf",
        path: "artifacts/tampered.pdf",
        mimeType: "application/pdf",
        content: good,
        corrupt: true,
      },
    ],
  });
  try {
    const cwd = await mkdtemp(join(tmpdir(), "coderax-work-"));
    const destination = join(cwd, "tampered.pdf");
    const result = await run(harness, ["artifacts", "download", "art_tampered", "--out", destination], { cwd });
    assert.equal(result.code, 1);
    assert.match(result.err, /did not match its published SHA-256/);
    assert.equal(existsSync(destination), false);
  } finally {
    await harness.close();
  }
});

test("download destinations are validated: no directories, no traversal, no symlinks", async (t) => {
  const harness = await startHarness({ artifacts: artifactSet() });
  try {
    const cwd = await mkdtemp(join(tmpdir(), "coderax-work-"));

    const traversal = await run(harness, ["artifacts", "inspect", "../secret"], { cwd });
    assert.equal(traversal.code, 2);
    assert.match(traversal.err, /invalid artifact id/);

    const missingParent = await run(
      harness,
      ["artifacts", "download", "art_report", "--out", join(cwd, "missing", "report.pdf")],
      { cwd },
    );
    assert.equal(missingParent.code, 2);
    assert.match(missingParent.err, /destination directory/);

    const asDirectory = await run(harness, ["artifacts", "download", "art_report", "--out", cwd], { cwd });
    assert.equal(asDirectory.code, 2);
    assert.match(asDirectory.err, /directory/);

    const target = join(cwd, "target.pdf");
    await writeFile(target, "keep me");
    const link = join(cwd, "link.pdf");
    try {
      await symlink(target, link);
    } catch {
      t.skip("symbolic links are not available for this user on this platform");
      return;
    }
    const throughLink = await run(harness, ["artifacts", "download", "art_report", "--out", link], { cwd });
    assert.equal(throughLink.code, 2);
    assert.match(throughLink.err, /symbolic link/);
    assert.equal(await readFile(target, "utf8"), "keep me");
  } finally {
    await harness.close();
  }
});

test("text-to-speech generates remotely and downloads only on explicit --out", async () => {
  const harness = await startHarness({ artifacts: [artifactSet()[1]] });
  try {
    const cwd = await mkdtemp(join(tmpdir(), "coderax-work-"));
    const destination = join(cwd, "speech.mp3");
    const result = await run(
      harness,
      ["speak", "hello from the terminal", "--voice", "owner-voice", "--out", destination, "--json"],
      { cwd },
    );
    assert.equal(result.code, 0, result.err);
    const body = JSON.parse(result.out);
    assert.equal(body.capability.id, "audio.speech");
    assert.equal(body.state, "completed");
    assert.equal(existsSync(destination), true);
    assert.deepEqual(await readFile(destination), artifactSet()[1].content);

    const task = [...harness.tasks.values()][0];
    assert.equal(task.inputs.text, "hello from the terminal");
    assert.equal(task.inputs.voice, "owner-voice");
    assert.equal(task.inputs.format, "mp3");
  } finally {
    await harness.close();
  }
});

test("artifacts are refused when the registry does not publish artifact operations", async () => {
  const registry = defaultRegistry({
    artifacts: { status: "blocked", reason: "artifacts_not_published", detail: "no artifact store yet" },
  });
  const harness = await startHarness({ registry });
  try {
    const result = await run(harness, ["artifacts", "list"]);
    assert.equal(result.code, 6);
    assert.match(result.err, /artifacts are blocked/);
    assert.equal(harness.requests.some((request) => request.path === "/v1/artifacts"), false);
  } finally {
    await harness.close();
  }
});
