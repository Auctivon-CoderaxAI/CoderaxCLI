/**
 * The capability command catalog.
 *
 * This file is UX metadata only: command names, expected inputs and the MIME
 * families the owner may hand to a file input. It contains no provider,
 * inference, artifact-generation or execution logic. The engine's capability
 * registry is authoritative for which of these commands exist, which options
 * they take and whether they may run. Catalog entries are fallbacks for offline
 * help and for capabilities the registry omits; an omitted capability is
 * reported as blocked, never as operational.
 */

export const CAPABILITY_STATUSES = Object.freeze([
  "available",
  "unavailable",
  "unconfigured",
  "unverified",
  "blocked",
]);

export const STATUS_LABELS = Object.freeze({
  available: "available",
  unavailable: "unavailable",
  unconfigured: "unconfigured",
  unverified: "unverified",
  blocked: "blocked",
});

/** Only a capability the engine reports as available may be executed. */
export const EXECUTABLE_STATUS = "available";

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

const PDF = "application/pdf";
const DOCUMENT = [
  PDF,
  "text/plain",
  "text/markdown",
  "application/rtf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.oasis.opendocument.text",
];
const SPREADSHEET = [
  "text/csv",
  "text/tab-separated-values",
  "application/json",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.oasis.opendocument.spreadsheet",
];
const IMAGE = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const AUDIO = [
  "audio/mpeg",
  "audio/mp4",
  "audio/wav",
  "audio/x-wav",
  "audio/ogg",
  "audio/flac",
  "audio/webm",
];
const ANY_TRANSFER = [...new Set([...DOCUMENT, ...SPREADSHEET, ...IMAGE, ...AUDIO])];

function fileInput(mimeTypes, description, { required = true, name = "file" } = {}) {
  return Object.freeze({
    name,
    type: "file",
    required,
    description,
    mimeTypes: Object.freeze([...mimeTypes]),
    maxBytes: MAX_UPLOAD_BYTES,
  });
}

function input(name, type, description, extra = {}) {
  return Object.freeze({ name, type, required: false, description, ...extra });
}

function entry(id, command, title, summary, inputs, primary) {
  return Object.freeze({
    id,
    command,
    title,
    summary,
    primary,
    inputs: Object.freeze(inputs),
  });
}

export const CAPABILITY_CATALOG = Object.freeze([
  entry(
    "file.upload",
    "upload",
    "File upload",
    "Transfer a validated file to the owner's cloud execution environment.",
    [fileInput(ANY_TRANSFER, "Regular file to transfer.", { name: "file" })],
    "file",
  ),
  entry(
    "document.analyze",
    "analyze-document",
    "Document analysis",
    "Analyze a document in the cloud and return an artifact-backed answer.",
    [
      fileInput(DOCUMENT, "Document to analyze."),
      input("question", "text", "Question to answer about the document."),
    ],
    "file",
  ),
  entry(
    "pdf.analyze",
    "analyze-pdf",
    "PDF analysis",
    "Analyze a PDF in the cloud without running extraction locally.",
    [
      fileInput([PDF], "PDF document to analyze."),
      input("question", "text", "Question to answer about the PDF."),
    ],
    "file",
  ),
  entry(
    "spreadsheet.analyze",
    "analyze-spreadsheet",
    "Spreadsheet analysis",
    "Analyze a spreadsheet in the cloud and return findings as artifacts.",
    [
      fileInput(SPREADSHEET, "Spreadsheet to analyze."),
      input("question", "text", "Question to answer about the spreadsheet."),
    ],
    "file",
  ),
  entry(
    "presentation.create",
    "create-presentation",
    "Presentation creation",
    "Create a presentation artifact from a prompt and optional source file.",
    [
      input("prompt", "text", "What the presentation should contain.", { required: true }),
      fileInput(DOCUMENT, "Optional source document.", { required: false, name: "source" }),
      input("format", "enum", "Output format.", { values: ["pptx", "pdf"], default: "pptx" }),
    ],
    "prompt",
  ),
  entry(
    "image.understand",
    "understand-image",
    "Image understanding",
    "Describe or answer a question about an image in the cloud.",
    [
      fileInput(IMAGE, "Image to inspect."),
      input("question", "text", "Question to answer about the image."),
    ],
    "file",
  ),
  entry(
    "image.generate",
    "generate-image",
    "Image generation",
    "Generate an image artifact through the engine's authorized provider.",
    [
      input("prompt", "text", "Image description.", { required: true }),
      input("size", "enum", "Output size.", { values: ["512x512", "1024x1024", "1024x1536", "1536x1024"] }),
      input("count", "number", "Number of images.", { min: 1, max: 4, integer: true }),
    ],
    "prompt",
  ),
  entry(
    "audio.transcribe",
    "transcribe",
    "Audio transcription",
    "Transcribe an audio file in the cloud and return a text artifact.",
    [
      fileInput(AUDIO, "Audio file to transcribe."),
      input("language", "string", "BCP-47 language hint."),
      input("format", "enum", "Transcript format.", { values: ["txt", "srt", "vtt"], default: "txt" }),
    ],
    "file",
  ),
  entry(
    "audio.speech",
    "speak",
    "Text-to-speech",
    "Synthesize speech in the cloud and optionally download the result.",
    [
      input("text", "text", "Text to synthesize.", { required: true }),
      input("voice", "string", "Voice identifier published by the engine."),
      input("format", "enum", "Audio format.", { values: ["mp3", "wav", "opus"], default: "mp3" }),
    ],
    "text",
  ),
  entry(
    "software.create",
    "create-software",
    "Software creation",
    "Run an authorized software build in a cloud workspace and retain its artifacts.",
    [
      input("prompt", "text", "What to build.", { required: true }),
      input("name", "string", "Project or package name."),
    ],
    "prompt",
  ),
  entry(
    "game.create",
    "create-game",
    "Game creation",
    "Run an authorized game build in a cloud workspace and retain its artifacts.",
    [
      input("prompt", "text", "What to build.", { required: true }),
      input("name", "string", "Game name."),
    ],
    "prompt",
  ),
]);

export const CAPABILITY_COMMANDS = Object.freeze(
  CAPABILITY_CATALOG.map((capability) => capability.command),
);

export const CAPABILITY_COMMAND_SET = new Set(CAPABILITY_COMMANDS);

export const ARTIFACT_ACTIONS = Object.freeze(["list", "inspect", "download", "associate"]);

export const ARTIFACT_ACTION_SET = new Set(ARTIFACT_ACTIONS);

/** Options the transport itself owns; a capability may not redeclare them. */
export const RESERVED_OPTIONS = Object.freeze([
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
  "project",
  "conversation",
  "stream",
  "timeout",
  "token",
  "url",
  "version",
  "wait",
  "wait-timeout",
]);

export function capabilityForCommand(command) {
  return CAPABILITY_CATALOG.find((capability) => capability.command === command) ?? null;
}

export function statusLabel(status) {
  return STATUS_LABELS[status] ?? "unknown";
}

export function isCapabilityCommand(command) {
  return CAPABILITY_COMMAND_SET.has(command);
}

export function isExtendedCommand(command) {
  return command === "artifacts" || command === "capability" || command === "readiness" || command === "capabilities" || isCapabilityCommand(command);
}
