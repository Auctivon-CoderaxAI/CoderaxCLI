import { EXIT } from "../errors.js";
import { renderTable } from "../ui/tables.js";

function notificationKey(notification) {
  return `${notification.taskId}:${notification.state}:${notification.createdAt}`;
}

export async function notificationsCommand(runtime) {
  const client = await runtime.getEngine();
  const list = await client.notifications();
  const state = await runtime.state.load();
  const onlyUnread = runtime.flags.has("unread");
  const entries = onlyUnread
    ? list.notifications.filter((entry) => !state.notifications.seen[notificationKey(entry)])
    : list.notifications;
  const localUnseen = list.notifications.filter((entry) => !state.notifications.seen[notificationKey(entry)]).length;

  runtime.emit("notifications", {
    unread: list.unread,
    localUnseen,
    notifications: entries,
    serverReadState: "the engine publishes no mark-read operation; the CLI tracks displayed items locally",
  }, () => {
    if (entries.length === 0) {
      runtime.write("No notifications.");
      return;
    }
    runtime.write(renderTable({
      headers: ["WHEN", "STATE", "AGENT", "TASK", "SUMMARY"],
      rows: entries.map((entry) => [
        entry.createdAt,
        entry.state,
        entry.agent,
        entry.taskId,
        entry.summary ?? "",
      ]),
      style: runtime.style,
      width: runtime.width,
      maxColumnWidth: 40,
    }));
    runtime.write("");
    runtime.write(runtime.style.dim(`${list.unread} unread at the engine; ${localUnseen} not shown by this terminal`));
  });

  // There is no mark-read route in contract 1.0.0. Remember what this CLI
  // displayed so its own indicator can clear without inventing a server write.
  for (const entry of entries) {
    await runtime.state.markNotificationSeen(notificationKey(entry));
  }
  return EXIT.OK;
}
