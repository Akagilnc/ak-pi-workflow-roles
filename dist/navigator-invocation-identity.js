const NAVIGATOR_INVOCATION_ENTRY = "ak-navigator-invocation";
function mintNavigatorInvocationId(sessionId, sequence) {
  return `${sessionId}:${sequence}`;
}
function invocationIdFromData(data) {
  if (data === null || typeof data !== "object") return void 0;
  const invocationId = data.invocationId;
  if (typeof invocationId !== "string") return void 0;
  const trimmed = invocationId.trim();
  return trimmed === "" ? void 0 : trimmed;
}
function currentInvocationPrincipalFromSession(entries, beforeIndex = entries.length) {
  const limit = Math.min(Math.max(beforeIndex, 0), entries.length);
  for (let i = limit - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry?.type !== "custom") continue;
    if (entry.customType !== NAVIGATOR_INVOCATION_ENTRY) continue;
    const id = invocationIdFromData(entry.data);
    if (id !== void 0) return id;
  }
  return void 0;
}
export {
  NAVIGATOR_INVOCATION_ENTRY,
  currentInvocationPrincipalFromSession,
  mintNavigatorInvocationId
};
