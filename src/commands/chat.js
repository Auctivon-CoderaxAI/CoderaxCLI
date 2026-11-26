import { EXIT, UsageError } from "../errors.js";
import { parseModelRef } from "../engine/submit.js";
import { MarkdownRenderer } from "../ui/markdown.js";
import { Spinner } from "../ui/prompt.js";

function messageFrom(runtime, positionals) {
  const pieces = positionals.slice();
  const flag = runtime.flags.get("message");
  if (flag) pieces.push(flag);
  return pieces.join(" ").trim();
}

export async function chatCommand(runtime, positionals, { interactive = null } = {}) {
  let message = messageFrom(runtime, positionals);
  if (!message && !runtime.isTTY) message = (await runtime.readStdin()).trim();
  if (!message) {
    if (runtime.isTTY && interactive) return interactive("chat");
    throw new UsageError("chat requires a message, or run `coderax` for the interactive terminal");
  }

  const client = await runtime.getEngine();
  const agent = runtime.flags.get("agent") ?? runtime.config.agent ?? "coderax";
  await client.requireCapability(agent, null);
  const model = parseModelRef(runtime.flags.get("model") ?? (runtime.config.model || undefined));
  const state = await runtime.state.load();
  const conversationId = runtime.flags.has("new")
    ? undefined
    : runtime.flags.get("conversation") ?? state.active.chatConversationId ?? undefined;
  const mode = runtime.flags.get("mode") ?? "private";

  const request = { message, agent, mode };
  if (conversationId) request.conversationId = conversationId;
  if (model) request.model = model;

  const spinner = new Spinner({
    stream: runtime.stderrStream,
    style: runtime.style,
    text: `thinking with ${agent}`,
  });
  if (!runtime.json && !runtime.ndjson && runtime.stdoutIsTTY) spinner.start();
  let reply;
  try {
    reply = await client.chat(request, { signal: runtime.signal ?? undefined });
  } finally {
    spinner.stop();
  }

  await runtime.state.setActive({
    mode: "chat",
    chatConversationId: reply.conversationId,
    agent: reply.agent,
  });
  await runtime.state.addHistory("chat", message);

  runtime.emit("chat", { reply }, () => {
    if (runtime.stdoutIsTTY) {
      runtime.write(runtime.style.dim(`${reply.agent}  ${reply.model.providerId}/${reply.model.modelId}  ${reply.createdAt}`));
      runtime.write("");
    }
    const renderer = new MarkdownRenderer({
      write: (text) => runtime.raw(text),
      width: runtime.width,
      style: runtime.style,
    });
    renderer.write(reply.text);
    renderer.end();
  });
  return EXIT.OK;
}
