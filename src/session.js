/**
 * Conversation continuity is local state keyed by deployment. It stores only
 * identifiers, never message content or credentials.
 */
const MAX_SESSIONS = 20;

export function normalizeSessions(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const sessions = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const conversationId =
      typeof entry.conversationId === "string" && entry.conversationId !== ""
        ? entry.conversationId
        : null;
    if (conversationId === null) continue;
    sessions[key] = {
      conversationId,
      parentMessageId:
        typeof entry.parentMessageId === "string" && entry.parentMessageId !== ""
          ? entry.parentMessageId
          : null,
    };
  }
  return sessions;
}

export function sessionKey(baseUrl) {
  return baseUrl.replace(/\/+$/, "");
}

export function getSession(settings, baseUrl) {
  if (!baseUrl) return { conversationId: null, parentMessageId: null };
  const sessions = normalizeSessions(settings.sessions);
  return sessions[sessionKey(baseUrl)] ?? { conversationId: null, parentMessageId: null };
}

export function withSession(sessions, baseUrl, entry) {
  const next = { ...normalizeSessions(sessions) };
  next[sessionKey(baseUrl)] = {
    conversationId: entry.conversationId ?? null,
    parentMessageId: entry.parentMessageId ?? null,
  };
  const keys = Object.keys(next);
  if (keys.length > MAX_SESSIONS) {
    for (const key of keys.slice(0, keys.length - MAX_SESSIONS)) delete next[key];
  }
  return next;
}

export function clearSession(sessions, baseUrl) {
  const next = { ...normalizeSessions(sessions) };
  delete next[sessionKey(baseUrl)];
  return next;
}
