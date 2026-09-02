import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
} from "@earendil-works/pi-ai";
import {
  AUDITOR_COMPLIANCE_FAILURE_ENTRY_TYPE,
  AUDITOR_PARENT_ATTEMPT_BINDING_ENTRY_TYPE
} from "./compliance-transport.js";
import { auditorRunDirectory } from "./auditor-dossier-tool.js";
import { sitianReport } from "./sitian-facade.js";
import { createEngineDetourToolDefinition } from "./engine-detour-tool.js";
import { engineNameFromEnv } from "./engine-detour.js";
import {
  appendEngineSessionMaterial,
  engineSessionMaterialFromOptions
} from "./package-resources/engine-material.js";
import { readPackageMaterial } from "./session-opening-materials.js";
import {
} from "./public-cli/config.js";
import { readInstitutionalSeatSelection } from "./institutional-resolution.js";
import {
  NAVIGATOR_PREPARE_TOOL_NAME,
  NavigatorUnavailableError,
  navigatorModelSettingPath,
  navigatorProviderFailureFromDiagnostics,
  navigatorProviderFailureFromError,
  navigatorProviderFailureFromStatus,
  navigatorUnavailableError,
  parseNavigatorModelSetting,
  resolveNavigatorSeatSelection
} from "./navigator-session-contracts.js";
import { createReceiptDeliveryPolicy, NO_RECEIPT_LIFECYCLE_ENTRY_TYPE, RECEIPT_DELIVERY_PROMPT } from "./receipt-delivery-policy.js";
import { recordTypedProviderHttpStatus } from "./typed-provider-http.js";
import {
  hasUpstreamErrorTestimony,
  isNonSuccessHttpStatus,
  projectConfirmedRemotePayload
} from "./upstream-error-testimony.js";
const EVIDENCE_CHILD_SESSION_MATERIALS = [
  "souls/quality-law.md"
];
async function buildEvidenceChildSystemPrompt(engineMaterial) {
  const materials = [];
  for (const relativePath of EVIDENCE_CHILD_SESSION_MATERIALS) {
    materials.push(await readPackageMaterial(relativePath));
  }
  return appendEngineSessionMaterial(materials, engineMaterial).join("\n");
}
const AUDITOR_TURN_LIMIT = 32;
const DEFAULT_COMPLIANCE_IDLE_MAX_RETRIES = 2;
class AuditorTurnLimitError extends Error {
  constructor(limit, observedTurns, lastResponse) {
    super(observedTurns === void 0 ? `Auditor exceeded ${limit} turns` : `Auditor exhausted its ${limit}-turn limit after ${observedTurns} provider turns`);
    this.limit = limit;
    this.observedTurns = observedTurns;
    this.lastResponse = lastResponse;
    this.name = "AuditorTurnLimitError";
  }
  limit;
  observedTurns;
  lastResponse;
}
async function withInProcessScratch(options, run) {
  const scratch = await mkdtemp(join(options.parentDirectory ?? tmpdir(), options.prefix));
  let failure;
  try {
    return await run(scratch);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try {
      await rm(scratch, { recursive: true, force: true });
    } catch (cleanupFailure) {
      if (failure !== void 0) {
        throw new AggregateError([failure, cleanupFailure], "in-process child scratch cleanup failed", { cause: failure });
      }
      throw cleanupFailure;
    }
  }
}
async function runChildCleanup(cleanups, primaryFailure, label) {
  let cleanupFailure;
  for (const cleanup of cleanups) {
    try {
      await cleanup();
    } catch (failure) {
      cleanupFailure = cleanupFailure === void 0 ? failure : new AggregateError([cleanupFailure, failure], `${label} cleanup failed`, {
        cause: cleanupFailure
      });
    }
  }
  if (cleanupFailure === void 0) return;
  if (primaryFailure !== void 0) {
    throw new AggregateError(
      [primaryFailure, cleanupFailure],
      `${label} execution and cleanup failed`,
      { cause: primaryFailure }
    );
  }
  throw new AggregateError([cleanupFailure], `${label} cleanup failed`, {
    cause: cleanupFailure
  });
}
function numericHttpStatus(value) {
  return isNonSuccessHttpStatus(value) ? value : void 0;
}
function projectStructuredRemote(error) {
  let httpStatus;
  let diagnostics;
  let body;
  let code;
  let errno;
  let cursor = error;
  const seen = /* @__PURE__ */ new Set();
  while (typeof cursor === "object" && cursor !== null && !seen.has(cursor)) {
    seen.add(cursor);
    const record = cursor;
    const nodeStatus = numericHttpStatus(record.statusCode) ?? numericHttpStatus(record.status) ?? numericHttpStatus(record.httpStatus);
    const nodeDiagnostics = Array.isArray(record.diagnostics) && record.diagnostics.length > 0 ? record.diagnostics : void 0;
    const nodeHasTestimony = hasUpstreamErrorTestimony({
      ...nodeStatus === void 0 ? {} : { httpStatus: nodeStatus },
      ...nodeDiagnostics === void 0 ? {} : { diagnostics: nodeDiagnostics }
    });
    if (httpStatus === void 0 && nodeStatus !== void 0) httpStatus = nodeStatus;
    if (diagnostics === void 0 && nodeDiagnostics !== void 0) diagnostics = nodeDiagnostics;
    if (nodeHasTestimony) {
      const payload = projectConfirmedRemotePayload(record);
      if (body === void 0 && payload.body !== void 0) body = payload.body;
      if (code === void 0 && payload.code !== void 0) code = payload.code;
      if (errno === void 0 && payload.errno !== void 0) errno = payload.errno;
    }
    cursor = record.cause;
  }
  return {
    hasTestimony: hasUpstreamErrorTestimony({
      ...httpStatus === void 0 ? {} : { httpStatus },
      ...diagnostics === void 0 ? {} : { diagnostics }
    }),
    ...httpStatus === void 0 ? {} : { httpStatus },
    ...diagnostics === void 0 ? {} : { diagnostics },
    ...body === void 0 ? {} : { body },
    ...code === void 0 ? {} : { code },
    ...errno === void 0 ? {} : { errno }
  };
}
function attachObservedHttpStatus(message, observedHttpStatus) {
  if (observedHttpStatus === void 0) return message;
  if (message.stopReason !== "error" && message.stopReason !== "aborted") return message;
  if (numericHttpStatus(observedHttpStatus) === void 0) return message;
  if (projectStructuredRemote(message).httpStatus !== void 0) return message;
  return Object.assign(message, {
    status: observedHttpStatus,
    statusCode: observedHttpStatus
  });
}
function enrichStreamEvent(event, observedHttpStatus) {
  if (observedHttpStatus === void 0 || event === null || typeof event !== "object") return event;
  const record = event;
  if (record.type === "error" && record.error !== null && typeof record.error === "object") {
    return {
      ...record,
      error: attachObservedHttpStatus(record.error, observedHttpStatus)
    };
  }
  if (record.type === "done" && record.message !== null && typeof record.message === "object") {
    return {
      ...record,
      message: attachObservedHttpStatus(record.message, observedHttpStatus)
    };
  }
  if (record.partial !== null && typeof record.partial === "object") {
    return {
      ...record,
      partial: attachObservedHttpStatus(record.partial, observedHttpStatus)
    };
  }
  return event;
}
function classifiedError(error, evidenceChildFailure) {
  const diagnostic = typeof error === "object" && error !== null && typeof error.errorMessage === "string" ? error.errorMessage : error === void 0 ? "" : String(error);
  const wrapped = error instanceof Error ? error : Object.assign(new Error(diagnostic, { cause: error }), { evidenceChildOriginal: error });
  const classification = "evidenceChildFailure" in wrapped ? wrapped.evidenceChildFailure : evidenceChildFailure === "provider" && !projectStructuredRemote(error).hasTestimony ? "unknown" : evidenceChildFailure;
  return Object.assign(wrapped, { evidenceChildFailure: classification });
}
function extractToolResultText(details) {
  if (typeof details !== "object" || details === null) return void 0;
  const record = details;
  const content = record.content;
  if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part === "object" && part !== null) {
        const text = part.text;
        if (typeof text === "string" && text.trim() !== "") return text;
      }
    }
  }
  return void 0;
}
function emptyUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  };
}
function addUsage(total, next) {
  total.input += next.input;
  total.output += next.output;
  total.cacheRead += next.cacheRead;
  total.cacheWrite += next.cacheWrite;
  total.totalTokens += next.totalTokens;
  total.cost.input += next.cost.input;
  total.cost.output += next.cost.output;
  total.cost.cacheRead += next.cost.cacheRead;
  total.cost.cacheWrite += next.cost.cacheWrite;
  total.cost.total += next.cost.total;
}
async function executeEvidenceChild(workspace, prompt, context, options = {}) {
  const signal = options.signal;
  const runDirectory = options.runDirectory ?? auditorRunDirectory(context);
  if (runDirectory === void 0) {
    throw new Error("Evidence child requires a run directory carrying the institutional resolution page");
  }
  const selection = await readInstitutionalSeatSelection(runDirectory, "evidenceChild");
  return withInProcessScratch(
    {
      prefix: "ak-evidence-child-",
      ...options.credentialScratchParent === void 0 ? {} : { parentDirectory: options.credentialScratchParent }
    },
    async (childConfigDir) => {
      const { openPiInstitutionalSession } = await import("./pi/in-process-session.js");
      const { createRecordSession } = await import("./archivist-record-entry.js");
      const engineName = engineNameFromEnv();
      const engineMaterial = engineName === void 0 ? void 0 : options.packageRoot === void 0 || options.packageRoot.trim() === "" ? Object.freeze({ name: engineName }) : engineSessionMaterialFromOptions({
        engine: engineName,
        packageRoot: options.packageRoot
      });
      let engineDetourFailure;
      const engineDetourTool = engineName === void 0 ? void 0 : createEngineDetourToolDefinition({
        engineName,
        fail(error) {
          engineDetourFailure ??= error instanceof Error ? error : new Error(String(error));
          throw engineDetourFailure;
        }
      });
      let opened;
      try {
        opened = await openPiInstitutionalSession({
          cwd: workspace,
          agentDir: childConfigDir,
          selection,
          systemPrompt: await buildEvidenceChildSystemPrompt(engineMaterial),
          ...engineDetourTool === void 0 ? {} : { customTools: [engineDetourTool] },
          sessionManager: createRecordSession({
            cwd: workspace,
            kind: "evidence-children",
            ...context.sessionManager === void 0 ? {} : { parent: context.sessionManager }
          }),
          ...signal === void 0 ? {} : { signal },
          label: "Evidence child"
        });
      } catch (error) {
        throw classifiedError(error, "provider");
      }
      const { handle } = opened;
      const usage = emptyUsage();
      const unsubscribe = handle.subscribe((event) => {
        if (event.type === "message_end" && event.role === "assistant") {
          if (event.usage) addUsage(usage, event.usage);
        }
      });
      const abortChild = () => {
        handle.abort();
      };
      if (signal?.aborted) abortChild();
      else signal?.addEventListener("abort", abortChild, { once: true });
      let primaryFailure;
      try {
        const delivered = prompt;
        let turnResult;
        try {
          turnResult = await handle.prompt(delivered);
        } catch (error) {
          if (engineDetourFailure !== void 0) {
            throw classifiedError(engineDetourFailure, "child");
          }
          throw classifiedError(error, "provider");
        }
        if (engineDetourFailure !== void 0) {
          throw classifiedError(engineDetourFailure, "child");
        }
        if (signal?.aborted) throw new Error("Evidence child was cancelled");
        const lastAssistant = turnResult.messages !== void 0 ? [...turnResult.messages].reverse().find((message) => message?.role === "assistant") : void 0;
        if (turnResult.stopReason === "error" || turnResult.stopReason === "aborted" || lastAssistant?.role === "assistant" && (lastAssistant.stopReason === "error" || lastAssistant.stopReason === "aborted")) {
          const errMsg = turnResult.errorMessage ?? lastAssistant?.errorMessage ?? "";
          throw classifiedError(
            new Error(errMsg, { cause: lastAssistant }),
            lastAssistant && projectStructuredRemote(lastAssistant).hasTestimony ? "provider" : "unknown"
          );
        }
        if (lastAssistant !== void 0 && lastAssistant.role !== "assistant") {
          throw classifiedError(
            new Error("Evidence child child terminated without a report", {
              cause: lastAssistant ?? turnResult.messages
            }),
            "child"
          );
        }
        const report = turnResult.text;
        if (report.trim().length === 0) {
          throw new Error("Evidence child returned a blank child report");
        }
        return { report, usage, prompt: delivered };
      } catch (error) {
        primaryFailure = classifiedError(error, "child");
        throw primaryFailure;
      } finally {
        signal?.removeEventListener("abort", abortChild);
        await runChildCleanup([() => unsubscribe(), () => handle.close()], primaryFailure, "Reviewer child");
      }
    }
  );
}
function auditorSeatKey(gateSeat) {
  return gateSeat ?? "auditor";
}
async function executeAuditorChild(options) {
  const { createRecordSession } = await import("./archivist-record-entry.js");
  const runDirectory = options.runDirectory ?? auditorRunDirectory(options.context);
  if (runDirectory === void 0) {
    throw new Error(`${options.roleLabel} requires a run directory carrying the institutional resolution page`);
  }
  const seat = auditorSeatKey(options.gateSeat);
  const selection = await readInstitutionalSeatSelection(runDirectory, seat);
  return withInProcessScratch({ prefix: "ak-auditor-role-" }, async (scratch) => {
    const cwd = options.context.cwd ?? process.cwd();
    let decision;
    let noReceiptLifecycle;
    let decisionSubmitted = false;
    let decisionCallId;
    let decisionToolFailure;
    const decisionToolFailures = /* @__PURE__ */ new Map();
    const delivery = createReceiptDeliveryPolicy();
    const tool = {
      ...options.tool,
      label: options.roleLabel,
      async execute(...args) {
        if (decisionSubmitted && decisionCallId !== args[0]) {
          throw new Error("Auditor decision was submitted more than once");
        }
        try {
          const result = await options.tool.execute(...args);
          delivery.recordAccepted();
          const rawDecision = args[1];
          const isMissingArgs = rawDecision === void 0 || typeof rawDecision === "object" && rawDecision !== null && !Array.isArray(rawDecision) && Object.keys(rawDecision).length === 0;
          decision = isMissingArgs ? void 0 : rawDecision;
          decisionCallId = args[0];
          decisionToolFailure = void 0;
          decisionToolFailures.delete(args[0]);
          decisionSubmitted = true;
          return { ...result, terminate: true };
        } catch (error) {
          decisionToolFailure = error;
          decisionToolFailures.set(args[0], error);
          throw error;
        }
      }
    };
    const parentSessionManager = options.context.sessionManager;
    const parentHeader = parentSessionManager?.getHeader?.();
    const parentSessionFile = parentSessionManager?.getSessionFile?.();
    const parentAttemptEntryId = parentSessionManager?.getLeafId?.();
    const auditorSessionManager = createRecordSession({
      cwd,
      kind: "auditor-roles",
      ...parentSessionManager === void 0 ? {} : { parent: parentSessionManager }
    });
    const { openPiInstitutionalSession } = await import("./pi/in-process-session.js");
    const evidenceToolFailures = /* @__PURE__ */ new Map();
    const wrappedDossierTool = {
      ...options.dossierTool,
      label: options.roleLabel,
      async execute(...args) {
        try {
          return await options.dossierTool.execute(...args);
        } catch (error) {
          evidenceToolFailures.set(args[0], error);
          throw error;
        }
      }
    };
    const opened = await openPiInstitutionalSession({
      cwd,
      agentDir: scratch,
      selection,
      systemPrompt: options.systemPrompt,
      customTools: [wrappedDossierTool, tool],
      sessionManager: auditorSessionManager,
      ...options.signal === void 0 ? {} : { signal: options.signal },
      idleRetry: true,
      label: options.roleLabel
    });
    const { handle } = opened;
    const binding = {
      version: 1,
      parent: {
        ...parentHeader?.id === void 0 ? {} : { sessionId: parentHeader.id },
        ...parentSessionFile === void 0 ? {} : { sessionFile: parentSessionFile },
        ...parentAttemptEntryId === null || parentAttemptEntryId === void 0 ? {} : { attemptEntryId: parentAttemptEntryId }
      }
    };
    auditorSessionManager.appendCustomEntry(AUDITOR_PARENT_ATTEMPT_BINDING_ENTRY_TYPE, binding);
    try {
      sitianReport({
        level: "event",
        kind: "auditor",
        cwd,
        sessionParent: parentSessionFile,
        payload: { type: AUDITOR_PARENT_ATTEMPT_BINDING_ENTRY_TYPE, ...binding },
        source: "evidence-child-executor"
      });
    } catch {
    }
    let turns = 0;
    const sessionUsage = emptyUsage();
    let boundaryResponse;
    let retentionFailure;
    let retainedResponse;
    let rejectedDecisionResponse;
    let promptNeighboringFailure;
    let promptDecisionFailures = [];
    const findToolFailure = (response) => {
      const callIds = response.content.flatMap((part) => part.type === "toolCall" && part.name !== tool.name ? [part.id] : []);
      for (const callId of callIds) {
        if (evidenceToolFailures.has(callId)) return evidenceToolFailures.get(callId);
      }
      return void 0;
    };
    const drainRejectedDecisionFailures = (response) => {
      for (const part of response.content) {
        if (part.type !== "toolCall" || part.name !== tool.name || !decisionToolFailures.has(part.id)) continue;
        decisionToolFailure = decisionToolFailures.get(part.id);
        promptDecisionFailures.push(decisionToolFailure);
        decisionToolFailures.delete(part.id);
      }
    };
    const retainedAssistants = [];
    const unsubscribe = handle.subscribe((event) => {
      if (event.type === "tool_result" && event.isError === true && event.toolName !== tool.name) {
        const detailText = extractToolResultText(event.details);
        if (detailText !== void 0 && /^Tool\s+.+ not found$/.test(detailText.trim())) return;
        const failure = detailText === void 0 ? new Error(event.toolName ?? "evidence tool failed") : new Error(detailText);
        const errno = /^([A-Z_]+):/.exec(detailText ?? "");
        if (errno !== null && errno[1] !== void 0) failure.code = errno[1];
        evidenceToolFailures.set(event.toolCallId, failure);
      }
      if (event.type === "message_end" && event.role === "assistant" && boundaryResponse === void 0) {
        turns += 1;
        if (event.usage) addUsage(sessionUsage, event.usage);
        const msg = event.message;
        retainedResponse = msg;
        if (msg) {
          retainedAssistants.push(msg);
          try {
            options.retainResponse?.(msg);
          } catch (error) {
            retentionFailure = error;
          }
          for (const part of msg.content) {
            if (part.type === "toolCall" && part.name === tool.name) {
              rejectedDecisionResponse = msg;
              if (decision === void 0) {
                decision = part.arguments === void 0 || typeof part.arguments === "object" && part.arguments !== null && !Array.isArray(part.arguments) && Object.keys(part.arguments).length === 0 ? void 0 : part.arguments;
                decisionCallId = part.id;
                if (part.arguments === void 0 || typeof part.arguments === "object" && part.arguments !== null && !Array.isArray(part.arguments) && Object.keys(part.arguments).length === 0) {
                  decisionSubmitted = true;
                }
              }
            }
          }
          if (turns >= AUDITOR_TURN_LIMIT || msg.stopReason === "error") boundaryResponse = msg;
        }
      }
      if (event.type === "turn_end") {
        if (rejectedDecisionResponse !== void 0) {
          promptNeighboringFailure = findToolFailure(rejectedDecisionResponse);
          drainRejectedDecisionFailures(rejectedDecisionResponse);
        }
        if (decisionSubmitted || promptNeighboringFailure !== void 0 || boundaryResponse !== void 0 && rejectedDecisionResponse === void 0 || retentionFailure !== void 0) {
          handle.abort();
        }
      }
    });
    const abort = () => {
      handle.abort();
    };
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });
    let auditorFailure;
    try {
      try {
        const promptAllowingRejectedDecision = async (prompt) => {
          rejectedDecisionResponse = void 0;
          promptNeighboringFailure = void 0;
          decisionToolFailure = void 0;
          promptDecisionFailures = [];
          let promptFailure;
          try {
            await handle.prompt(prompt);
          } catch (error) {
            promptFailure = error;
          }
          const correlatedResponse = rejectedDecisionResponse;
          if (correlatedResponse !== void 0) {
            promptNeighboringFailure ??= findToolFailure(correlatedResponse);
            drainRejectedDecisionFailures(correlatedResponse);
          }
          if (promptNeighboringFailure !== void 0) throw promptNeighboringFailure;
          if (decisionSubmitted) {
            decisionToolFailure = void 0;
            return;
          }
          if (decisionToolFailure !== void 0) return;
          if (retentionFailure !== void 0) return;
          if (opened.streamFailure !== void 0) throw opened.streamFailure;
          if (promptFailure !== void 0) throw promptFailure;
        };
        const chargeAndClearRejectedDecisionFailures = (failures) => {
          for (const failure of failures) {
            delivery.recordRejected(failure instanceof Error ? failure.message : String(failure));
          }
          decisionToolFailure = void 0;
          promptDecisionFailures = [];
        };
        await promptAllowingRejectedDecision(options.prompt);
        while (!decisionSubmitted && retentionFailure === void 0 && (boundaryResponse === void 0 || decisionToolFailure !== void 0) && opened.streamFailure === void 0 && delivery.nextAction() === "request-delivery") {
          if (decisionToolFailure !== void 0) {
            const failures = promptDecisionFailures.length === 0 ? [decisionToolFailure] : promptDecisionFailures;
            chargeAndClearRejectedDecisionFailures(failures);
            if (delivery.nextAction() === "no-receipt") boundaryResponse = void 0;
            if (delivery.nextAction() === "request-delivery") {
              if (retainedResponse === rejectedDecisionResponse) {
                await promptAllowingRejectedDecision(RECEIPT_DELIVERY_PROMPT);
                chargeAndClearRejectedDecisionFailures(promptDecisionFailures);
              }
            }
          } else {
            delivery.recordDeliveryRequest();
            await promptAllowingRejectedDecision(RECEIPT_DELIVERY_PROMPT);
          }
        }
        if (!decisionSubmitted && retentionFailure === void 0 && opened.streamFailure === void 0 && delivery.nextAction() === "no-receipt") {
          const runPointer = options.context.sessionManager.getSessionFile() ?? options.context.cwd ?? process.cwd();
          const attemptPointer = binding.parent.attemptEntryId ?? binding.parent.sessionId ?? `current:${runPointer}`;
          const facts = delivery.facts({ runPointer, attemptPointer });
          decision = facts;
          decisionToolFailure = void 0;
          auditorSessionManager.appendCustomEntry(NO_RECEIPT_LIFECYCLE_ENTRY_TYPE, facts);
          try {
            sitianReport({
              level: "event",
              kind: "auditor",
              cwd,
              sessionParent: parentSessionFile,
              payload: { type: NO_RECEIPT_LIFECYCLE_ENTRY_TYPE, ...facts },
              source: "evidence-child-executor"
            });
          } catch {
          }
          noReceiptLifecycle = facts;
        }
      } catch (error) {
        if (options.signal?.aborted) throw options.signal.reason;
        if (retentionFailure === void 0 && opened.streamFailure !== void 0) throw opened.streamFailure;
        if (retentionFailure === void 0) throw error;
      }
      if (options.signal?.aborted) throw options.signal.reason;
      if (retentionFailure === void 0 && opened.streamFailure !== void 0) throw opened.streamFailure;
      if (!decisionSubmitted && decisionToolFailure !== void 0) throw decisionToolFailure;
      const relevantResponse = !decisionSubmitted ? boundaryResponse : retainedResponse && retainedResponse.role === "assistant" && retainedResponse.content.some((part) => part.type === "toolCall" && part.name === tool.name) ? retainedResponse : void 0;
      if (relevantResponse !== void 0) {
        const toolFailure = findToolFailure(relevantResponse);
        if (toolFailure !== void 0) throw toolFailure;
      }
      const assistants = [...retainedAssistants].reverse();
      const response = !decisionSubmitted ? assistants[0] : assistants.find((message) => message.content.some((part) => part.type === "toolCall" && part.name === tool.name));
      if (boundaryResponse !== void 0 && boundaryResponse.stopReason !== "error" && !decisionSubmitted && noReceiptLifecycle === void 0) {
        const toolNames = boundaryResponse.content.flatMap((part) => part.type === "toolCall" ? [part.name] : []);
        throw new AuditorTurnLimitError(AUDITOR_TURN_LIMIT, turns, {
          stopReason: boundaryResponse.stopReason,
          toolNames
        });
      }
      if (response !== void 0) {
        try {
          if (retentionFailure !== void 0) throw retentionFailure;
          if (retainedResponse === void 0) options.retainResponse?.(response);
        } catch (retentionFailure2) {
          if (response.stopReason !== "error") throw retentionFailure2;
          const diagnostic = typeof response.errorMessage === "string" && response.errorMessage.trim() !== "" ? response.errorMessage : void 0;
          const projected = projectStructuredRemote(response);
          const failure = new Error(
            diagnostic ?? "",
            { cause: retentionFailure2 }
          );
          if (projected.hasTestimony && (response.model || response.provider)) {
            failure.name = response.model || response.provider || "Error";
            failure.failureCode = response.provider || response.model;
          }
          failure.knownCause = projected.hasTestimony ? "provider" : "unrecognized";
          const retentionError = retentionFailure2 instanceof Error ? retentionFailure2 : void 0;
          const retentionCause = retentionError?.cause;
          failure.details = {
            ...diagnostic === void 0 ? {} : { errorMessage: diagnostic },
            ...projected.hasTestimony && response.provider ? { provider: response.provider } : {},
            ...projected.hasTestimony && response.model ? { model: response.model } : {},
            ...response.api ? { api: response.api } : {},
            ...response.rawStopReason ? { rawStopReason: response.rawStopReason } : {},
            ...projected.httpStatus === void 0 ? {} : { httpStatus: projected.httpStatus },
            ...projected.diagnostics === void 0 ? {} : { diagnostics: projected.diagnostics },
            ...projected.body === void 0 ? {} : { body: projected.body },
            ...projected.code === void 0 ? {} : { code: projected.code },
            ...projected.errno === void 0 ? {} : { errno: projected.errno },
            retentionFailure: {
              name: retentionError?.name ?? typeof retentionFailure2,
              message: retentionError?.message ?? String(retentionFailure2),
              ...retentionError?.code !== void 0 ? { code: retentionError.code } : {},
              ...retentionCause === void 0 ? {} : {
                cause: retentionCause instanceof Error ? {
                  name: retentionCause.name,
                  message: retentionCause.message,
                  ...retentionCause.code === void 0 ? {} : { code: retentionCause.code }
                } : retentionCause
              }
            }
          };
          const failureData = {
            version: 1,
            parent: binding.parent,
            failure: {
              cause: failure.knownCause,
              ...failure.failureCode === void 0 ? {} : { identity: { name: failure.name, code: failure.failureCode } },
              ...failure.message === "" ? {} : { diagnostic: failure.message },
              details: failure.details
            }
          };
          auditorSessionManager.appendCustomEntry(AUDITOR_COMPLIANCE_FAILURE_ENTRY_TYPE, failureData);
          try {
            sitianReport({
              level: "event",
              kind: "auditor",
              cwd,
              sessionParent: parentSessionFile,
              payload: { type: AUDITOR_COMPLIANCE_FAILURE_ENTRY_TYPE, ...failureData },
              source: "evidence-child-executor"
            });
          } catch {
          }
          throw failure;
        }
      }
      if (response === void 0 || response.stopReason === "error" || !decisionSubmitted && (response.stopReason === "aborted" || decision === void 0)) {
        throw new Error(response?.errorMessage ?? `${options.roleLabel} exited without a readable decision receipt`);
      }
      return {
        decision,
        response: { ...response, usage: sessionUsage },
        ...noReceiptLifecycle === void 0 ? {} : { noReceiptLifecycle }
      };
    } catch (error) {
      auditorFailure = error;
      throw error;
    } finally {
      options.signal?.removeEventListener("abort", abort);
      await runChildCleanup([() => unsubscribe(), () => handle.close()], auditorFailure, options.roleLabel);
    }
  });
}
function exactRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function createNativeNavigatorSessionFactory(defaultModelSettingPath = navigatorModelSettingPath()) {
  return async ({ context, subject, modelSettingPath, tool }) => {
    const resolved = await resolveNavigatorSeatSelection(context, modelSettingPath, defaultModelSettingPath);
    let selection = resolved.selection;
    let thinkingLevel = resolved.thinkingLevel;
    let configuredLabel = resolved.configuredLabel;
    const { createRecordSession } = await import("./archivist-record-entry.js");
    const sessionManager = createRecordSession({
      cwd: context.cwd,
      kind: "navigator",
      subject,
      parent: context.sessionManager
    });
    let providerFailure;
    let observationWrite = Promise.resolve();
    const assignProviderFailure = (fact) => {
      if (fact !== void 0) providerFailure = fact;
    };
    const classifyTerminalMessage = (message) => {
      if (!exactRecord(message)) {
        assignProviderFailure(navigatorProviderFailureFromError(message));
        return;
      }
      assignProviderFailure(navigatorProviderFailureFromDiagnostics(message.diagnostics));
      if (providerFailure !== void 0) return;
      if (message.role !== "assistant") assignProviderFailure(navigatorProviderFailureFromError(message));
      if (providerFailure !== void 0) return;
      const status = typeof message.statusCode === "number" ? message.statusCode : typeof message.status === "number" ? message.status : typeof message.httpStatus === "number" ? message.httpStatus : void 0;
      if (typeof status === "number") {
        assignProviderFailure(navigatorProviderFailureFromStatus(status));
        if (providerFailure === void 0 && status >= 400 && status < 600) {
          assignProviderFailure({ source: "transport", cause: "transport" });
        }
        const runDir = process.env.AK_ROLE_RUN_DIR;
        const provider = typeof message.provider === "string" && message.provider.trim() !== "" ? message.provider : selection.provider;
        if (typeof runDir === "string" && runDir.trim() !== "" && provider.trim() !== "") {
          observationWrite = observationWrite.then(
            () => recordTypedProviderHttpStatus(runDir, { httpStatus: status, provider })
          );
        }
      }
    };
    const { openPiInstitutionalSession } = await import("./pi/in-process-session.js");
    let opened;
    try {
      opened = await openPiInstitutionalSession({
        cwd: context.cwd,
        selection,
        systemPrompt: "",
        noTools: "all",
        toolsAllowlist: [NAVIGATOR_PREPARE_TOOL_NAME],
        customTools: [tool],
        sessionManager,
        label: "Navigator"
      });
    } catch (error) {
      const fact = navigatorProviderFailureFromError(error);
      throw navigatorUnavailableError(fact?.source ?? "session", error, fact?.cause ?? "session");
    }
    const unsubscribe = opened.handle.subscribe((event) => {
      if (event.type === "message_end" && event.message !== void 0) {
        const message = event.message;
        if (exactRecord(message) && (message.stopReason === "error" || message.stopReason === "aborted")) {
          classifyTerminalMessage(message);
        }
      }
    });
    let disposal;
    const dispose = () => {
      if (disposal === void 0) {
        disposal = runChildCleanup(
          [() => unsubscribe(), () => opened.handle.close()],
          void 0,
          "Navigator"
        );
      }
      return disposal;
    };
    return {
      prompt: async (text) => {
        providerFailure = void 0;
        observationWrite = Promise.resolve();
        const failFrom = (error) => {
          if (providerFailure === void 0) {
            assignProviderFailure({ source: "transport", cause: "transport" });
          }
          const fact = providerFailure;
          throw navigatorUnavailableError(fact.source, error, fact.cause);
        };
        let terminal;
        try {
          const turn = await opened.handle.prompt(text);
          if (turn.stopReason === "error" || turn.stopReason === "aborted") {
            const cause = turn.errorMessage ?? opened.streamFailure ?? "Navigator provider failure";
            if (providerFailure === void 0 && opened.streamFailure !== void 0) {
              classifyTerminalMessage(opened.streamFailure);
            }
            if (providerFailure === void 0) {
              assignProviderFailure(navigatorProviderFailureFromError(
                typeof cause === "object" && cause !== null ? cause : new Error(String(cause))
              ));
            }
            terminal = cause;
          } else if (opened.streamFailure !== void 0) {
            if (providerFailure === void 0) classifyTerminalMessage(opened.streamFailure);
            terminal = opened.streamFailure;
          }
        } catch (error) {
          if (error instanceof NavigatorUnavailableError) throw error;
          if (providerFailure === void 0) classifyTerminalMessage(error);
          terminal = error;
        }
        await observationWrite;
        if (terminal !== void 0) failFrom(terminal);
      },
      providerFailure: () => providerFailure,
      appendEntry: (customType, data) => {
        sessionManager.appendCustomEntry(customType, data);
        try {
          sitianReport({
            level: "event",
            kind: "attendance",
            cwd: context.cwd,
            sessionParent: sessionManager.getSessionFile(),
            payload: { customType, data },
            source: "evidence-child-executor"
          });
        } catch {
        }
      },
      entries: () => sessionManager.getEntries(),
      setModel: async (next, nextThinking) => {
        let nextParsed;
        try {
          nextParsed = parseNavigatorModelSetting(next);
        } catch (error) {
          throw navigatorUnavailableError("model", error);
        }
        if (nextParsed.provider !== selection.provider || nextParsed.model !== selection.model) {
          throw new NavigatorUnavailableError(
            "model",
            `Navigator model switch requires a new session: ${configuredLabel} \u2192 ${next}`
          );
        }
        if (nextParsed.thinkingLevel !== nextThinking || thinkingLevel !== nextThinking) {
          throw new NavigatorUnavailableError(
            "thinking",
            `Navigator thinking level ${nextThinking} is unavailable for ${next}`
          );
        }
        selection = {
          provider: nextParsed.provider,
          model: nextParsed.model,
          thinking: nextParsed.thinkingLevel
        };
        thinkingLevel = nextParsed.thinkingLevel;
        configuredLabel = next;
      },
      getThinkingLevel: () => thinkingLevel,
      recordPointer: () => sessionManager.getSessionDir(),
      dispose
    };
  };
}
export {
  AUDITOR_TURN_LIMIT,
  AuditorTurnLimitError,
  DEFAULT_COMPLIANCE_IDLE_MAX_RETRIES,
  createNativeNavigatorSessionFactory,
  executeAuditorChild,
  executeEvidenceChild,
  withInProcessScratch
};
