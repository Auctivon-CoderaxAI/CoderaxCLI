export function memoryCredentialStore() {
  const entries = new Map();
  return {
    name: "memory",
    available: true,
    get: async (key) => entries.get(key) ?? null,
    set: async (key, value) => { entries.set(key, value); },
    delete: async (key) => entries.delete(key),
    entries: () => [...entries],
  };
}
