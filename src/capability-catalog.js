/**
 * Capability command catalogue.
 *
 * This file is UX metadata only: command names, the objective template, the
 * inputs the owner may supply and which authoritative backend features the
 * family needs. It contains no provider, inference, artifact-generation or
 * execution logic, and it is not a capability registry: the engine's
 * `/v1/handshake` is authoritative for what exists and whether it can run.
 *
 * A family listed here is never advertised as operational on the strength of
 * this file. `capability-registry.js` resolves each family against the live
 * handshake and reports `available`, `unconfigured`, `unverified`, `unavailable`,
 * `blocked` or `not_implemented`.
 */

export const CAPABILITY_STATES = Object.freeze({
  available: "available",
  unconfigured: "unconfigured",
  unverified: "unverified",
  unavailable: "unavailable",
  blocked: "blocked",
  notImplemented: "not_implemented",
});

export const STATE_LABELS = Object.freeze({
  available: "available",
  unconfigured: "unconfigured",
  unverified: "unverified",
  unavailable: "unavailable",
  blocked: "blocked",
  not_implemented: "not implemented",
});

/** Only a family the engine currently reports as available may execute. */
export const EXECUTABLE_STATE = CAPABILITY_STATES.available;

/**
 * Contract 1.1.0 caps one artifact request at 700,000 base64 characters and the
 * HTTP body at 1 MiB. 512 KiB of file encodes to 699,052 characters, so it fits
 * both bounds with the JSON envelope left over.
 */
export const MAX_ARTIFACT_BYTES = 512 * 1024;

/** A stored artifact may be read back up to the engine's 1 MiB artifact limit. */
export const MAX_ARTIFACT_DOWNLOAD_BYTES = 1024 * 1024;

/** Contract 1.1.0 `ArtifactPath`: relative, no traversal, no drive letter. */
export const MAX_ARTIFACT_PATH = 1024;

