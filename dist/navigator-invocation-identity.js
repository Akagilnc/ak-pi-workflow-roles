import { uuidv7 } from "./uuidv7.js";
const NAVIGATOR_INVOCATION_ENTRY = "ak-navigator-invocation";
function mintNavigatorInvocationId() {
  return uuidv7();
}
function invocationIdFromData(data) {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return void 0;
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
    return invocationIdFromData(entry.data);
  }
  return void 0;
}
export {
  NAVIGATOR_INVOCATION_ENTRY,
  currentInvocationPrincipalFromSession,
  mintNavigatorInvocationId
};
