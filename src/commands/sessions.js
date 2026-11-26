import { EXIT, UsageError } from "../errors.js";
import { MarkdownRenderer } from "../ui/markdown.js";
import { renderTable } from "../ui/tables.js";

export async function sessionsCommand(runtime, positionals, { prompt = null } = {}) {
  const action = positionals[0] ?? "list";
  const client = await runtime.getEngine();

  if (action === "list") {
    const list = await client.conversations();
    const state = await runtime.state.load();
    const activeId = state.active.mode === "work" ? state.active.workConversationId : state.active.chatConversationId;
    runtime.emit("sessions.list", { conversations: list.conversations, active: activeId }, () => {
      if (list.conversations.length === 0) {
        runtime.write("No conversations yet. Start one with `coderax chat` or `coderax work`.");
        return;
      }
      runtime.write(renderTable({
        headers: ["", "CONVERSATION", "MODE", "AGENT", "UPDATED", "TITLE"],
        rows: list.conversations.map((entry) => [
          entry.conversationId === activeId ? "\u276f" : " ",
          entry.conversationId,
          entry.isWork ? "work" : "chat",
          entry.agent,
          entry.updatedAt,
          entry.title ?? "",
        ]),
        style: runtime.style,
        width: runtime.width,
        maxColumnWidth: 36,
      }));
    });
    return EXIT.OK;
  }

  if (action === "new") {
    const mode = positionals[1] ?? runtime.flags.get("mode") ?? (await runtime.state.load()).active.mode;
    if (!["chat", "work"].includes(mode)) throw new UsageError("sessions new accepts chat or work");
    await runtime.state.setActive({ mode, [`${mode}ConversationId`]: null });
    runtime.emit("sessions.new", { mode }, () => runtime.write(`Started a new ${mode} session.`));
    return EXIT.OK;
  }

  if (action === "current") {
    const state = await runtime.state.load();
    const id = state.active.mode === "work" ? state.active.workConversationId : state.active.chatConversationId;
    if (!id) {
      runtime.emit("sessions.current", { conversation: null, mode: state.active.mode }, () => runtime.write(`No active ${state.active.mode} conversation.`));
      return EXIT.OK;
    }
    const conversation = await client.conversation(id);
    runtime.emit("sessions.current", { conversation }, () => {
      runtime.write(`${conversation.conversationId}  ${conversation.isWork ? "work" : "chat"}  ${conversation.agent}`);
      runtime.write(conversation.title ?? "(untitled)");
      runtime.write(`${conversation.messages.length} messages`);
    });
    return EXIT.OK;
  }

  if (action === "show") {
    let id = positionals[1];
    if (!id && prompt) {
      const list = await client.conversations();
      const choice = await prompt.select({
        title: "Conversations",
        items: list.conversations,
        render: (entry) => `${entry.isWork ? "[work]" : "[chat]"} ${entry.title ?? entry.conversationId}  ${entry.updatedAt}`,
      });
      id = choice?.conversationId;
    }
    if (!id) throw new UsageError("sessions show requires a conversation id");
    const conversation = await client.conversation(id);
    runtime.emit("sessions.show", { conversation }, () => {
      runtime.write(runtime.style.bold(`${conversation.title ?? conversation.conversationId}`));
      runtime.write(runtime.style.dim(`${conversation.mode}  ${conversation.isWork ? "work" : "chat"}  ${conversation.agent}  ${conversation.updatedAt}`));
      runtime.write("");
      for (const message of conversation.messages) {
        if (message.role === "tool") {
          runtime.write(runtime.style.dim(`tool: ${message.text.slice(0, 300)}`));
          continue;
        }
        runtime.write(message.role === "user" ? runtime.style.cyan("you") : runtime.style.green(conversation.agent));
        const renderer = new MarkdownRenderer({
          write: (text) => runtime.raw(text),
          width: runtime.width,
          style: runtime.style,
          indent: 2,
        });
        renderer.write(message.text);
        renderer.end();
        runtime.write("");
      }
    });
    return EXIT.OK;
  }

  if (action === "switch") {
    let id = positionals[1];
    if (!id && prompt) {
      const list = await client.conversations();
      const choice = await prompt.select({
        title: "Switch conversation",
        items: list.conversations,
        render: (entry) => `${entry.isWork ? "[work]" : "[chat]"} ${entry.title ?? entry.conversationId}  ${entry.updatedAt}`,
      });
      id = choice?.conversationId;
    }
    if (!id) throw new UsageError("sessions switch requires a conversation id");
    const conversation = await client.conversation(id);
    const mode = conversation.isWork ? "work" : "chat";
    await runtime.state.setActive({
      mode,
      [`${mode}ConversationId`]: conversation.conversationId,
      agent: conversation.agent,
    });
    runtime.emit("sessions.switch", { conversation, mode }, () => {
      runtime.write(`Switched to ${mode} conversation ${conversation.conversationId}.`);
      if (conversation.title) runtime.write(conversation.title);
    });
    return EXIT.OK;
  }

  throw new UsageError(`unknown sessions action: ${action}`);
}
