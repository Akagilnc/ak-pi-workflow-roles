import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  NAVIGATOR_INVOCATION_ENTRY,
  mintNavigatorInvocationId
} from "./navigator-invocation-identity.js";
import { PACKAGED_ROLE_REGISTRY, packagedRoleMetadata } from "./packaged-role-registry.js";
import {
  activationBookDirectory,
  resolveActivationLedgerHome
} from "./activation-ledger-topology.js";
import { createNativeNavigatorSessionFactory } from "./evidence-child-executor.js";
import {
  NAVIGATOR_DEFAULT_MODEL,
  NAVIGATOR_PREPARE_TOOL_NAME,
  NavigatorUnavailableError,
  navigatorModelSettingPath,
  navigatorProviderFailure,
  navigatorProviderFailureFromDiagnostics,
  navigatorProviderFailureFromError,
  navigatorProviderFailureFromStatus,
  navigatorUnavailableError,
  parseNavigatorModelSetting,
  readNavigatorModelSetting,
  resolveNavigatorSeatSelection,
  writeNavigatorModelSetting
} from "./navigator-session-contracts.js";
import { sitianReport } from "./sitian-facade.js";
import { renderPublicAkRoleCommand } from "./public-command-renderer.js";
import { issueRoot, subjectPath } from "./work-subject-identity.js";
import { createReceiptDeliveryPolicy, NO_RECEIPT_LIFECYCLE_ENTRY_TYPE, RECEIPT_DELIVERY_PROMPT } from "./receipt-delivery-policy.js";
const NAVIGATOR_EVENT_TYPE = "ak-navigator-attendance";
const NAVIGATOR_PREPARE_ACCEPTED_TEXT = "\u6E38\u5955\u4F7F\u51C6\u5907\u5DF2\u63A5\u53D7";
function resolveNavigatorAuthorityMaterial(roleInput, fileAuthority) {
  if (roleInput !== void 0 && roleInput.trim() !== "") return roleInput;
  if (fileAuthority !== void 0 && fileAuthority.trim() !== "") return fileAuthority;
  return void 0;
}
const NAVIGATOR_TARGETS = PACKAGED_ROLE_REGISTRY.map(({ role, phases }) => ({ role, phases }));
const prepareSchema = Type.Object({
  candidates: Type.Optional(Type.Unknown({
    description: "\u65B9\u5411\u5019\u9009\uFF1Bcandidates[].next.role \u5FC5\u586B\uFF0Cphase \u53EF\u9009\uFF0Croute/matches/reason/command \u53EF\u9009\u4E0A\u4E0B\u6587\uFF0C\u975E\u53D7\u7406\u95F8"
  }))
}, { additionalProperties: true });
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
function createNavigatorPrepareTool(onOutput) {
  return {
    name: NAVIGATOR_PREPARE_TOOL_NAME,
    label: "\u6E38\u5955\u4F7F\u51C6\u5907",
    description: "\u63D0\u4EA4\u6E38\u5955\u4F7F\u65B9\u5411\u5EFA\u8BAE\u3002",
    parameters: prepareSchema,
    async execute(_id, value) {
      onOutput(value);
      return { content: [{ type: "text", text: NAVIGATOR_PREPARE_ACCEPTED_TEXT }], details: value, terminate: true };
    }
  };
}
function selectNavigatorCandidate(candidates, settlement) {
  if (settlement.kind !== "accepted") return void 0;
  const usable = candidates.filter((candidate) => candidate.next !== void 0);
  if (usable.length === 0) return void 0;
  const rolePhaseMatched = usable.filter(
    (candidate) => candidate.matches !== void 0 && candidate.matches.role === settlement.role && candidate.matches.phase === settlement.phase
  );
  if (rolePhaseMatched.length > 0) {
    if (settlement.status !== void 0) {
      const statusSpecific = rolePhaseMatched.find(
        (candidate) => candidate.matches?.statuses !== void 0 && candidate.matches.statuses.includes(settlement.status)
      );
      if (statusSpecific !== void 0) {
        return { candidate: statusSpecific, matchedToSettlement: true };
      }
    }
    const rolePhaseGeneric = rolePhaseMatched.find(
      (candidate) => candidate.matches?.statuses === void 0
    );
    if (rolePhaseGeneric !== void 0) {
      return { candidate: rolePhaseGeneric, matchedToSettlement: true };
    }
    return void 0;
  }
  const unbound = usable.find((candidate) => candidate.matches === void 0);
  if (unbound === void 0) return void 0;
  return { candidate: unbound, matchedToSettlement: false };
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
    preparationNoReceipt = false;
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
        const resolved = await resolveNavigatorSeatSelection(
          options.context,
          options.modelSettingPath,
          options.modelSettingPath ?? navigatorModelSettingPath()
        );
        return resolved.configuredLabel;
      } catch (error) {
        if (error instanceof NavigatorUnavailableError) throw error;
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
    let prepareBatchRejected = false;
    outputSink = (value) => {
      if (prepareBatchRejected || output !== void 0) {
        output = void 0;
        prepareBatchRejected = true;
        throw new Error("Navigator preparation must submit exactly one typed candidate batch");
      }
      output = value;
    };
    const tool = createNavigatorPrepareTool((value) => {
      outputSink?.(value);
    });
    if (session === void 0) {
      sessionReady = (async () => {
        let created;
        try {
          created = await options.createSession({ context: options.context, subject: subjectKey, ...options.modelSettingPath === void 0 ? {} : { modelSettingPath: options.modelSettingPath }, tool });
        } catch (error) {
          throw navigatorUnavailableError("session", error);
        }
        if (disposed) {
          await created.dispose();
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
          if (session !== created) await created.dispose();
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
      "\u672C\u6B21\u5BFC\u822A\u6750\u6599\u5982\u4E0B\uFF1A",
      `<navigator_soul>
${soul}
</navigator_soul>`,
      ...routePlaybookReadFailure === void 0 ? [`<route_playbook>
${routePlaybook}
</route_playbook>`] : ["\u53EF\u9009\u8DEF\u7EBF\u624B\u518C\u672A\u80FD\u8BFB\u53D6\u3002"],
      `<work_subject>
${subject}
</work_subject>`,
      `<controlling_authority>
${authority}
</controlling_authority>`,
      `<current_role>
${JSON.stringify({ role: options.role, phase: options.phase })}
</current_role>`,
      ...boundSettlement === void 0 ? [] : [`<current_settlement>
${JSON.stringify(boundSettlement)}
</current_settlement>`],
      `<prior_route>
${JSON.stringify(prior ?? null)}
</prior_route>`,
      `<public_settlement_history>
${JSON.stringify(projection.publicSettlementHistory)}
</public_settlement_history>`,
      `<live_role_help>
${helpContext}
</live_role_help>`
    ].join("\n\n");
    try {
      try {
        if (disposed) throw navigatorUnavailableError("session", new Error("Navigator attendance was disposed"));
        const delivery = createReceiptDeliveryPolicy();
        const promptAllowingRejectedPrepare = async (text, deliveryRequest) => {
          const entryStart = activeSession.entries().length;
          prepareBatchRejected = false;
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
            output = void 0;
            prepareBatchRejected = true;
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
          const facts = delivery.facts({ runPointer: activeSession.recordPointer(), attemptPointer: invocationId });
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
      let closing;
      if (next.subjectKey !== subjectKey && session !== void 0) {
        const previous = session;
        session = void 0;
        previousRoute = void 0;
        closing = previous.dispose();
      }
      subjectKey = next.subjectKey;
      subject = next.subject;
      authority = next.authority;
      contextError = next.contextError;
      return closing;
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
      const current = session;
      session = void 0;
      activeInvocationId = void 0;
      return current?.dispose();
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
        if (selected?.candidate.next !== void 0 && !selected.matchedToSettlement) {
          prepareBoundSettlement = settlement;
          prepared = await prepare();
          selected = selectNavigatorCandidate(prepared, settlement);
        }
        const selectedCandidate = selected?.candidate;
        if (selectedCandidate?.next === void 0 && preparationNoReceipt) {
          report = { disposition: "no-advice" };
        } else if (selectedCandidate?.next === void 0) {
          throw new Error("Navigator prepared no machine-usable next direction");
        } else {
          const selectedRoute = selectedCandidate.route;
          const routeChanged = selectedRoute !== void 0 && !routeEqual(previousRoute, selectedRoute);
          const command = renderPublicAkRoleCommand(selectedCandidate.next);
          report = {
            disposition: "recommendation",
            ...routeChanged ? { route: selectedRoute } : {},
            next: selectedCandidate.next,
            ...selectedCandidate.reason === void 0 ? {} : { reason: oneLine(selectedCandidate.reason) },
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
function registerNavigatorModelCommand(pi, path = navigatorModelSettingPath()) {
  pi.registerCommand("navigator-model", {
    description: "Set the persistent Navigator model (provider/model[:max]).",
    handler: async (args) => {
      await writeNavigatorModelSetting(args.trim(), path);
    }
  });
}
export {
  NAVIGATOR_DEFAULT_MODEL,
  NAVIGATOR_EVENT_TYPE,
  NAVIGATOR_PREPARE_ACCEPTED_TEXT,
  NAVIGATOR_PREPARE_TOOL_NAME,
  NAVIGATOR_TARGETS,
  NavigatorUnavailableError,
  createNativeNavigatorSessionFactory,
  createNavigatorAttendance,
  createNavigatorPrepareTool,
  decorateSettlementWithNavigation,
  formatNavigatorReport,
  navigatorModelSettingPath,
  navigatorProviderFailure,
  navigatorProviderFailureFromDiagnostics,
  navigatorProviderFailureFromError,
  navigatorProviderFailureFromStatus,
  navigatorSubjectKey,
  navigatorSubjectKeyForInput,
  navigatorUnavailableError,
  parseNavigatorModelSetting,
  readNavigatorModelSetting,
  registerNavigatorModelCommand,
  resolveNavigatorAuthorityMaterial,
  resolveNavigatorSeatSelection,
  selectNavigatorCandidate,
  settlementNavigationFromEvent,
  subjectPath,
  writeNavigatorModelSetting
};
