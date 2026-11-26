import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli.js";
import {
  OWNER_TOKEN,
  defaultRegistry,
  pdfBytes,
  pngBytes,
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

async function environment(harness, cwd) {
  const directory = await mkdtemp(join(tmpdir(), "coderax-cap-"));
  const workdir = cwd ?? (await mkdtemp(join(tmpdir(), "coderax-work-")));
  return {
    env: {
      CODERAX_CONFIG: join(directory, "config.json"),
      CODERAX_BASE_URL: harness.url,
      CODERAX_TOKEN: harness.token ?? OWNER_TOKEN,
      CODERAX_TIMEOUT_MS: "5000",
    },
    cwd: workdir,
  };
}

async function run(harness, argv, options = {}) {
  const io = capture();
  const { env, cwd } = await environment(harness, options.cwd);
  const code = await runCli(argv, {
    env: { ...env, ...(options.env ?? {}) },
    stdout: io.stdout,
    stderr: io.stderr,
    stdinIsTTY: options.stdinIsTTY ?? false,
    readSecret: options.readSecret,
    cwd,
    signal: options.signal,
  });
  return { code, out: io.out(), err: io.err(), cwd };
}

test("capabilities reports every proposed command with an explicit status", async () => {
  const harness = await startHarness();
  try {
    const human = await run(harness, ["capabilities"]);
    assert.equal(human.code, 0);
    assert.match(human.out, /CAPABILITY\s+COMMAND\s+STATUS\s+DETAIL/);
    assert.match(human.out, /PDF analysis\s+analyze-pdf\s+available/);
    assert.match(human.out, /11\/11 capabilities are available/);

    const machine = await run(harness, ["capabilities", "--json"]);
    assert.equal(machine.code, 0);
    const body = JSON.parse(machine.out);
    assert.equal(body.published, true);
    assert.equal(body.contractVersion, "1.0.0");
    assert.equal(body.capabilities.length, 11);
    assert.equal(body.capabilities.find((item) => item.command === "analyze-pdf").status, "available");
    assert.equal(body.artifacts.status, "available");
  } finally {
    await harness.close();
  }
});

test("capabilities never promotes an unavailable, unconfigured, unverified or blocked entry", async () => {
  const registry = defaultRegistry({
    capabilities: defaultRegistry().capabilities.map((entry) => {
      if (entry.command === "analyze-pdf") {
        return { ...entry, status: "unconfigured", reason: "not_configured", detail: "PDF_ENGINE_URL is not set" };
      }
      if (entry.command === "generate-image") {
        return { ...entry, status: "unverified", reason: "not_verified", detail: "no generation run was verified" };
      }
      if (entry.command === "create-game") {
        return { ...entry, status: "blocked", reason: "executor_missing", detail: "no verified cloud executor" };
      }
      if (entry.command === "speak") {
        return { ...entry, status: "unavailable", reason: "server_unavailable", detail: "speech service is down" };
      }
      return entry;
    }),
  });
  const harness = await startHarness({ registry });
  try {
    const machine = await run(harness, ["capabilities", "--json"]);
    const body = JSON.parse(machine.out);
    const states = Object.fromEntries(body.capabilities.map((item) => [item.command, item.status]));
    assert.equal(states["analyze-pdf"], "unconfigured");
    assert.equal(states["generate-image"], "unverified");
    assert.equal(states["create-game"], "blocked");
    assert.equal(states.speak, "unavailable");

    const filtered = await run(harness, ["capabilities", "--status", "unconfigured", "--json"]);
    assert.deepEqual(
      JSON.parse(filtered.out).capabilities.map((item) => item.command),
      ["analyze-pdf"],
    );

    const blocked = await run(harness, ["generate-image", "a lighthouse"]);
    assert.equal(blocked.code, 6);
    assert.match(blocked.err, /generate-image is unverified/);
    assert.equal(harness.requests.some((request) => request.path.endsWith("/execute")), false);
  } finally {
    await harness.close();
  }
});

test("a missing capability registry blocks every command and never fakes readiness", async () => {
  const harness = await startHarness({ registry: null });
  try {
    const discovery = await run(harness, ["capabilities", "--json"]);
    assert.equal(discovery.code, 6);
    const body = JSON.parse(discovery.out);
    assert.equal(body.published, false);
    assert.equal(body.source, "unpublished");
    assert.equal(body.capabilities.every((item) => item.status === "blocked"), true);

    const workdir = await mkdtemp(join(tmpdir(), "coderax-work-"));
    const file = join(workdir, "sample.pdf");
    await writeFile(file, pdfBytes());
    const execute = await run(harness, ["analyze-pdf", file, "--json"], { cwd: workdir });
    assert.equal(execute.code, 6);
    assert.match(execute.err, /blocked \(capability_registry_missing\)/);
    assert.equal(harness.requests.some((request) => request.path === "/v1/files"), false);
  } finally {
    await harness.close();
  }
});

test("an incompatible capability contract is refused instead of guessed", async () => {
  const harness = await startHarness({
    registry: defaultRegistry({ contractVersion: "2.0.0" }),
  });
  try {
    const result = await run(harness, ["capabilities", "--json"]);
    assert.equal(result.code, 1);
    assert.match(result.err, /capability contract is 2\.0\.0/);
    assert.equal(result.out.includes("available"), false);
  } finally {
    await harness.close();
  }
});

test("command options come from the engine registry and unknown options are refused", async () => {
  const registry = defaultRegistry({
    capabilities: defaultRegistry().capabilities.map((entry) =>
      entry.command === "analyze-pdf"
        ? {
            ...entry,
            inputs: [
              {
                name: "file",
                type: "file",
                required: true,
                description: "PDF to analyze",
                mimeTypes: ["application/pdf"],
                maxBytes: 1024 * 1024,
              },
              { name: "question", type: "text", required: false, description: "Question" },
              {
                name: "tone",
                type: "enum",
                required: false,
                description: "Answer tone",
                values: ["brief", "detailed"],
                default: "brief",
              },
            ],
          }
        : entry,
    ),
  });
  const harness = await startHarness({ registry });
  try {
    const workdir = await mkdtemp(join(tmpdir(), "coderax-work-"));
    const file = join(workdir, "sample.pdf");
    await writeFile(file, pdfBytes());

    const accepted = await run(
      harness,
      ["analyze-pdf", file, "--question", "What changed?", "--tone", "detailed", "--json"],
      { cwd: workdir },
    );
    assert.equal(accepted.code, 0, accepted.err);
    assert.equal(JSON.parse(accepted.out).state, "completed");
    const executeRequest = harness.requests.find((request) => request.path.includes("/execute"));
    assert.ok(executeRequest);

    const rejected = await run(harness, ["analyze-pdf", file, "--bogus", "value"], { cwd: workdir });
    assert.equal(rejected.code, 2);
    assert.match(rejected.err, /unknown option/);
    assert.match(rejected.err, /tone/);

    const invalidEnum = await run(harness, ["analyze-pdf", file, "--tone", "verbose"], { cwd: workdir });
    assert.equal(invalidEnum.code, 2);
    assert.match(invalidEnum.err, /--tone must be one of: brief, detailed/);
  } finally {
    await harness.close();
  }
});

test("a capability uploads, executes and waits for the durable task", async () => {
  const harness = await startHarness();
  try {
    const workdir = await mkdtemp(join(tmpdir(), "coderax-work-"));
    const file = join(workdir, "sample.pdf");
    await writeFile(file, pdfBytes("owner document"));

    const result = await run(harness, ["analyze-pdf", file, "--question", "summarize", "--json"], { cwd: workdir });
    assert.equal(result.code, 0, result.err);
    const body = JSON.parse(result.out);
    assert.equal(body.capability.id, "pdf.analyze");
    assert.equal(body.state, "completed");
    assert.equal(body.result.artifacts[0].path, "artifacts/result.pdf");

    assert.equal(harness.uploads.size, 1);
    const [upload] = harness.uploads.values();
    assert.equal(upload.name, "sample.pdf");
    assert.equal(upload.mimeType, "application/pdf");
    assert.equal(upload.body.subarray(0, 5).toString("latin1"), "%PDF-");

    const executeRequest = harness.requests.find((request) => request.path === "/v1/capabilities/pdf.analyze/execute");
    assert.ok(executeRequest);
    const task = [...harness.tasks.values()][0];
    assert.equal(task.inputs.question, "summarize");
    assert.equal(task.inputs.file.uploadId, upload.uploadId);
    assert.equal(task.inputs.file.sha256, upload.sha256);
  } finally {
    await harness.close();
  }
});

test("--no-wait returns the accepted durable task without polling", async () => {
  const harness = await startHarness();
  try {
    const result = await run(harness, ["generate-image", "a paper lighthouse", "--no-wait", "--json"]);
    assert.equal(result.code, 0, result.err);
    const body = JSON.parse(result.out);
    assert.equal(body.state, "queued");
    assert.match(body.taskId, /^task_/);
    assert.equal(harness.state.taskReads, 0);
  } finally {
    await harness.close();
  }
});

test("--stream --json emits ordered events and a final result without duplicating them", async () => {
  const harness = await startHarness();
  try {
    const result = await run(harness, ["create-game", "a small puzzle game", "--stream", "--json"]);
    assert.equal(result.code, 0, result.err);
    const lines = result.out.trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(lines[0].type, "event");
    assert.equal(lines[0].event.type, "task.queued");
    assert.ok(lines.some((line) => line.type === "event" && line.event.type === "step.started"));
    assert.equal(lines.at(-1).type, "result");
    assert.equal(lines.at(-1).state, "completed");
    const seqs = lines.filter((line) => line.type === "event").map((line) => line.event.seq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  } finally {
    await harness.close();
  }
});

test("a failed task is a meaningful failure, not a success with empty output", async () => {
  const harness = await startHarness({
    events: false,
    behavior: { "pdf.analyze": { fail: true } },
  });
  try {
    const workdir = await mkdtemp(join(tmpdir(), "coderax-work-"));
    const file = join(workdir, "sample.pdf");
    await writeFile(file, pdfBytes());
    const result = await run(harness, ["analyze-pdf", file], { cwd: workdir });
    assert.equal(result.code, 1);
    assert.match(result.err, /CAPABILITY_TASK_FAILED/);
    assert.match(result.err, /provider_error/);
  } finally {
    await harness.close();
  }
});

test("the registry's upload limit is enforced before any transfer", async () => {
  const registry = defaultRegistry({
    capabilities: defaultRegistry().capabilities.map((entry) =>
      entry.command === "analyze-pdf"
        ? {
            ...entry,
            inputs: [
              {
                name: "file",
                type: "file",
                required: true,
                description: "PDF",
                mimeTypes: ["application/pdf"],
                maxBytes: 20,
              },
            ],
          }
        : entry,
    ),
  });
  const harness = await startHarness({ registry });
  try {
    const workdir = await mkdtemp(join(tmpdir(), "coderax-work-"));
    const file = join(workdir, "sample.pdf");
    await writeFile(file, `%PDF-1.4\n${"x".repeat(100)}\n`);
    const result = await run(harness, ["analyze-pdf", file], { cwd: workdir });
    assert.equal(result.code, 2);
    assert.match(result.err, /limit for this input is 20 bytes/);
    assert.equal(harness.requests.some((request) => request.path === "/v1/files"), false);
  } finally {
    await harness.close();
  }
});

test("an engine that does not echo the uploaded digest aborts before execution", async () => {
  const harness = await startHarness({ corruptUploadEcho: true });
  try {
    const workdir = await mkdtemp(join(tmpdir(), "coderax-work-"));
    const file = join(workdir, "sample.pdf");
    await writeFile(file, pdfBytes());
    const result = await run(harness, ["analyze-pdf", file], { cwd: workdir });
    assert.equal(result.code, 1);
    assert.match(result.err, /UPLOAD_INTEGRITY_FAILED/);
    assert.equal(harness.tasks.size, 0);
  } finally {
    await harness.close();
  }
});

test("a local wait timeout stops waiting but leaves the durable task running", async () => {
  const harness = await startHarness({
    events: false,
    behavior: { "game.create": { pollsBeforeComplete: 999 } },
  });
  try {
    const result = await run(harness, ["create-game", "a slow game", "--wait-timeout", "1000", "--json"]);
    assert.equal(result.code, 1);
    assert.match(result.err, /WAIT_TIMEOUT/);
    const task = [...harness.tasks.values()][0];
    assert.equal(task.state, "queued");
    assert.match(result.err, new RegExp(task.taskId));
  } finally {
    await harness.close();
  }
});

test("an invalid project reference fails before any file is uploaded", async () => {
  const harness = await startHarness();
  try {
    const workdir = await mkdtemp(join(tmpdir(), "coderax-work-"));
    const file = join(workdir, "sample.pdf");
    await writeFile(file, pdfBytes());
    const result = await run(harness, ["analyze-pdf", file, "--project", "../escape"], { cwd: workdir });
    assert.equal(result.code, 2);
    assert.match(result.err, /invalid project id/);
    assert.equal(harness.uploads.size, 0);
  } finally {
    await harness.close();
  }
});

test("--force without --out is a usage error rather than a silent no-op", async () => {
  const harness = await startHarness();
  try {
    const result = await run(harness, ["speak", "hello", "--force"]);
    assert.equal(result.code, 2);
    assert.match(result.err, /--force requires --out/);
    assert.equal(harness.tasks.size, 0);
  } finally {
    await harness.close();
  }
});

test("upload validates the file before it leaves the machine", async () => {
  const harness = await startHarness();
  try {
    const workdir = await mkdtemp(join(tmpdir(), "coderax-work-"));
    const disguised = join(workdir, "not-a.pdf");
    await writeFile(disguised, pngBytes());

    const mismatch = await run(harness, ["upload", disguised, "--json"], { cwd: workdir });
    assert.equal(mismatch.code, 2);
    assert.match(mismatch.err, /do not match its \.pdf extension/);
    assert.equal(harness.requests.some((request) => request.path === "/v1/files"), false);

    const missing = await run(harness, ["upload", join(workdir, "missing.pdf")], { cwd: workdir });
    assert.equal(missing.code, 2);
    assert.match(missing.err, /file does not exist/);
  } finally {
    await harness.close();
  }
});

test("a non-interactive prompt can be piped on stdin", async () => {
  const harness = await startHarness();
  try {
    const result = await run(harness, ["create-presentation", "--json"], {
      readSecret: async () => "quarterly review",
    });
    assert.equal(result.code, 0, result.err);
    const task = [...harness.tasks.values()][0];
    assert.equal(task.inputs.prompt, "quarterly review");
    assert.equal(task.inputs.format, "pptx");
  } finally {
    await harness.close();
  }
});

test("readiness exposes engine and capability state truthfully", async () => {
  const registry = defaultRegistry({
    capabilities: defaultRegistry().capabilities.map((entry) =>
      entry.command === "speak" ? { ...entry, status: "unconfigured", reason: "not_configured", detail: "voice not selected" } : entry,
    ),
  });
  const harness = await startHarness({ registry });
  try {
    const result = await run(harness, ["readiness", "--json"]);
    assert.equal(result.code, 0);
    const body = JSON.parse(result.out);
    assert.equal(body.ready, true);
    assert.equal(body.capabilities.available, 10);
    assert.equal(body.capabilities.total, 11);
    assert.equal(body.capabilities.items.find((item) => item.command === "speak").status, "unconfigured");
  } finally {
    await harness.close();
  }

  const notReady = await startHarness({ ready: false, missing: ["mongo"] });
  try {
    const result = await run(notReady, ["readiness", "--json"]);
    assert.equal(result.code, 6);
    assert.deepEqual(JSON.parse(result.out).missing, ["mongo"]);
  } finally {
    await notReady.close();
  }
});

test("an unknown status filter is a usage error, not an empty success", async () => {
  const harness = await startHarness();
  try {
    const result = await run(harness, ["capabilities", "--status", "maybe"]);
    assert.equal(result.code, 2);
    assert.match(result.err, /--status must be one of/);
  } finally {
    await harness.close();
  }
});

test("server-provided capability text is redacted in human and JSON output", async () => {
  const registry = defaultRegistry({
    capabilities: defaultRegistry().capabilities.map((entry) =>
      entry.command === "analyze-pdf"
        ? { ...entry, detail: `misconfigured with ${OWNER_TOKEN}`, reason: `reason-${OWNER_TOKEN}` }
        : entry,
    ),
  });
  const harness = await startHarness({ registry });
  try {
    const human = await run(harness, ["capabilities"]);
    assert.equal(human.code, 0);
    assert.equal(human.out.includes(OWNER_TOKEN), false);
    assert.match(human.out, /REDACTED/);

    const machine = await run(harness, ["capabilities", "--json"]);
    assert.equal(machine.out.includes(OWNER_TOKEN), false);
  } finally {
    await harness.close();
  }
});

test("readiness does not claim readiness when no capability registry is published", async () => {
  const harness = await startHarness({ registry: null });
  try {
    const result = await run(harness, ["readiness", "--json"]);
    assert.equal(result.code, 6);
    const body = JSON.parse(result.out);
    assert.equal(body.ready, true);
    assert.equal(body.capabilities.available, 0);
    assert.equal(body.artifacts.status, "blocked");
  } finally {
    await harness.close();
  }
});

test("an authentication failure is typed and never echoes the token", async () => {
  const harness = await startHarness();
  try {
    const io = capture();
    const directory = await mkdtemp(join(tmpdir(), "coderax-cap-"));
    const code = await runCli(["capabilities", "--json"], {
      env: {
        CODERAX_CONFIG: join(directory, "config.json"),
        CODERAX_BASE_URL: harness.url,
        CODERAX_TOKEN: "wrong-owner-token",
      },
      stdout: io.stdout,
      stderr: io.stderr,
      stdinIsTTY: false,
    });
    assert.equal(code, 3);
    assert.match(io.err(), /HTTP 401/);
    assert.equal(io.out().includes("wrong-owner-token"), false);
    assert.equal(io.err().includes("wrong-owner-token"), false);
  } finally {
    await harness.close();
  }
});

test("help lists the capability commands and explains a single command", async () => {
  const harness = await startHarness();
  try {
    const overview = await run(harness, ["--help"]);
    assert.equal(overview.code, 0);
    assert.match(overview.out, /coderax analyze-pdf/);
    assert.match(overview.out, /capability registry/);

    const command = await run(harness, ["analyze-pdf", "--help"]);
    assert.equal(command.code, 0);
    assert.match(command.out, /Analyze a PDF in the cloud/);
  } finally {
    await harness.close();
  }
});

test("every proposed capability command maps to its engine capability", async () => {
  const harness = await startHarness();
  try {
    const workdir = await mkdtemp(join(tmpdir(), "coderax-work-"));
    await writeFile(join(workdir, "notes.txt"), "owner notes\n");
    await writeFile(join(workdir, "sample.pdf"), pdfBytes());
    await writeFile(join(workdir, "data.csv"), "a,b\n1,2\n");
    await writeFile(join(workdir, "image.png"), pngBytes());
    await writeFile(join(workdir, "audio.wav"), Buffer.concat([
      Buffer.from("RIFF", "latin1"),
      Buffer.alloc(4),
      Buffer.from("WAVEfmt ", "latin1"),
      Buffer.alloc(24),
    ]));

    const cases = [
      { argv: ["analyze-document", "notes.txt"], id: "document.analyze" },
      { argv: ["analyze-pdf", "sample.pdf"], id: "pdf.analyze" },
      { argv: ["analyze-spreadsheet", "data.csv"], id: "spreadsheet.analyze" },
      { argv: ["create-presentation", "quarterly review", "--format", "pdf"], id: "presentation.create" },
      { argv: ["understand-image", "image.png", "--question", "what is this?"], id: "image.understand" },
      { argv: ["generate-image", "a paper lighthouse", "--size", "512x512", "--count", "1"], id: "image.generate" },
      { argv: ["transcribe", "audio.wav", "--language", "en", "--format", "srt"], id: "audio.transcribe" },
      { argv: ["speak", "hello there", "--format", "wav"], id: "audio.speech" },
      { argv: ["create-software", "a small tool", "--name", "tool", "--project", "proj_alpha"], id: "software.create" },
      { argv: ["create-game", "a small game"], id: "game.create" },
    ];

    for (const item of cases) {
      const result = await run(harness, [...item.argv, "--json"], { cwd: workdir });
      assert.equal(result.code, 0, `${item.argv[0]}: ${result.err}`);
      const body = JSON.parse(result.out);
      assert.equal(body.capability.id, item.id, item.argv[0]);
      assert.equal(body.state, "completed", item.argv[0]);
    }

    const tasks = [...harness.tasks.values()];
    assert.equal(tasks.length, cases.length);
    const software = tasks.find((task) => task.capabilityId === "software.create");
    assert.equal(software.projectId, "proj_alpha");
    const presentation = tasks.find((task) => task.capabilityId === "presentation.create");
    assert.equal(presentation.inputs.format, "pdf");
    const transcription = tasks.find((task) => task.capabilityId === "audio.transcribe");
    assert.equal(transcription.inputs.language, "en");
    assert.equal(transcription.inputs.format, "srt");
    assert.equal(transcription.inputs.file.uploadId.startsWith("upl_"), true);
  } finally {
    await harness.close();
  }
});

test("a registry-only capability can be discovered and run generically", async () => {
  const registry = defaultRegistry();
  registry.capabilities = [
    ...registry.capabilities,
    {
      id: "video.render",
      command: "render-video",
      title: "Video rendering",
      status: "available",
      reason: "ready",
      detail: "",
      inputs: [{ name: "prompt", type: "text", required: true, description: "Video prompt" }],
    },
  ];
  const harness = await startHarness({ registry });
  try {
    const discovery = await run(harness, ["capabilities", "--json"]);
    const body = JSON.parse(discovery.out);
    assert.equal(body.capabilities.length, 12);
    const extra = body.capabilities.find((item) => item.id === "video.render");
    assert.equal(extra.command, "render-video");
    assert.deepEqual(extra.options.map((option) => option.name), ["prompt"]);

    const result = await run(harness, ["capability", "run", "render-video", "a sunrise", "--json"]);
    assert.equal(result.code, 0, result.err);
    assert.equal(JSON.parse(result.out).capability.id, "video.render");
  } finally {
    await harness.close();
  }
});

test("a capability that needs an owner permission decision is reported, not retried silently", async () => {
  const harness = await startHarness({
    behavior: { "software.create": { permissionRequired: true } },
  });
  try {
    const result = await run(harness, ["create-software", "a tool"]);
    assert.equal(result.code, 1);
    assert.match(result.err, /permission_required/);
    assert.match(result.err, /owner must approve/);
    assert.equal(harness.tasks.size, 0);
  } finally {
    await harness.close();
  }
});

test("the uploaded bytes match the digest the engine acknowledges", async () => {
  const harness = await startHarness();
  try {
    const workdir = await mkdtemp(join(tmpdir(), "coderax-work-"));
    const file = join(workdir, "notes.txt");
    await writeFile(file, "owner notes\n");
    const result = await run(harness, ["upload", file, "--json"], { cwd: workdir });
    assert.equal(result.code, 0, result.err);
    const body = JSON.parse(result.out);
    assert.equal(body.upload.name, "notes.txt");
    assert.equal(body.upload.bytes, (await readFile(file)).length);
    assert.match(body.upload.sha256, /^[a-f0-9]{64}$/);
  } finally {
    await harness.close();
  }
});
