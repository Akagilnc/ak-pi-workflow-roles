import { PACKAGED_ROLE_REGISTRY } from "./packaged-role-registry.js";
import { isUuidV7, uuidv7 } from "./uuidv7.js";
const NAVIGATOR_INVOCATION_ENTRY = "ak-navigator-invocation";
const PACKAGED_ROLE_OUTPUT_TOOLS = new Set(
  PACKAGED_ROLE_REGISTRY.map((entry) => entry.outputTool)
);
function mintNavigatorInvocationId() {
  return uuidv7();
}
function invocationIdFromData(data) {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return void 0;
  const invocationId = data.invocationId;
  if (typeof invocationId !== "string") return void 0;
  const trimmed = invocationId.trim();
  return isUuidV7(trimmed) ? trimmed : void 0;
}
function isPackagedRoleTerminalEntry(entry) {
  if (entry?.type !== "message") return false;
  const message = entry.message;
  if (message?.role !== "toolResult") return false;
  if (typeof message.toolName !== "string") return false;
  return PACKAGED_ROLE_OUTPUT_TOOLS.has(message.toolName);
}
function latestInvocationMarkerIndex(entries) {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry?.type !== "custom") continue;
    if (entry.customType !== NAVIGATOR_INVOCATION_ENTRY) continue;
    return i;
  }
  return -1;
}
function resolveLifecycleInvocationPrincipal(entries) {
  const markerIndex = latestInvocationMarkerIndex(entries);
  if (markerIndex < 0) {
    return { invocationId: mintNavigatorInvocationId(), resume: false };
  }
  const principal = invocationIdFromData(entries[markerIndex]?.data);
  if (principal === void 0) {
    return { invocationId: mintNavigatorInvocationId(), resume: false };
  }
  for (let i = markerIndex + 1; i < entries.length; i += 1) {
    if (isPackagedRoleTerminalEntry(entries[i])) {
      return { invocationId: mintNavigatorInvocationId(), resume: false };
    }
  }
  return { invocationId: principal, resume: true };
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
  mintNavigatorInvocationId,
  resolveLifecycleInvocationPrincipal
};
