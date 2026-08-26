import { PACKAGED_ROLE_REGISTRY } from "./packaged-role-registry.js";
import { isUuidV7, uuidv7 } from "./uuidv7.js";
import { workSubjectKeysEqual } from "./work-subject-identity.js";
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
function hasNavigatorInfrastructureFailureBase(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value;
  for (const key of NAVIGATOR_INFRASTRUCTURE_FAILURE_KEYS) {
    if (!Object.hasOwn(record, key)) return false;
  }
  return record.kind === NAVIGATOR_INFRASTRUCTURE_FAILURE_KIND && record.source === "shared-role-lifecycle" && record.reasonCode === "host_failure";
}
function isNavigatorInfrastructureFailureFact(value) {
  if (!hasNavigatorInfrastructureFailureBase(value)) return false;
  return Object.keys(value).length === NAVIGATOR_INFRASTRUCTURE_FAILURE_KEYS.length;
}
const PACKAGED_ROLE_OUTPUT_TOOLS = new Map(
  PACKAGED_ROLE_REGISTRY.map((entry) => [entry.outputTool, entry.role])
);
function mintNavigatorInvocationId() {
  return uuidv7();
}
function invocationPhaseFromUnknown(value) {
  if (value === null || value === "plan" || value === "apply") return value;
  return void 0;
}
function parseInvocationMarkerIdentity(data) {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return void 0;
  const record = data;
  const invocationId = record.invocationId;
  if (typeof invocationId !== "string") return void 0;
  const trimmedId = invocationId.trim();
  if (!isUuidV7(trimmedId)) return void 0;
  if (typeof record.role !== "string" || record.role.trim() === "") return void 0;
  const phase = invocationPhaseFromUnknown(record.phase);
  if (phase === void 0) return void 0;
  if (typeof record.subjectKey !== "string" || record.subjectKey.trim() === "") return void 0;
  return {
    invocationId: trimmedId,
    role: record.role,
    phase,
    subjectKey: record.subjectKey
  };
}
function markerMatchesExpectedIdentity(marker, expected) {
  if (marker.role !== expected.role) return false;
  if (expected.phase !== void 0) {
    if (marker.phase !== expected.phase) return false;
  } else if (expected.allowedPhases !== void 0) {
    if (!expected.allowedPhases.includes(marker.phase)) return false;
  }
  if (expected.subjectKey !== void 0) {
    if (!workSubjectKeysEqual(marker.subjectKey, expected.subjectKey)) return false;
  }
  return true;
}
function classifyPackagedRoleTerminalResult(message) {
  if (typeof message.toolName !== "string") return { kind: "nonterminal" };
  if (!PACKAGED_ROLE_OUTPUT_TOOLS.has(message.toolName)) return { kind: "nonterminal" };
  const hasInfraBase = hasNavigatorInfrastructureFailureBase(message.details);
  const infraFact = hasInfraBase ? buildNavigatorInfrastructureFailureFact() : void 0;
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
function durableTerminalAt(entries, index) {
  const entry = entries[index];
  if (entry?.type !== "message") return void 0;
  const message = entry.message;
  if (message?.role !== "toolResult") return void 0;
  if (typeof message.toolName !== "string") return void 0;
  const role = PACKAGED_ROLE_OUTPUT_TOOLS.get(message.toolName);
  if (role === void 0) return void 0;
  const classification = classifyPackagedRoleTerminalResult(message);
  if (classification.kind !== "accepted" && classification.kind !== "infrastructure") {
    return void 0;
  }
  return {
    index,
    role,
    toolName: message.toolName,
    classification: classification.kind,
    message
  };
}
function isPackagedRoleTerminalEntry(entry) {
  if (entry?.type !== "message") return false;
  const message = entry.message;
  if (message?.role !== "toolResult") return false;
  return isDurablePackagedRoleTerminalResult(message);
}
function isInvocationMarkerEntry(entry) {
  return entry?.type === "custom" && entry.customType === NAVIGATOR_INVOCATION_ENTRY;
}
function latestInvocationMarkerIndex(entries) {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (isInvocationMarkerEntry(entries[i])) return i;
  }
  return -1;
}
function findLatestDurablePackagedRoleTerminal(entries) {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const terminal = durableTerminalAt(entries, i);
    if (terminal !== void 0) return terminal;
  }
  return void 0;
}
function bindCurrentDurableTerminalToMarker(entries) {
  const terminal = findLatestDurablePackagedRoleTerminal(entries);
  if (terminal === void 0) return { kind: "absent" };
  let markerIndex = -1;
  for (let i = terminal.index - 1; i >= 0; i -= 1) {
    if (isInvocationMarkerEntry(entries[i])) {
      markerIndex = i;
      break;
    }
  }
  if (markerIndex < 0) {
    return { kind: "unbound", terminal };
  }
  const marker = parseInvocationMarkerIdentity(entries[markerIndex]?.data);
  if (marker === void 0) {
    return { kind: "unbound", terminal };
  }
  let windowEnd = entries.length;
  for (let i = markerIndex + 1; i < entries.length; i += 1) {
    if (isInvocationMarkerEntry(entries[i])) {
      windowEnd = i;
      break;
    }
  }
  let durableCount = 0;
  for (let i = markerIndex + 1; i < windowEnd; i += 1) {
    if (durableTerminalAt(entries, i) !== void 0) durableCount += 1;
  }
  if (durableCount !== 1) return { kind: "ambiguous" };
  if (terminal.index <= markerIndex || terminal.index >= windowEnd) {
    return { kind: "ambiguous" };
  }
  return {
    kind: "bound",
    terminal,
    marker: { ...marker, index: markerIndex }
  };
}
function isReceiptSettlementBindingClear(entries) {
  return bindCurrentDurableTerminalToMarker(entries).kind !== "ambiguous";
}
function resolveLifecycleInvocationPrincipal(entries, expected) {
  const markerIndex = latestInvocationMarkerIndex(entries);
  if (markerIndex < 0) {
    return { invocationId: mintNavigatorInvocationId(), resume: false };
  }
  const marker = parseInvocationMarkerIdentity(entries[markerIndex]?.data);
  if (marker === void 0) {
    return { invocationId: mintNavigatorInvocationId(), resume: false };
  }
  if (expected !== void 0 && !markerMatchesExpectedIdentity(marker, expected)) {
    return { invocationId: mintNavigatorInvocationId(), resume: false };
  }
  for (let i = markerIndex + 1; i < entries.length; i += 1) {
    if (isPackagedRoleTerminalEntry(entries[i])) {
      return { invocationId: mintNavigatorInvocationId(), resume: false };
    }
  }
  return { invocationId: marker.invocationId, resume: true };
}
function currentInvocationPrincipalFromSession(entries, beforeIndex = entries.length) {
  return currentInvocationMarkerFromSession(entries, beforeIndex)?.invocationId;
}
function currentInvocationMarkerFromSession(entries, beforeIndex = entries.length) {
  const limit = Math.min(Math.max(beforeIndex, 0), entries.length);
  for (let i = limit - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (!isInvocationMarkerEntry(entry)) continue;
    return parseInvocationMarkerIdentity(entry?.data);
  }
  return void 0;
}
export {
  NAVIGATOR_INFRASTRUCTURE_FAILURE_KIND,
  NAVIGATOR_INVOCATION_ENTRY,
  bindCurrentDurableTerminalToMarker,
  buildNavigatorInfrastructureFailureFact,
  classifyPackagedRoleTerminalResult,
  currentInvocationMarkerFromSession,
  currentInvocationPrincipalFromSession,
  findLatestDurablePackagedRoleTerminal,
  hasNavigatorInfrastructureFailureBase,
  isAcceptedPackagedRoleTerminalResult,
  isDurablePackagedRoleTerminalResult,
  isNavigatorInfrastructureFailureFact,
  isReceiptSettlementBindingClear,
  markerMatchesExpectedIdentity,
  mintNavigatorInvocationId,
  parseInvocationMarkerIdentity,
  resolveLifecycleInvocationPrincipal
};
