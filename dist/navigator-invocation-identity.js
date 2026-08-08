import { PACKAGED_ROLE_REGISTRY } from "./packaged-role-registry.js";
import { isUuidV7, uuidv7 } from "./uuidv7.js";
const NAVIGATOR_INVOCATION_ENTRY = "ak-navigator-invocation";
const NAVIGATOR_INFRASTRUCTURE_FAILURE_KIND = "role_infrastructure_failure";
const NAVIGATOR_INFRASTRUCTURE_FAILURE_KEYS = [
  "kind",
  "source",
  "reasonCode"
];
function buildNavigatorInfrastructureFailureFact() {
  return {
    kind: NAVIGATOR_INFRASTRUCTURE_FAILURE_KIND,
    source: "shared-role-lifecycle",
    reasonCode: "host_failure"
  };
}
function isNavigatorInfrastructureFailureFact(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value;
  const keys = Object.keys(record);
  if (keys.length !== NAVIGATOR_INFRASTRUCTURE_FAILURE_KEYS.length) return false;
  for (const key of NAVIGATOR_INFRASTRUCTURE_FAILURE_KEYS) {
    if (!Object.hasOwn(record, key)) return false;
  }
  return record.kind === NAVIGATOR_INFRASTRUCTURE_FAILURE_KIND && record.source === "shared-role-lifecycle" && record.reasonCode === "host_failure";
}
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
function classifyPackagedRoleTerminalResult(message) {
  if (typeof message.toolName !== "string") return { kind: "nonterminal" };
  if (!PACKAGED_ROLE_OUTPUT_TOOLS.has(message.toolName)) return { kind: "nonterminal" };
  const infraFact = isNavigatorInfrastructureFailureFact(message.details) ? message.details : void 0;
  if (message.isError === true) {
    if (infraFact === void 0) return { kind: "nonterminal" };
    return { kind: "infrastructure", fact: infraFact };
  }
  if (message.isError === false) {
    if (infraFact !== void 0) return { kind: "nonterminal" };
    return { kind: "accepted" };
  }
  return { kind: "nonterminal" };
}
function isDurablePackagedRoleTerminalResult(message) {
  const classification = classifyPackagedRoleTerminalResult(message);
  return classification.kind === "accepted" || classification.kind === "infrastructure";
}
function isAcceptedPackagedRoleTerminalResult(message) {
  return classifyPackagedRoleTerminalResult(message).kind === "accepted";
}
function isPackagedRoleTerminalEntry(entry) {
  if (entry?.type !== "message") return false;
  const message = entry.message;
  if (message?.role !== "toolResult") return false;
  return isDurablePackagedRoleTerminalResult(message);
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
  NAVIGATOR_INFRASTRUCTURE_FAILURE_KIND,
  NAVIGATOR_INVOCATION_ENTRY,
  buildNavigatorInfrastructureFailureFact,
  classifyPackagedRoleTerminalResult,
  currentInvocationPrincipalFromSession,
  isAcceptedPackagedRoleTerminalResult,
  isDurablePackagedRoleTerminalResult,
  isNavigatorInfrastructureFailureFact,
  mintNavigatorInvocationId,
  resolveLifecycleInvocationPrincipal
};
