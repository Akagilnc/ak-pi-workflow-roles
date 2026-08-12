import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Value } from "typebox/value";
import {
  NAVIGATOR_INVOCATION_ENTRY,
  mintNavigatorInvocationId
} from "./navigator-invocation-identity.js";
import { PACKAGED_ROLE_REGISTRY, packagedRoleMetadata } from "./packaged-role-registry.js";
import { resolveBookKeyFromGit } from "./activation-ledger-git.js";
import { activationBookDirectory, resolveActivationLedgerHome } from "./activation-ledger-topology.js";
import { openInProcessAgentSession } from "./in-process-session.js";
import { renderPublicAkRoleCommand } from "./public-command-renderer.js";
import { issueRoot, subjectPath } from "./work-subject-identity.js";
import { wrapPackageOwnedToolDefinition } from "./package-owned-tool-idle.js";
import { createReceiptDeliveryPolicy, NO_RECEIPT_LIFECYCLE_ENTRY_TYPE, RECEIPT_DELIVERY_PROMPT } from "./receipt-delivery-policy.js";
const NAVIGATOR_EVENT_TYPE = "ak-navigator-attendance";
const NAVIGATOR_PREPARE_TOOL_NAME = "ak_navigator_prepare";
const NAVIGATOR_DEFAULT_MODEL = "openai-codex/gpt-5.6-luna:max";
const NAVIGATOR_TARGETS = PACKAGED_ROLE_REGISTRY.map(({ role, phases }) => ({ role, phases }));
class NavigatorUnavailableError extends Error {
  unavailableSource;
  unavailableCause;
  originalCause;
  constructor(source, message, cause = source, originalCause) {
    super(message);
    this.name = "NavigatorUnavailableError";
    this.unavailableSource = source;
    this.unavailableCause = cause;
    this.originalCause = originalCause;
  }
}
function navigatorProviderFailureFromStatus(status) {
  if (status === 401 || status === 403) return { source: "auth", cause: "auth" };
  if (status === 429) return { source: "quota", cause: "quota" };
  return void 0;
}
function navigatorProviderFailureFromCode(code) {
  if (typeof code === "number") {
    return navigatorProviderFailureFromStatus(code);
  }
  if (typeof code !== "string") return void 0;
  if (code === "unauthorized" || code === "authentication_failed") return { source: "auth", cause: "auth" };
  if (code === "insufficient_quota" || code === "quota_exhausted") return { source: "quota", cause: "quota" };
  if (code === "transport_error") return { source: "transport", cause: "transport" };
  return void 0;
}
function navigatorProviderFailureFromError(error) {
  if (!exactRecord(error)) return void 0;
  const statusCode = typeof error.statusCode === "number" ? error.statusCode : typeof error.status === "number" ? error.status : void 0;
  return navigatorProviderFailureFromStatus(statusCode) ?? navigatorProviderFailureFromCode(error.code);
}
function navigatorProviderFailureFromDiagnostics(diagnostics) {
  if (!Array.isArray(diagnostics)) return void 0;
  for (const diagnostic of diagnostics) {
    if (!exactRecord(diagnostic)) continue;
    if (diagnostic.type === "provider_transport_failure") return { source: "transport", cause: "transport" };
    if (exactRecord(diagnostic.error)) {
      const fromCode = navigatorProviderFailureFromCode(diagnostic.error.code);
      if (fromCode !== void 0) return fromCode;
    }
    if (exactRecord(diagnostic.details)) {
      const status = typeof diagnostic.details.status === "number" ? diagnostic.details.status : typeof diagnostic.details.statusCode === "number" ? diagnostic.details.statusCode : void 0;
      const fromStatus = navigatorProviderFailureFromStatus(status);
      if (fromStatus !== void 0) return fromStatus;
      const fromCode = navigatorProviderFailureFromCode(diagnostic.details.code);
      if (fromCode !== void 0) return fromCode;
    }
  }
  return void 0;
}
const navigatorProviderFailureSchema = Type.Object({
  source: Type.Union([Type.Literal("context"), Type.Literal("session"), Type.Literal("model"), Type.Literal("thinking"), Type.Literal("auth"), Type.Literal("quota"), Type.Literal("transport"), Type.Literal("unknown")]),
  cause: Type.Union([Type.Literal("context"), Type.Literal("session"), Type.Literal("model"), Type.Literal("thinking"), Type.Literal("auth"), Type.Literal("quota"), Type.Literal("transport"), Type.Literal("unknown")])
}, { additionalProperties: false });
function navigatorProviderFailure(message, source, cause = source) {
  const fact = { source, cause };
  if (!Value.Check(navigatorProviderFailureSchema, fact)) throw new TypeError("Navigator provider failure fact is not typed");
  return Object.assign(message, { navigatorFailure: fact });
}
function navigatorUnavailableError(source, error, cause = source) {
  const message = error instanceof Error ? error.message : String(error);
  return error instanceof NavigatorUnavailableError ? error : new NavigatorUnavailableError(source, message, cause, error);
}
function navigatorAdviceConsistentWithSettlement(next, settlement) {
  if (settlement.kind !== "accepted") return true;
  if (settlement.status === "unfinished" && next.role === "judge") return false;
  if (settlement.role === "fixer" && settlement.phase === "apply" && settlement.status === "completed" && next.role === "fixer" && next.phase === "apply") return false;
  if (next.role !== "merger") return true;
  return settlement.role === "judge" && settlement.status === "converged";
}
const prepareSchema = Type.Object({}, { additionalProperties: true });
const ROUTE_ENTRY = "ak-navigator-route";
const CONTEXT_ENTRY = "ak-navigator-context";
const INVOCATION_ENTRY = NAVIGATOR_INVOCATION_ENTRY;
const SETTLEMENT_ENTRY = "ak-navigator-settlement";
const targetRoles = new Set(NAVIGATOR_TARGETS.map(({ role }) => role));
const unavailableKeys = /* @__PURE__ */ new Set(["context", "session", "model", "thinking", "auth", "quota", "transport", "unknown"]);
function unavailableKey(value) {
  return typeof value === "string" && unavailableKeys.has(value) ? value : void 0;
}
function exactRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function rejectedPrepareReason(entries, start) {
  const recent = entries.slice(start);
  const prepareCalls = /* @__PURE__ */ new Set();
  for (const entry of recent) {
    if (!exactRecord(entry) || entry.type !== "message" || !exactRecord(entry.message) || entry.message.role !== "assistant" || !Array.isArray(entry.message.content)) continue;
    for (const part of entry.message.content) {
      if (exactRecord(part) && part.type === "toolCall" && part.name === NAVIGATOR_PREPARE_TOOL_NAME && typeof part.id === "string") prepareCalls.add(part.id);
    }
  }
  let reason;
  for (const entry of recent) {
    if (!exactRecord(entry) || entry.type !== "message" || !exactRecord(entry.message) || entry.message.role !== "toolResult" || entry.message.isError !== true) continue;
    const callId = entry.message.toolCallId;
    if (entry.message.toolName !== NAVIGATOR_PREPARE_TOOL_NAME || typeof callId !== "string" || !prepareCalls.has(callId)) {
      return void 0;
    }
    const content = entry.message.content;
    const text = Array.isArray(content) ? content.flatMap((part) => exactRecord(part) && typeof part.text === "string" ? [part.text] : []).join("") : typeof content === "string" ? content : "";
    if (text.trim() !== "") reason = text.trim();
  }
  return reason;
}
function targetIsValid(value) {
  if (!exactRecord(value) || !targetRoles.has(String(value.role))) return false;
  const metadata = packagedRoleMetadata(String(value.role));
  return metadata !== void 0 && metadata.phases.includes(value.phase);
}
function normalizeTarget(value) {
  if (!exactRecord(value)) return void 0;
  const role = typeof value.role === "string" ? value.role.trim() : "";
  if (!targetRoles.has(role)) return void 0;
  const metadata = packagedRoleMetadata(role);
  if (metadata === void 0) return void 0;
  if (value.phase === void 0 || value.phase === null) {
    return { role, phase: null };
  }
  if (value.phase === "plan" || value.phase === "apply") {
    if (metadata.phases.includes(value.phase)) {
      return { role, phase: value.phase };
    }
    return { role, phase: null };
  }
  return void 0;
}
function normalizeMatches(value) {
  if (!exactRecord(value)) return void 0;
  if (typeof value.role !== "string" || value.role.trim() === "") return void 0;
  if (value.kind !== "accepted") return void 0;
  let phase;
  if (value.phase === void 0 || value.phase === null) phase = null;
  else if (value.phase === "plan" || value.phase === "apply") phase = value.phase;
  else return void 0;
  if (value.statuses !== void 0) {
    if (!Array.isArray(value.statuses) || value.statuses.some((status) => typeof status !== "string" || status.trim() === "")) {
      return void 0;
    }
    return {
      role: value.role,
      phase,
      kind: "accepted",
      statuses: [...value.statuses]
    };
  }
  return { role: value.role, phase, kind: "accepted" };
}
function normalizeCandidate(value) {
  if (!exactRecord(value)) return void 0;
  const next = normalizeTarget(value.next);
  const route = Array.isArray(value.route) ? value.route.map(normalizeTarget).filter((target) => target !== void 0) : void 0;
  const matches = normalizeMatches(value.matches);
  const id = typeof value.id === "string" && value.id.trim() !== "" ? value.id : void 0;
  const reason = typeof value.reason === "string" && value.reason.trim() !== "" ? value.reason : void 0;
  return {
    ...id === void 0 ? {} : { id },
    ...matches === void 0 ? {} : { matches },
    ...route === void 0 || route.length === 0 ? {} : { route },
    ...next === void 0 ? {} : { next },
    ...reason === void 0 ? {} : { reason }
  };
}
function normalizePrepareOutput(value) {
  if (!exactRecord(value) || !Array.isArray(value.candidates)) return [];
  return value.candidates.map(normalizeCandidate).filter((candidate) => candidate !== void 0);
}
function routeEqual(a, b) {
  return a !== void 0 && a.length === b.length && a.every((target, index) => target.role === b[index].role && target.phase === b[index].phase);
}
function routeText(route) {
  return route.map((target) => target.phase === null ? target.role : `${target.role} ${target.phase}`).join(" \u2192 ");
}
function targetText(target) {
  return target.phase === null ? target.role : `${target.role} ${target.phase}`;
}
function oneLine(value) {
  return value.split(/\r?\n/, 1)[0].trim();
}
function navigatorSubjectKey(subjectRoot, subject, provenance = "role_input") {
  if (issueRoot(subjectRoot) !== void 0 || !subjectRoot.includes("/.ak/work/")) return subjectRoot;
  if (provenance === "placeholder") return subjectRoot;
  const normalized = subject.trim().replace(/\s+/g, " ");
  if (normalized === "") return subjectRoot;
  return `${subjectRoot}#${createHash("sha256").update(normalized).digest("hex").slice(0, 32)}`;
}
function navigatorSubjectKeyForInput(subjectRoot, reference, cwd = process.cwd()) {
  if (issueRoot(subjectRoot) !== void 0 || !subjectRoot.includes("/.ak/work/")) return subjectRoot;
  const resolvedReference = resolve(cwd, reference);
  const marker = "/runs/";
  if (resolvedReference.includes(marker)) {
    return subjectRoot;
  }
  return navigatorSubjectKey(subjectRoot, resolvedReference);
}
function subjectDirectory(cwd, subjectKey) {
  const book = activationBookDirectory(
    resolveActivationLedgerHome(),
    resolveBookKeyFromGit(cwd)
  );
  const digest = createHash("sha256").update(subjectKey).digest("hex").slice(0, 32);
  return join(book, "navigator", digest);
}
function navigatorModelSettingPath() {
  return join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "navigator-model.json");
}
async function readNavigatorModelSetting(path = navigatorModelSettingPath()) {
  try {
    const raw = JSON.parse(await readFile(path, "utf8"));
    if (!exactRecord(raw) || typeof raw.model !== "string" || raw.model.trim() === "") throw new Error("Navigator model setting is malformed");
    return raw.model;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return NAVIGATOR_DEFAULT_MODEL;
    throw error;
  }
}
async function writeNavigatorModelSetting(model, path = navigatorModelSettingPath()) {
  const normalized = model.trim();
  parseNavigatorModelSetting(normalized);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ model: normalized }) + "\n", "utf8");
}
function parseNavigatorModelSetting(value) {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) throw new Error("Navigator model setting must be provider/model[:max]");
  const provider = value.slice(0, slash);
  const modelWithThinking = value.slice(slash + 1);
  const colon = modelWithThinking.lastIndexOf(":");
  const suffix = colon < 0 ? void 0 : modelWithThinking.slice(colon + 1);
  if (suffix !== void 0 && suffix !== "max") throw new Error("Navigator model setting must use :max or omit the thinking suffix");
  const model = colon < 0 ? modelWithThinking : modelWithThinking.slice(0, colon);
  if (model === "") throw new Error("Navigator model setting must include a model");
  return { provider, model, thinkingLevel: suffix === "max" ? "max" : "off" };
}
function createNavigatorPrepareTool(onOutput) {
  return wrapPackageOwnedToolDefinition({
    name: NAVIGATOR_PREPARE_TOOL_NAME,
    label: "Navigator preparation",
    description: "Submit Navigator direction advice. Provide candidates with next.role (phase when meaningful). route/matches/reason/command are optional context, not acceptance gates.",
    parameters: prepareSchema,
    async execute(_id, value) {
      onOutput(value);
      return { content: [{ type: "text", text: "Navigator preparation accepted" }], details: value, terminate: true };
    }
  });
}
function selectNavigatorCandidate(candidates, settlement) {
  if (settlement.kind !== "accepted") return void 0;
  const usable = candidates.filter((candidate) => candidate.next !== void 0);
  if (usable.length === 0) return void 0;
  const matched = usable.filter(
    (candidate) => candidate.matches !== void 0 && candidate.matches.role === settlement.role && candidate.matches.phase === settlement.phase
  );
  if (matched.length > 0) {
    if (settlement.status !== void 0) {
      const statusSpecific = matched.find((candidate) => candidate.matches?.statuses?.includes(settlement.status) === true);
      if (statusSpecific !== void 0) return statusSpecific;
    }
    return matched.find((candidate) => candidate.matches?.statuses === void 0);
  }
  return usable.find((candidate) => candidate.matches === void 0);
}
function formatNavigatorReport(report) {
  const playbookFailure = report.routePlaybookReadFailure === void 0 ? [] : [`\u8DEF\u4E66\u8BFB\u53D6\u5931\u8D25\uFF1A${oneLine(report.routePlaybookReadFailure)}`];
  if (report.disposition === "no-advice") return playbookFailure.join("\n");
  if (report.disposition === "unavailable") return [...playbookFailure, `\u5BFC\u822A\u4E0D\u53EF\u7528\uFF1A${oneLine(report.unavailableReason ?? "\u672A\u80FD\u5B8C\u6210\u5BFC\u822A\u51C6\u5907")}`].join("\n");
  if (report.disposition === "arrival") return [...playbookFailure, oneLine(report.arrivalMessage ?? "\u5DF2\u5230\u8FBE\u76EE\u7684\u5730")].join("\n");
  return [
    ...playbookFailure,
    ...report.route === void 0 ? [] : [`\u8DEF\u7EBF\uFF1A${routeText(report.route)}`],
    `\u4E0B\u4E00\u6B65\uFF1A${targetText(report.next)}`,
    ...report.reason === void 0 || report.reason.trim() === "" ? [] : [`\u7406\u7531\uFF1A${oneLine(report.reason)}`],
    ...report.command === void 0 || report.command.trim() === "" ? [] : [`\u547D\u4EE4\uFF1A${oneLine(report.command)}`]
  ].join("\n");
}
function settlementNavigationFromEvent(event) {
  if (event.disposition !== "recommendation") return void 0;
  if (event.next === void 0) return void 0;
  return {
    disposition: "recommendation",
    ...event.route === void 0 ? {} : { route: event.route },
    next: event.next,
    ...event.reason === void 0 ? {} : { reason: event.reason },
    ...event.command === void 0 ? {} : { command: event.command }
  };
}
function appendNavigatorReportToContent(content, reportText) {
  if (reportText === "") return content.slice();
  const parts = content.slice();
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    if (part !== void 0 && part.type === "text" && typeof part.text === "string") {
      parts[index] = { ...part, type: "text", text: `${part.text}
${reportText}` };
      return parts;
    }
  }
  return [...parts, { type: "text", text: reportText }];
}
function decorateSettlementWithNavigation(event, presentation) {
  if (presentation === void 0) return void 0;
  if (settlementNavigationFromEvent(presentation.event) === void 0) return void 0;
  const { routePlaybookReadFailure: _advisoryFailure, ...receiptReport } = presentation.report;
  const reportText = formatNavigatorReport(receiptReport);
  if (reportText === "") return void 0;
  return {
    content: appendNavigatorReportToContent(event.content, reportText),
    details: event.details
  };
}
function createNavigatorAttendance(options) {
  let preparation;
  let sessionReady;
  let session;
  let subjectKey = options.subjectKey;
  let subject = options.subject;
  let authority = options.authority;
  let contextError = options.contextError;
  let sessionDir = options.sessionDir;
  let candidates;
  const invocationPrincipal = options.invocationId ?? mintNavigatorInvocationId();
  let activeInvocationId = invocationPrincipal;
  let previousRoute;
  let outputSink;
  let settlementTail = Promise.resolve();
  let settlementFailure;
  let preparationFailure;
  let preparationNoReceipt = false;
  let routePlaybookReadFailure;
  let disposed = false;
  let warmedHelp;
  const loadLiveHelp = async () => {
    try {
      return await Promise.all(
        NAVIGATOR_TARGETS.map(async ({ role }) => ({
          role,
          help: await options.loadRoleHelp(role)
        }))
      );
    } catch (error) {
      throw navigatorUnavailableError("transport", error);
    }
  };
  const unavailable = (invocationId, reason) => {
    const failure = reason instanceof NavigatorUnavailableError ? reason : navigatorUnavailableError("unknown", reason);
    return {
      disposition: "unavailable",
      unavailableReason: failure.message,
      unavailableSource: failure.unavailableSource,
      unavailableCause: failure.unavailableCause
    };
  };
  let routePlaybookSettlement;
  let prepareBoundSettlement;
  const prepare = async () => {
    const boundSettlement = prepareBoundSettlement;
    prepareBoundSettlement = void 0;
    const invocationId = invocationPrincipal;
    activeInvocationId = invocationId;
    if (contextError !== void 0) throw navigatorUnavailableError("context", contextError);
    if (typeof authority !== "string" || authority.trim() === "") {
      throw navigatorUnavailableError(
        "context",
        new Error("controlling authority content was not supplied as typed work context")
      );
    }
    let soul;
    let modelSetting;
    let help;
    let routePlaybook = "";
    routePlaybookReadFailure = void 0;
    const soulPromise = (async () => {
      try {
        const text = (await options.loadSoul()).trim();
        if (!text) throw new Error("Navigator soul is empty");
        return text;
      } catch (error) {
        throw navigatorUnavailableError("context", error);
      }
    })();
    const routePlaybookPromise = (async () => {
      if (options.loadRoutePlaybook === void 0) return "";
      try {
        return await options.loadRoutePlaybook();
      } catch (error) {
        routePlaybookReadFailure = error instanceof Error ? error.message : String(error);
        return "";
      }
    })();
    routePlaybookSettlement = routePlaybookPromise.then(() => void 0);
    const modelPromise = (async () => {
      try {
        return await readNavigatorModelSetting(options.modelSettingPath);
      } catch (error) {
        throw navigatorUnavailableError("model", error);
      }
    })();
    const helpPromise = warmedHelp ?? loadLiveHelp();
    warmedHelp = void 0;
    [soul, routePlaybook, modelSetting, help] = await Promise.all([
      soulPromise,
      routePlaybookPromise,
      modelPromise,
      helpPromise
    ]);
    let model;
    try {
      model = parseNavigatorModelSetting(modelSetting);
    } catch (error) {
      throw navigatorUnavailableError("model", error);
    }
    const helpContext = help.map(({ role, help: text }) => `<role_help role="${role}">
${text}
</role_help>`).join("\n");
    let output;
    outputSink = (value) => {
      if (output !== void 0) throw new Error("Navigator preparation must submit exactly one typed candidate batch");
      output = value;
    };
    const tool = createNavigatorPrepareTool((value) => {
      outputSink?.(value);
    });
    if (session === void 0) {
      sessionReady = (async () => {
        let created;
        try {
          created = await options.createSession({ context: options.context, sessionDir, ...options.modelSettingPath === void 0 ? {} : { modelSettingPath: options.modelSettingPath }, tool });
        } catch (error) {
          throw navigatorUnavailableError("session", error);
        }
        if (disposed) {
          created.dispose();
          throw navigatorUnavailableError("session", new Error("Navigator attendance was disposed"));
        }
        try {
          await created.setModel?.(modelSetting, model.thinkingLevel);
          if (disposed) throw navigatorUnavailableError("session", new Error("Navigator attendance was disposed"));
          if (created.getThinkingLevel?.() !== void 0 && created.getThinkingLevel() !== model.thinkingLevel) {
            throw new NavigatorUnavailableError("thinking", `Navigator thinking level ${model.thinkingLevel} is unavailable for ${modelSetting}`);
          }
          created.appendEntry(INVOCATION_ENTRY, { invocationId, role: options.role, phase: options.phase, subjectKey });
          if (disposed) throw navigatorUnavailableError("session", new Error("Navigator attendance was disposed"));
          session = created;
          return created;
        } catch (error) {
          if (session !== created) created.dispose();
          throw error instanceof NavigatorUnavailableError ? error : navigatorUnavailableError("session", error);
        }
      })();
      await sessionReady;
      sessionReady = void 0;
    } else {
      try {
        await session.setModel?.(modelSetting, model.thinkingLevel);
        if (session.getThinkingLevel?.() !== void 0 && session.getThinkingLevel() !== model.thinkingLevel) {
          throw new NavigatorUnavailableError("thinking", `Navigator thinking level ${model.thinkingLevel} is unavailable for ${modelSetting}`);
        }
      } catch (error) {
        throw error instanceof NavigatorUnavailableError ? error : navigatorUnavailableError("session", error);
      }
      session.appendEntry(INVOCATION_ENTRY, { invocationId, role: options.role, phase: options.phase, subjectKey });
    }
    if (disposed) throw navigatorUnavailableError("session", new Error("Navigator attendance was disposed"));
    const activeSession = session;
    if (activeSession === void 0) throw new Error("Navigator session was not created");
    const prior = activeSession.entries().filter((entry) => exactRecord(entry) && entry.type === "custom" && entry.customType === ROUTE_ENTRY && exactRecord(entry.data) && entry.data.subjectKey === subjectKey).at(-1)?.data;
    if (exactRecord(prior) && Array.isArray(prior.route) && prior.route.every((target) => targetIsValid(target))) {
      previousRoute = prior.route.map((target) => ({ role: target.role, phase: target.phase }));
    }
    const publicSettlementHistory = activeSession.entries().filter((entry) => exactRecord(entry) && entry.type === "custom" && entry.customType === SETTLEMENT_ENTRY && exactRecord(entry.data)).slice(-8).map((entry) => entry.data);
    const projection = {
      subjectKey,
      subject,
      authority,
      currentRole: { role: options.role, phase: options.phase },
      ...boundSettlement === void 0 ? {} : { currentSettlement: boundSettlement },
      priorRoute: exactRecord(prior) && Array.isArray(prior.route) && prior.route.every((target) => targetIsValid(target)) ? prior.route.map((target) => ({ role: target.role, phase: target.phase })) : null,
      publicSettlementHistory,
      liveRoleHelp: help
    };
    activeSession.appendEntry(CONTEXT_ENTRY, projection);
    const request = [
      "Act as the Navigator direction advisor. Submit one next-step advice batch; do not execute or invoke any role.",
      `<navigator_soul>
${soul}
</navigator_soul>`,
      ...routePlaybookReadFailure === void 0 ? [
        `<route_playbook>
${routePlaybook}
</route_playbook>`,
        "The route playbook is advisory material only. Exercise independent judgment: adopt, alter, or ignore it; the caller may also deviate."
      ] : ["The optional route playbook could not be read. Continue independent judgment from the other supplied materials."],
      `<work_subject>
${subject}
</work_subject>`,
      `<controlling_authority>
${authority}
</controlling_authority>`,
      `<current_role>
${JSON.stringify({ role: options.role, phase: options.phase })}
</current_role>`,
      ...boundSettlement === void 0 ? [] : [
        `<current_settlement>
${JSON.stringify(boundSettlement)}
</current_settlement>`,
        "The current role has just reached this typed settlement. Recommend the next packaged role AFTER this settlement.",
        "public_settlement_history is prior background only \u2014 a prior terminal does not consume or replace the work this settlement just produced."
      ],
      `<prior_route>
${JSON.stringify(prior ?? null)}
</prior_route>`,
      `<public_settlement_history>
${JSON.stringify(projection.publicSettlementHistory)}
</public_settlement_history>`,
      ...boundSettlement === void 0 ? [
        "Preparation is speculative while the current role still runs. Prefer candidates[].matches keyed to plausible accepted outcomes of the current role; prior history must not substitute for the current role's work."
      ] : [],
      `<live_role_help>
${helpContext}
</live_role_help>`,
      `Use model setting ${JSON.stringify(modelSetting)} for this call. Return exactly one ${NAVIGATOR_PREPARE_TOOL_NAME} call.`,
      "v1 requires a usable next direction: candidates[].next.role, with phase only when present and meaningful. route, matches, id, reason, and command are optional context \u2014 never retry to satisfy optional shape.",
      "Do not put task-specific paths, prompts, packets, or Skill bindings in any field. Command display is rendered by the host from next, not from model prose."
    ].join("\n\n");
    try {
      try {
        if (disposed) throw navigatorUnavailableError("session", new Error("Navigator attendance was disposed"));
        const delivery = createReceiptDeliveryPolicy();
        const promptAllowingRejectedPrepare = async (text, deliveryRequest) => {
          const entryStart = activeSession.entries().length;
          let promptFailure;
          try {
            await activeSession.prompt(text);
          } catch (error) {
            promptFailure = error;
          }
          const providerFailure = activeSession.providerFailure?.();
          if (providerFailure !== void 0) {
            throw navigatorUnavailableError(providerFailure.source, promptFailure ?? "Navigator provider failure", providerFailure.cause);
          }
          const rejectedReason = rejectedPrepareReason(activeSession.entries(), entryStart);
          if (rejectedReason !== void 0) {
            delivery.recordRejected(rejectedReason);
            return;
          }
          if (promptFailure !== void 0) throw promptFailure;
          if (deliveryRequest && output === void 0) delivery.recordDeliveryRequest();
        };
        await promptAllowingRejectedPrepare(request, false);
        while (output === void 0 && delivery.nextAction() === "request-delivery") {
          await promptAllowingRejectedPrepare(RECEIPT_DELIVERY_PROMPT, true);
        }
        if (output === void 0 && delivery.nextAction() === "no-receipt" && activeSession.providerFailure?.() === void 0) {
          const facts = delivery.facts({ runPointer: sessionDir, attemptPointer: invocationId });
          activeSession.appendEntry(NO_RECEIPT_LIFECYCLE_ENTRY_TYPE, facts);
          preparationNoReceipt = true;
          candidates = [];
          return candidates;
        }
      } catch (error) {
        throw error instanceof NavigatorUnavailableError ? error : navigatorUnavailableError("transport", error);
      }
      if (output === void 0) {
        const nativeFailure = [...activeSession.entries()].reverse().find((entry) => {
          if (!exactRecord(entry) || entry.type !== "message" || !exactRecord(entry.message)) return false;
          return entry.message.role === "assistant" && typeof entry.message.errorMessage === "string" && entry.message.errorMessage.trim() !== "";
        });
        const nativeMessage = exactRecord(nativeFailure) && exactRecord(nativeFailure.message) ? nativeFailure.message : void 0;
        const errorMessage = nativeMessage !== void 0 && typeof nativeMessage.errorMessage === "string" ? nativeMessage.errorMessage : "Navigator did not submit direction advice";
        const providerFailure = activeSession.providerFailure?.();
        const source = providerFailure?.source ?? "unknown";
        const cause = providerFailure?.cause ?? source;
        throw navigatorUnavailableError(source, errorMessage, cause);
      }
      candidates = normalizePrepareOutput(output);
      return candidates;
    } finally {
      outputSink = void 0;
    }
  };
  return {
    setWorkContext(next) {
      if (next.subjectKey !== subjectKey && session !== void 0) {
        session.dispose();
        session = void 0;
        previousRoute = void 0;
      }
      subjectKey = next.subjectKey;
      subject = next.subject;
      authority = next.authority;
      contextError = next.contextError;
      sessionDir = options.sessionDirectory?.(next.subjectKey) ?? options.sessionDir;
    },
    /**
     * Start live-help subprocesses during activation without beginning full
     * preparation. Next prepare() consumes the warm result; a later prepare
     * reloads so live help edits remain visible.
     */
    warmHelp() {
      if (disposed || warmedHelp !== void 0 || preparation !== void 0) return;
      warmedHelp = loadLiveHelp();
      void warmedHelp.catch(() => void 0);
    },
    prepare() {
      if (disposed || preparation !== void 0) return;
      preparationFailure = void 0;
      preparation = prepare();
      void preparation.catch((error) => {
        preparationFailure = error;
      });
    },
    isPreparing() {
      return preparation !== void 0 || sessionReady !== void 0;
    },
    knownRoutePlaybookReadFailure() {
      return routePlaybookReadFailure;
    },
    settle(settlement) {
      const next = settlementTail.then(() => settleOnce(settlement));
      settlementTail = next.catch((error) => {
        settlementFailure = error;
      });
      return next;
    },
    dispose() {
      disposed = true;
      session?.dispose();
      session = void 0;
      activeInvocationId = void 0;
    }
  };
  async function settleOnce(settlement) {
    const invocationId = activeInvocationId ?? invocationPrincipal;
    let report;
    if (settlement.kind === "human_decision" || settlement.kind === "role_infrastructure_failure") {
      if (sessionReady !== void 0) {
        try {
          await sessionReady;
        } catch (error) {
          preparationFailure ??= error;
        }
      }
      if (preparation !== void 0) {
        try {
          await preparation;
        } catch (error) {
          preparationFailure ??= error;
        }
      }
      session?.appendEntry(SETTLEMENT_ENTRY, { invocationId, subjectKey, role: settlement.role, phase: settlement.phase, kind: settlement.kind, ...settlement.kind === "human_decision" ? { status: settlement.status } : {} });
      if (preparationFailure !== void 0) {
        report = unavailable(invocationId, preparationFailure);
      } else {
        report = { disposition: "no-advice" };
      }
    } else if (settlement.kind === "arrival") {
      if (sessionReady !== void 0) {
        try {
          await sessionReady;
        } catch (error) {
          preparationFailure ??= error;
        }
      }
      if (preparation !== void 0) {
        try {
          await preparation;
        } catch (error) {
          preparationFailure ??= error;
        }
      }
      report = preparationFailure === void 0 ? { disposition: "arrival", arrivalMessage: settlement.message ?? "\u5DF2\u5230\u8FBE\u76EE\u7684\u5730" } : unavailable(invocationId, preparationFailure);
    } else if (preparation === void 0) {
      report = unavailable(invocationId, "Navigator preparation did not start");
    } else {
      try {
        if (sessionReady !== void 0) await sessionReady;
        let prepared = await preparation;
        session?.appendEntry(SETTLEMENT_ENTRY, { invocationId, subjectKey, role: settlement.role, phase: settlement.phase, kind: settlement.kind, ...settlement.status === void 0 ? {} : { status: settlement.status } });
        let selected = selectNavigatorCandidate(prepared, settlement);
        if (selected?.next !== void 0 && !navigatorAdviceConsistentWithSettlement(selected.next, settlement)) {
          prepareBoundSettlement = settlement;
          prepared = await prepare();
          selected = selectNavigatorCandidate(prepared, settlement);
          if (selected?.next !== void 0 && !navigatorAdviceConsistentWithSettlement(selected.next, settlement)) {
            throw new Error("Navigator advice contradicts the accepted settlement");
          }
        }
        if (selected?.next === void 0 && preparationNoReceipt) {
          report = { disposition: "no-advice" };
        } else if (selected?.next === void 0) {
          throw new Error("Navigator prepared no machine-usable next direction");
        } else {
          const selectedRoute = selected.route;
          const routeChanged = selectedRoute !== void 0 && !routeEqual(previousRoute, selectedRoute);
          const command = renderPublicAkRoleCommand(selected.next);
          report = {
            disposition: "recommendation",
            ...routeChanged ? { route: selectedRoute } : {},
            next: selected.next,
            ...selected.reason === void 0 ? {} : { reason: oneLine(selected.reason) },
            ...command === void 0 ? {} : { command }
          };
          if (selectedRoute !== void 0) {
            previousRoute = selectedRoute;
            session?.appendEntry(ROUTE_ENTRY, { invocationId, subjectKey, route: selectedRoute });
          }
        }
      } catch (error) {
        report = unavailable(invocationId, error);
      }
    }
    await routePlaybookSettlement;
    if (routePlaybookReadFailure !== void 0) {
      report = { ...report, routePlaybookReadFailure };
    }
    const event = {
      version: 1,
      disposition: report.disposition,
      invocationId,
      role: options.role,
      phase: options.phase,
      subjectKey,
      ...report.route === void 0 ? {} : { route: report.route },
      ...report.next === void 0 ? {} : { next: report.next },
      ...report.reason === void 0 ? {} : { reason: report.reason },
      ...report.command === void 0 ? {} : { command: report.command },
      ...report.unavailableReason === void 0 ? {} : { unavailableReason: report.unavailableReason },
      ...report.unavailableSource === void 0 ? {} : { unavailableSource: report.unavailableSource },
      ...report.unavailableCause === void 0 ? {} : { unavailableCause: report.unavailableCause },
      ...report.routePlaybookReadFailure === void 0 ? {} : { routePlaybookReadFailure: report.routePlaybookReadFailure },
      ...report.arrivalMessage === void 0 ? {} : { arrivalMessage: report.arrivalMessage }
    };
    if (!disposed) {
      await options.onEvent(event, report);
    }
    preparation = void 0;
    sessionReady = void 0;
    candidates = void 0;
    preparationFailure = void 0;
    preparationNoReceipt = false;
    routePlaybookSettlement = void 0;
    routePlaybookReadFailure = void 0;
  }
}
function createNativeNavigatorSessionFactory(defaultModelSettingPath = navigatorModelSettingPath()) {
  const sharedModelRuntime = ModelRuntime.create({ allowModelNetwork: false });
  return async ({ context, sessionDir, modelSettingPath, tool }) => {
    let configured;
    try {
      configured = await readNavigatorModelSetting(modelSettingPath ?? defaultModelSettingPath);
    } catch (error) {
      throw navigatorUnavailableError("model", error);
    }
    let parsed;
    try {
      parsed = parseNavigatorModelSetting(configured);
    } catch (error) {
      throw navigatorUnavailableError("model", error);
    }
    const model = context.modelRegistry.find(parsed.provider, parsed.model);
    const provider = context.modelRegistry.getProvider(parsed.provider);
    if (model === void 0 || provider === void 0) throw new NavigatorUnavailableError("model", `Navigator model is unavailable: ${configured}`);
    let auth;
    try {
      auth = await context.modelRegistry.getApiKeyAndHeaders(model);
    } catch (error) {
      throw navigatorUnavailableError("auth", error);
    }
    if (!auth.ok) throw new NavigatorUnavailableError("auth", auth.error);
    try {
      const sessionInfo = await stat(sessionDir);
      if (!sessionInfo.isDirectory()) throw new NavigatorUnavailableError("session", `Navigator session path is not a directory: ${sessionDir}`);
    } catch (error) {
      if (error instanceof NavigatorUnavailableError) throw error;
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw navigatorUnavailableError("session", error);
      }
    }
    let providerFailure;
    const assignProviderFailure = (fact) => {
      if (fact !== void 0) providerFailure = fact;
    };
    const classifyProviderStreamError = (error) => {
      if (!exactRecord(error)) {
        assignProviderFailure(navigatorProviderFailureFromError(error));
        return;
      }
      assignProviderFailure(navigatorProviderFailureFromDiagnostics(error.diagnostics));
      if (providerFailure !== void 0) return;
      if (error.role !== "assistant") assignProviderFailure(navigatorProviderFailureFromError(error));
    };
    const classifyProviderResponseStatus = (status) => {
      if (status >= 200 && status < 300) {
        if (providerFailure?.source === "auth" || providerFailure?.source === "quota") {
          providerFailure = void 0;
        }
        return;
      }
      assignProviderFailure(navigatorProviderFailureFromStatus(status));
    };
    const humanProviderError = (error) => {
      const human = { ...error };
      delete human.statusCode;
      delete human.code;
      delete human.navigatorFailure;
      return human;
    };
    let providerFailureEvidenceNumber = 0;
    let providerFailureEvidence;
    const retainProviderFailure = (error) => {
      const id = `navigator-provider-failure-${++providerFailureEvidenceNumber}`;
      providerFailureEvidence = { id, error };
      return id;
    };
    const setupFailureMessage = (error) => ({
      role: "assistant",
      content: [],
      api: "unknown",
      provider: "unknown",
      model: "unknown",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "error",
      errorMessage: error instanceof Error ? error.message : String(error),
      navigatorFailureEvidenceId: retainProviderFailure(error),
      timestamp: Date.now()
    });
    const instrumentProvider = (sourceProvider) => {
      const instrumentStreamOptions = (options) => {
        const record = exactRecord(options) ? options : {};
        const previous = typeof record.onResponse === "function" ? record.onResponse : void 0;
        return {
          ...record,
          onResponse: async (response, model2) => {
            classifyProviderResponseStatus(response.status);
            await previous?.(response, model2);
          }
        };
      };
      const wrapProviderStream = (source) => {
        const wrapped = createAssistantMessageEventStream();
        void (async () => {
          let result;
          let sawTerminal = false;
          try {
            for await (const event of source) {
              if (event.type === "done" || event.type === "error") {
                sawTerminal = true;
                if (event.type === "done" && exactRecord(event.message)) {
                  assignProviderFailure(navigatorProviderFailureFromDiagnostics(event.message.diagnostics));
                  result = humanProviderError(event.message);
                  wrapped.push({ ...event, message: result });
                  continue;
                }
                if (event.type === "error" && exactRecord(event.error)) {
                  classifyProviderStreamError(event.error);
                  result = humanProviderError(event.error);
                  wrapped.push({ ...event, error: result });
                  continue;
                }
              }
              wrapped.push(event);
            }
            if (sawTerminal) {
              const terminal = await source.result();
              if (result === void 0 && exactRecord(terminal)) result = humanProviderError(terminal);
              else if (result === void 0) result = terminal;
            }
          } catch (error) {
            classifyProviderStreamError(error);
            if (providerFailure === void 0) providerFailure = { source: "transport", cause: "transport" };
            if (!sawTerminal) {
              const message = setupFailureMessage(error);
              wrapped.push({ type: "error", reason: "error", error: message });
              result = message;
              sawTerminal = true;
            }
          } finally {
            if (!sawTerminal) {
              if (providerFailure === void 0) providerFailure = { source: "transport", cause: "transport" };
              const message = setupFailureMessage(new Error("Navigator provider produced no response"));
              wrapped.push({ type: "error", reason: "error", error: message });
              result = message;
              sawTerminal = true;
            }
            wrapped.end(result);
          }
        })();
        return wrapped;
      };
      const invokeInstrumentedStream = (invoke) => {
        providerFailure = void 0;
        try {
          return wrapProviderStream(invoke());
        } catch (error) {
          classifyProviderStreamError(error);
          if (providerFailure === void 0) providerFailure = { source: "transport", cause: "transport" };
          const wrapped = createAssistantMessageEventStream();
          const message = setupFailureMessage(error);
          queueMicrotask(() => {
            wrapped.push({ type: "error", reason: "error", error: message });
            wrapped.end(message);
          });
          return wrapped;
        }
      };
      return {
        ...sourceProvider,
        stream(model2, streamContext, options) {
          const instrumented = instrumentStreamOptions(options);
          return invokeInstrumentedStream(() => sourceProvider.stream(model2, streamContext, instrumented));
        },
        streamSimple(model2, streamContext, options) {
          const instrumented = instrumentStreamOptions(options);
          return invokeInstrumentedStream(() => sourceProvider.streamSimple(model2, streamContext, instrumented));
        }
      };
    };
    let modelRuntime;
    try {
      modelRuntime = await sharedModelRuntime;
      modelRuntime.registerNativeProvider(instrumentProvider(provider));
    } catch (error) {
      throw navigatorUnavailableError("session", error);
    }
    let opened;
    try {
      opened = await openInProcessAgentSession({
        cwd: context.cwd,
        model,
        modelRuntime,
        thinkingLevel: parsed.thinkingLevel,
        sessionManager: SessionManager.continueRecent(context.cwd, sessionDir),
        noTools: "all",
        tools: [NAVIGATOR_PREPARE_TOOL_NAME],
        customTools: [tool]
      });
    } catch (error) {
      throw navigatorUnavailableError("session", error);
    }
    if (opened.session.thinkingLevel !== parsed.thinkingLevel) {
      opened.dispose();
      throw new NavigatorUnavailableError("thinking", `Navigator thinking level ${parsed.thinkingLevel} is unavailable for ${configured}`);
    }
    return {
      prompt: async (text) => {
        try {
          await opened.session.prompt(text);
        } catch (error) {
          throw navigatorUnavailableError("transport", error);
        }
      },
      providerFailure: () => providerFailure,
      appendEntry: (customType, data) => {
        opened.session.sessionManager.appendCustomEntry(customType, data);
      },
      entries: () => opened.session.sessionManager.getEntries(),
      setModel: async (next, thinkingLevel) => {
        let nextParsed;
        try {
          nextParsed = parseNavigatorModelSetting(next);
        } catch (error) {
          throw navigatorUnavailableError("model", error);
        }
        const nextModel = context.modelRegistry.find(nextParsed.provider, nextParsed.model);
        const nextProvider = context.modelRegistry.getProvider(nextParsed.provider);
        if (nextModel === void 0 || nextProvider === void 0) throw new NavigatorUnavailableError("model", `Navigator model is unavailable: ${next}`);
        let nextAuth;
        try {
          nextAuth = await context.modelRegistry.getApiKeyAndHeaders(nextModel);
        } catch (error) {
          throw navigatorUnavailableError("auth", error);
        }
        if (!nextAuth.ok) throw new NavigatorUnavailableError("auth", nextAuth.error);
        try {
          modelRuntime.registerNativeProvider(instrumentProvider(nextProvider));
          await opened.session.setModel(nextModel);
          opened.session.setThinkingLevel(thinkingLevel);
        } catch (error) {
          throw navigatorUnavailableError("session", error);
        }
        if (opened.session.thinkingLevel !== nextParsed.thinkingLevel || opened.session.thinkingLevel !== thinkingLevel) {
          throw new NavigatorUnavailableError("thinking", `Navigator thinking level ${thinkingLevel} is unavailable for ${next}`);
        }
      },
      getThinkingLevel: () => opened.session.thinkingLevel,
      dispose: () => opened.dispose()
    };
  };
}
function registerNavigatorModelCommand(pi, path = navigatorModelSettingPath()) {
  pi.registerCommand("navigator-model", {
    description: "Set the persistent Navigator model (provider/model[:max]).",
    handler: async (args) => {
      await writeNavigatorModelSetting(args.trim(), path);
    }
  });
}
function navigatorSessionDirectory(context, subjectKey) {
  const current = context.sessionManager.getSessionDir();
  const key = subjectKey ?? subjectPath(current, context.cwd);
  return subjectDirectory(context.cwd, key);
}
export {
  NAVIGATOR_DEFAULT_MODEL,
  NAVIGATOR_EVENT_TYPE,
  NAVIGATOR_PREPARE_TOOL_NAME,
  NAVIGATOR_TARGETS,
  NavigatorUnavailableError,
  createNativeNavigatorSessionFactory,
  createNavigatorAttendance,
  createNavigatorPrepareTool,
  decorateSettlementWithNavigation,
  formatNavigatorReport,
  navigatorAdviceConsistentWithSettlement,
  navigatorModelSettingPath,
  navigatorProviderFailure,
  navigatorProviderFailureFromError,
  navigatorSessionDirectory,
  navigatorSubjectKey,
  navigatorSubjectKeyForInput,
  navigatorUnavailableError,
  parseNavigatorModelSetting,
  readNavigatorModelSetting,
  registerNavigatorModelCommand,
  selectNavigatorCandidate,
  settlementNavigationFromEvent,
  subjectPath,
  writeNavigatorModelSetting
};