const PDF = "application/pdf";
const DOCUMENT = Object.freeze([
  PDF,
  "text/plain",
  "text/markdown",
  "application/rtf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.oasis.opendocument.text",
]);
const SPREADSHEET = Object.freeze([
  "text/csv",
  "text/tab-separated-values",
  "application/json",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.oasis.opendocument.spreadsheet",
]);
const IMAGE = Object.freeze(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const AUDIO = Object.freeze([
  "audio/mpeg",
  "audio/mp4",
  "audio/wav",
  "audio/x-wav",
  "audio/ogg",
  "audio/flac",
  "audio/webm",
]);
const VIDEO = Object.freeze(["video/mp4", "video/webm", "video/quicktime"]);
const ANY_TRANSFER = Object.freeze([
  ...new Set([...DOCUMENT, ...SPREADSHEET, ...IMAGE, ...AUDIO, ...VIDEO]),
]);

function attachment(mimeTypes, { required = true, description = "File to transfer." } = {}) {
  return Object.freeze({
    required,
    mimeTypes,
    maxBytes: MAX_ARTIFACT_BYTES,
    description,
  });
}

function family(id, command, title, summary, spec) {
  return Object.freeze({
    id,
    command,
    title,
    summary,
    mode: "work",
    /** Handshake capability keys that must be available. The first is primary. */
    requires: Object.freeze(["work", "artifacts"]),
    /** Operations the family needs; absence means the deployment drifted. */
    operations: Object.freeze(["submitWork"]),
    /** Streams are used for progress; absence degrades to polling, not failure. */
    optionalOperations: Object.freeze(["streamTaskEvents"]),
    attachment: null,
    question: null,
    ...spec,
    requires: Object.freeze(spec.requires ?? ["work", "artifacts"]),
    operations: Object.freeze(spec.operations ?? ["submitWork"]),
    optionalOperations: Object.freeze(spec.optionalOperations ?? ["streamTaskEvents"]),
  });
}

const QUESTION = Object.freeze({ name: "question", flag: "question", label: "question to answer" });

export const CAPABILITY_FAMILIES = Object.freeze([
  family(
    "file.upload",
    "upload",
    "File upload",
    "Store a validated file as an artifact on an existing owner task.",
    {
      mode: "upload",
      requires: ["artifacts"],
      operations: ["createArtifact"],
      attachment: attachment(ANY_TRANSFER, { description: "Regular file to store on the task." }),
    },
  ),
  family(
    "document.create",
    "create-document",
    "Document creation",
    "Create a document artifact from an objective.",
    {
      attachment: attachment(DOCUMENT, { required: false, description: "Optional source document." }),
      options: Object.freeze([
        { flag: "format", label: "format", values: ["md", "txt", "docx", "pdf"] },
        { flag: "name", label: "name" },
      ]),
      objective: (input) =>
        `Create a ${input.format ?? "markdown"} document${input.name ? ` named ${input.name}` : ""}: ${input.prompt}. ` +
        "Save the document as a task artifact and report the artifact path and a short summary.",
    },
  ),
  family(
    "document.analyze",
    "analyze-document",
    "Document analysis",
    "Analyze a document through a cloud Work task and retain the findings as artifacts.",
    {
      attachment: attachment(DOCUMENT, { description: "Document to analyze." }),
      requires: ["work", "artifacts", "multimodal"],
      question: QUESTION,
      objective: (input) =>
        `Analyze the attached document ${input.attachmentName}${input.question ? ` and answer: ${input.question}` : ""}. ` +
        "Retain the findings as a task artifact and report a concise summary.",
    },
  ),
  family(
    "pdf.create",
    "create-pdf",
    "PDF creation",
    "Create a PDF artifact from an objective.",
    {
      options: Object.freeze([{ flag: "name", label: "name" }]),
      objective: (input) =>
        `Create a PDF${input.name ? ` named ${input.name}` : ""}: ${input.prompt}. ` +
        "Save it as a task artifact and report the artifact path.",
    },
  ),
  family(
    "pdf.analyze",
    "analyze-pdf",
    "PDF analysis",
    "Analyze a PDF through a cloud Work task without local extraction.",
    {
      attachment: attachment([PDF], { description: "PDF document to analyze." }),
      requires: ["work", "artifacts", "multimodal"],
      question: QUESTION,
      objective: (input) =>
        `Analyze the attached PDF ${input.attachmentName}${input.question ? ` and answer: ${input.question}` : ""}. ` +
        "Retain the findings as a task artifact and report a concise summary.",
    },
  ),
  family(
    "spreadsheet.create",
    "create-spreadsheet",
    "Spreadsheet creation",
    "Create a spreadsheet artifact from an objective.",
    {
      options: Object.freeze([{ flag: "format", label: "format", values: ["xlsx", "csv"] }]),
      objective: (input) =>
        `Create a ${input.format ?? "xlsx"} spreadsheet: ${input.prompt}. ` +
        "Save it as a task artifact and report the artifact path.",
    },
  ),
  family(
    "spreadsheet.analyze",
    "analyze-spreadsheet",
    "Spreadsheet analysis",
    "Analyze a spreadsheet through a cloud Work task and retain the findings.",
    {
      attachment: attachment(SPREADSHEET, { description: "Spreadsheet to analyze." }),
      requires: ["work", "artifacts", "multimodal"],
      question: QUESTION,
      objective: (input) =>
        `Analyze the attached spreadsheet ${input.attachmentName}${input.question ? ` and answer: ${input.question}` : ""}. ` +
        "Retain the findings as a task artifact and report a concise summary.",
    },
  ),
  family(
    "presentation.create",
    "create-presentation",
    "Presentation creation",
    "Create a presentation artifact from an objective and optional source document.",
    {
      attachment: attachment(DOCUMENT, { required: false, description: "Optional source document." }),
      options: Object.freeze([{ flag: "format", label: "format", values: ["pptx", "pdf"] }]),
      objective: (input) =>
        `Create a ${input.format ?? "pptx"} presentation: ${input.prompt}. ` +
        `${input.attachmentName ? `Use the attached source ${input.attachmentName}. ` : ""}` +
        "Save it as a task artifact and report the artifact path.",
    },
  ),
  family(
    "data.analyze",
    "analyze-data",
    "Data analysis",
    "Analyze a dataset and retain the analysis as artifacts.",
    {
      attachment: attachment(SPREADSHEET, { required: false, description: "Optional dataset." }),
      question: QUESTION,
      objective: (input) =>
        `Analyze the data${input.attachmentName ? ` in the attached ${input.attachmentName}` : ""}` +
        `${input.question ? ` and answer: ${input.question}` : ""}. ` +
        "Retain the analysis as a task artifact and report a concise summary.",
    },
  ),
  family(
    "data.visualize",
    "visualize-data",
    "Data visualization",
    "Produce a chart or visualization artifact from a dataset.",
    {
      attachment: attachment(SPREADSHEET, { required: false, description: "Optional dataset." }),
      options: Object.freeze([
        { flag: "chart", label: "chart", values: ["bar", "line", "area", "scatter", "pie"] },
      ]),
      objective: (input) =>
        `Produce a ${input.chart ?? "bar"} chart${input.attachmentName ? ` from the attached ${input.attachmentName}` : ""}: ${input.prompt}. ` +
        "Save the visualization as a task artifact and report the artifact path.",
    },
  ),
  family(
    "image.understand",
    "understand-image",
    "Image understanding",
    "Describe or answer a question about an image in the cloud.",
    {
      attachment: attachment(IMAGE, { description: "Image to inspect." }),
      requires: ["work", "artifacts", "multimodal"],
      question: QUESTION,
      objective: (input) =>
        `Inspect the attached image ${input.attachmentName}${input.question ? ` and answer: ${input.question}` : " and describe it"}. ` +
        "Retain the answer as a task artifact and report a concise summary.",
    },
  ),
  family(
    "image.generate",
    "generate-image",
    "Image generation",
    "Generate an image artifact through the engine's configured provider.",
    {
      options: Object.freeze([
        { flag: "size", label: "size", values: ["512x512", "1024x1024", "1024x1536", "1536x1024"] },
        { flag: "count", label: "count", integer: true, min: 1, max: 4 },
      ]),
      objective: (input) =>
        `Generate ${input.count ?? 1} image${input.count === 1 ? "" : "s"}${input.size ? ` at ${input.size}` : ""}: ${input.prompt}. ` +
        "Save the result as a task artifact and report the artifact path.",
    },
  ),
  family(
    "image.edit",
    "edit-image",
    "Image editing",
    "Edit an image in the cloud and retain the result as an artifact.",
    {
      attachment: attachment(IMAGE, { description: "Image to edit." }),
      requires: ["work", "artifacts", "multimodal"],
      options: Object.freeze([{ flag: "instruction", label: "edit instruction" }]),
      objective: (input) =>
        `Edit the attached image ${input.attachmentName}: ${input.instruction ?? input.prompt}. ` +
        "Save the edited image as a task artifact and report the artifact path.",
    },
  ),
  family(
    "audio.transcribe",
    "transcribe",
    "Audio transcription",
    "Transcribe audio in the cloud and retain the transcript as an artifact.",
    {
      attachment: attachment(AUDIO, { description: "Audio file to transcribe." }),
      requires: ["work", "artifacts", "multimodal"],
      options: Object.freeze([
        { flag: "language", label: "language" },
        { flag: "format", label: "format", values: ["txt", "srt", "vtt"] },
      ]),
      objective: (input) =>
        `Transcribe the attached audio ${input.attachmentName}${input.language ? ` in ${input.language}` : ""} ` +
        `as ${input.format ?? "txt"}. Save the transcript as a task artifact and report the artifact path.`,
    },
  ),
  family(
    "audio.speech",
    "speak",
    "Text-to-speech",
    "Synthesize speech in the cloud and retain the audio as an artifact.",
    {
      options: Object.freeze([
        { flag: "voice", label: "voice" },
        { flag: "format", label: "format", values: ["mp3", "wav", "opus"] },
      ]),
      objective: (input) =>
        `Synthesize speech${input.voice ? ` with voice ${input.voice}` : ""} as ${input.format ?? "mp3"}: ${input.prompt}. ` +
        "Save the audio as a task artifact and report the artifact path.",
    },
  ),
  family(
    "video.understand",
    "understand-video",
    "Video understanding",
    "Analyze a video in the cloud and retain the findings as artifacts.",
    {
      attachment: attachment(VIDEO, { description: "Video to analyze." }),
      requires: ["work", "artifacts", "multimodal"],
      question: QUESTION,
      objective: (input) =>
        `Analyze the attached video ${input.attachmentName}${input.question ? ` and answer: ${input.question}` : ""}. ` +
        "Retain the findings as a task artifact and report a concise summary.",
    },
  ),
  family(
    "software.create",
    "create-software",
    "Software creation",
    "Run an authorized software build in a cloud workspace and retain its artifacts.",
    {
      options: Object.freeze([{ flag: "name", label: "name" }]),
      objective: (input) =>
        `Build the following software${input.name ? ` as ${input.name}` : ""}: ${input.prompt}. ` +
        "Keep the source in the task workspace, save the distributable as a task artifact and report what was verified.",
    },
  ),
  family(
    "game.create",
    "create-game",
    "Native Game Studio",
    "Create a game through the engine's published Native Game Studio operations.",
    {
      mode: "operation",
      requires: ["work"],
      operations: Object.freeze([]),
      optionalOperations: Object.freeze([]),
      discover: Object.freeze({ tags: ["games", "game-studio"], pathPrefix: "/v1/games" }),
      options: Object.freeze([{ flag: "name", label: "name" }]),
      objective: (input) => `Create a game${input.name ? ` named ${input.name}` : ""}: ${input.prompt}.`,
    },
  ),
  family(
    "game.play",
    "gaming-agent",
    "Native Gaming Agent",
    "Run a Native Gaming Agent session against a verified studio build.",
    {
      mode: "operation",
      requires: ["work"],
      operations: Object.freeze([]),
      optionalOperations: Object.freeze([]),
      discover: Object.freeze({ tags: ["gaming-agent"], pathPrefix: "/v1/games" }),
      options: Object.freeze([
        { flag: "session", label: "session id" },
        { flag: "objective", label: "in-game objective" },
      ]),
      objective: (input) =>
        `Play the game${input.session ? ` in session ${input.session}` : ""} to ${input.objective ?? input.prompt}. ` +
        "Report measured completion state and any session artifact.",
    },
  ),
  family(
    "work.multi-agent",
    "orchestrate",
    "Multi-agent workflows",
    "Submit a Work objective that the engine's published agents orchestrate.",
    {
      requires: ["work", "multiAgent"],
      options: Object.freeze([{ flag: "agent", label: "agent id" }]),
      objective: (input) => input.prompt,
    },
  ),
]);

export const CAPABILITY_COMMANDS = Object.freeze(
  CAPABILITY_FAMILIES.map((entry) => entry.command),
);

export const CAPABILITY_COMMAND_SET = new Set(CAPABILITY_COMMANDS);

export const ARTIFACT_ACTIONS = Object.freeze(["list", "inspect", "download"]);
export const ARTIFACT_ACTION_SET = new Set(ARTIFACT_ACTIONS);

export const SCHEDULE_ACTIONS = Object.freeze(["list", "create", "pause", "resume", "delete"]);
export const SCHEDULE_ACTION_SET = new Set(SCHEDULE_ACTIONS);

/**
 * Options the transport owns. A family may not redeclare them, and the CLI
 * validates every dynamic option against the resolved family before it runs.
 */
export const RESERVED_OPTIONS = Object.freeze([
  "after",
  "agent",
  "base-url",
  "chat-path",
  "data",
  "endpoint",
  "force",
  "help",
  "json",
  "model",
  "no-color",
  "no-wait",
  "out",
  "stream",
  "task",
  "timeout",
  "token",
  "url",
  "version",
  "wait",
  "wait-timeout",
]);

export function capabilityFamilyFor(commandOrId) {
  const key = String(commandOrId ?? "").trim();
  return (
    CAPABILITY_FAMILIES.find((entry) => entry.command === key || entry.id === key) ?? null
  );
}

export function isCapabilityCommand(command) {
  return CAPABILITY_COMMAND_SET.has(command);
}

export function isExtendedCommand(command) {
  return (
    command === "artifacts" ||
    command === "schedules" ||
    command === "capability" ||
    command === "readiness" ||
    command === "capabilities" ||
    isCapabilityCommand(command)
  );
}

export function stateLabel(state) {
  return STATE_LABELS[state] ?? "unknown";
}

export function optionValues(entry) {
  return entry.options ?? [];
}

export function attachmentFor(entry) {
  return entry.attachment ?? null;
}
