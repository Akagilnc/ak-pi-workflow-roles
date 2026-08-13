import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAssistantMessageEventStream,
  InMemoryCredentialStore
} from "@earendil-works/pi-ai";
import {
  AUDITOR_COMPLIANCE_FAILURE_ENTRY_TYPE,
  AUDITOR_PARENT_ATTEMPT_BINDING_ENTRY_TYPE,
  prepareComplianceDispatch
} from "./compliance-transport.js";
import { wrapPackageOwnedToolDefinition } from "./package-owned-tool-idle.js";
import { createStreamIdleGuard, isStreamIdleTimeoutError } from "./stream-idle-guard.js";
import { createReceiptDeliveryPolicy, NO_RECEIPT_LIFECYCLE_ENTRY_TYPE, RECEIPT_DELIVERY_PROMPT } from "./receipt-delivery-policy.js";
import {
  hasUpstreamErrorTestimony,
  isNonSuccessHttpStatus,
  projectConfirmedRemotePayload
} from "./upstream-error-testimony.js";
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
async function createInheritedRuntime(options) {
  const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
  const activeModel = options.context.model;
  if (activeModel === void 0) throw new Error(`${options.label} requires an active model`);
  const dispatch = await prepareComplianceDispatch(activeModel, options.context, options.label);
  const parentProvider = options.runCompletion === void 0 ? options.context.modelRegistry.getProvider(activeModel.provider) : void 0;
  if (parentProvider === void 0 && options.runCompletion === void 0) {
    throw new Error(`${options.label} provider not found: ${activeModel.provider}`);
  }
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null
  });
  const inheritedModel = options.runCompletion === void 0 ? dispatch.model : {
    ...dispatch.model,
    name: dispatch.model.name ?? dispatch.model.id,
    baseUrl: dispatch.model.baseUrl ?? "",
    reasoning: dispatch.model.reasoning ?? false,
    input: dispatch.model.input ?? ["text"],
    cost: dispatch.model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: dispatch.model.contextWindow ?? 1,
    maxTokens: dispatch.model.maxTokens ?? 1
  };
  const state = {
    runtime,
    model: inheritedModel,
    dispatch,
    streamFailure: void 0
  };
  const abortReason = (signal) => signal.reason ?? new Error(`${options.label} provider stream aborted`);
  async function waitForStream(promise, signal) {
    if (signal.aborted) throw abortReason(signal);
    let onAbort;
    try {
      return await Promise.race([
        promise,
        new Promise((_resolve, reject) => {
          onAbort = () => reject(abortReason(signal));
          signal.addEventListener("abort", onAbort, { once: true });
        })
      ]);
    } finally {
      if (onAbort !== void 0) signal.removeEventListener("abort", onAbort);
    }
  }
  const createRetriedStream = (simple, model, context, request) => {
    const wrapped = createAssistantMessageEventStream();
    void (async () => {
      for (let attempt = 0; ; attempt += 1) {
        const idle = createStreamIdleGuard(
          options.signal === void 0 ? {} : { parentSignal: options.signal }
        );
        let observedHttpStatus;
        try {
          const requestSignal = request?.signal;
          const streamSignal = requestSignal === void 0 ? idle.signal : AbortSignal.any([idle.signal, requestSignal]);
          const priorOnResponse = request?.onResponse;
          const inheritedRequest = {
            ...request ?? {},
            ...dispatch.auth.env === void 0 ? {} : { env: dispatch.auth.env },
            signal: streamSignal,
            onResponse: async (response2, model2) => {
              if (typeof response2?.status === "number") observedHttpStatus = response2.status;
              await priorOnResponse?.(response2, model2);
            }
          };
          if (options.runCompletion !== void 0) {
            await new Promise((resolve) => setImmediate(resolve));
            if (streamSignal.aborted) throw abortReason(streamSignal);
            const completed = await waitForStream(
              options.runCompletion(
                model,
                options.injectedSystemPrompt === void 0 ? context : { ...context, systemPrompt: options.injectedSystemPrompt },
                inheritedRequest
              ),
              streamSignal
            );
            const response2 = attachObservedHttpStatus({
              ...completed,
              api: model.api,
              provider: model.provider,
              model: model.id
            }, observedHttpStatus);
            if (response2.stopReason === "error" || response2.stopReason === "aborted") {
              wrapped.push({ type: "error", reason: response2.stopReason, error: response2 });
            } else {
              wrapped.end(response2);
            }
            return;
          }
          const source = simple ? parentProvider.streamSimple(model, context, inheritedRequest) : parentProvider.stream(model, context, inheritedRequest);
          let sawEvent = false;
          const iterator = source[Symbol.asyncIterator]();
          while (true) {
            const next = await waitForStream(iterator.next(), idle.signal);
            if (next.done) break;
            sawEvent = true;
            idle.poke();
            wrapped.push(enrichStreamEvent(next.value, observedHttpStatus));
          }
          const response = attachObservedHttpStatus(
            await waitForStream(source.result(), idle.signal),
            observedHttpStatus
          );
          if (!sawEvent) wrapped.end(response);
          return;
        } catch (error) {
          if (request?.signal?.aborted) {
            const response2 = {
              role: "assistant",
              content: [],
              api: model.api,
              provider: model.provider,
              model: model.id,
              usage: emptyUsage(),
              stopReason: "aborted",
              errorMessage: "Auditor session aborted",
              timestamp: Date.now()
            };
            wrapped.push({ type: "error", reason: "aborted", error: response2 });
            wrapped.end(response2);
            return;
          }
          const failure = isStreamIdleTimeoutError(idle.signal.reason) ? idle.signal.reason : error;
          if (options.idleRetry === true && isStreamIdleTimeoutError(failure) && attempt < DEFAULT_COMPLIANCE_IDLE_MAX_RETRIES && options.signal?.aborted !== true) {
            continue;
          }
          state.streamFailure = failure;
          const projected = projectStructuredRemote(failure);
          const httpStatus = projected.httpStatus ?? numericHttpStatus(observedHttpStatus);
          const response = {
            role: "assistant",
            content: [],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: emptyUsage(),
            stopReason: "error",
            // Preserve the held failure message bytes — do not rewrite.
            errorMessage: failure instanceof Error ? failure.message : String(failure),
            timestamp: Date.now(),
            ...projected.diagnostics === void 0 ? {} : { diagnostics: projected.diagnostics },
            ...httpStatus === void 0 ? {} : { status: httpStatus, statusCode: httpStatus },
            ...projected.body === void 0 ? {} : { body: projected.body },
            ...projected.code === void 0 ? {} : { code: projected.code },
            ...projected.errno === void 0 ? {} : { errno: projected.errno }
          };
          wrapped.push({ type: "error", reason: "error", error: response });
          wrapped.end(response);
          return;
        } finally {
          idle.dispose();
        }
      }
    })();
    return wrapped;
  };
  const provider = options.idleRetry === true || options.runCompletion !== void 0 ? {
    id: parentProvider?.id ?? activeModel.provider,
    name: parentProvider?.name ?? options.label,
    auth: {
      apiKey: {
        name: `Inherited ${options.label} authentication`,
        async resolve() {
          const { env, ...auth } = dispatch.auth;
          return {
            auth: {
              ...auth,
              ...dispatch.model.baseUrl === void 0 ? {} : { baseUrl: dispatch.model.baseUrl }
            },
            ...env === void 0 ? {} : { env }
          };
        }
      }
    },
    getModels() {
      return [inheritedModel];
    },
    stream(model, context, request) {
      return createRetriedStream(false, model, context, request);
    },
    streamSimple(model, context, request) {
      return createRetriedStream(true, model, context, request);
    }
  } : {
    id: parentProvider.id,
    name: parentProvider.name,
    ...parentProvider.baseUrl === void 0 ? {} : { baseUrl: parentProvider.baseUrl },
    ...parentProvider.headers === void 0 ? {} : { headers: parentProvider.headers },
    auth: {
      apiKey: {
        name: `Inherited ${options.label} authentication`,
        async resolve() {
          return {
            auth: {
              ...dispatch.auth.apiKey === void 0 ? {} : { apiKey: dispatch.auth.apiKey },
              ...dispatch.auth.headers === void 0 ? {} : { headers: dispatch.auth.headers },
              ...dispatch.model.baseUrl === void 0 ? {} : { baseUrl: dispatch.model.baseUrl }
            },
            ...dispatch.auth.env === void 0 ? {} : { env: dispatch.auth.env }
          };
        }
      }
    },
    getModels() {
      return [inheritedModel];
    },
    stream(model, childContext, streamOptions) {
      return parentProvider.stream(model, childContext, streamOptions);
    },
    streamSimple(model, childContext, streamOptions) {
      return parentProvider.streamSimple(model, childContext, streamOptions);
    }
  };
  runtime.registerNativeProvider(provider);
  return state;
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
  return withInProcessScratch(
    {
      prefix: "ak-evidence-child-",
      ...options.credentialScratchParent === void 0 ? {} : { parentDirectory: options.credentialScratchParent }
    },
    async (childConfigDir) => {
      const { openInProcessAgentSession } = await import("./in-process-session.ts");
      const { createRecordSession } = await import("./sitian-record-entry.ts");
      let inherited;
      try {
        inherited = await createInheritedRuntime({
          context,
          label: "Evidence child"
        });
      } catch (error) {
        throw classifiedError(error, "provider");
      }
      const { session, dispose } = await openInProcessAgentSession({
        cwd: workspace,
        agentDir: childConfigDir,
        model: inherited.model,
        thinkingLevel: context.thinkingLevel ?? "off",
        modelRuntime: inherited.runtime,
        systemPrompt: [
          "Work only in the supplied workspace.",
          "Use the available evidence tools to investigate. Do not commit, push, or mutate remotes.",
          "Return one substantive non-blank report."
        ].join("\n"),
        sessionManager: createRecordSession({
          cwd: workspace,
          kind: "evidence-children",
          ...context.sessionManager === void 0 ? {} : { parent: context.sessionManager }
        })
      });
      const usage = emptyUsage();
      const unsubscribe = session.subscribe((event) => {
        if (event.type === "message_end" && event.message.role === "assistant") {
          addUsage(usage, event.message.usage);
        }
      });
      const abortChild = () => {
        void session.abort();
      };
      if (signal?.aborted) abortChild();
      else signal?.addEventListener("abort", abortChild, { once: true });
      let primaryFailure;
      try {
        const delivered = prompt;
        try {
          await session.prompt(delivered);
        } catch (error) {
          throw classifiedError(error, "provider");
        }
        if (signal?.aborted) throw new Error("Evidence child was cancelled");
        const lastAssistant = [...session.messages].reverse().find((message) => message.role === "assistant");
        if (lastAssistant?.role === "assistant" && (lastAssistant.stopReason === "error" || lastAssistant.stopReason === "aborted")) {
          throw classifiedError(
            new Error(lastAssistant.errorMessage ?? "", { cause: lastAssistant }),
            projectStructuredRemote(lastAssistant).hasTestimony ? "provider" : "unknown"
          );
        }
        if (lastAssistant?.role !== "assistant") {
          throw classifiedError(
            new Error("Evidence child child terminated without a report", {
              cause: lastAssistant ?? session.messages
            }),
            "child"
          );
        }
        const report = session.getLastAssistantText() ?? "";
        if (report.trim().length === 0) {
          throw new Error("Evidence child returned a blank child report");
        }
        return { report, usage, prompt: delivered };
      } catch (error) {
        primaryFailure = classifiedError(error, "child");
        throw primaryFailure;
      } finally {
        signal?.removeEventListener("abort", abortChild);
        let cleanupFailure;
        for (const cleanup of [() => unsubscribe(), () => dispose()]) {
          try {
            cleanup();
          } catch (failure) {
            cleanupFailure = cleanupFailure === void 0 ? failure : new AggregateError([cleanupFailure, failure], "Reviewer child cleanup failed", {
              cause: cleanupFailure
            });
          }
        }
        if (cleanupFailure !== void 0) {
          if (primaryFailure !== void 0) {
            throw new AggregateError(
              [primaryFailure, cleanupFailure],
              "Reviewer child execution and cleanup failed",
              { cause: primaryFailure }
            );
          }
          throw new AggregateError([cleanupFailure], "Reviewer child cleanup failed", {
            cause: cleanupFailure
          });
        }
      }
    }
  );
}
async function executeAuditorChild(options) {
  const { createRecordSession } = await import("./sitian-record-entry.ts");
  return withInProcessScratch({ prefix: "ak-auditor-role-" }, async (scratch) => {
    const inherited = await createInheritedRuntime({
      context: options.context,
      label: options.roleLabel,
      idleRetry: true,
      ...options.runCompletion === void 0 ? {} : { runCompletion: options.runCompletion, injectedSystemPrompt: options.systemPrompt },
      ...options.signal === void 0 ? {} : { signal: options.signal }
    });
    const cwd = options.context.cwd ?? process.cwd();
    let decision;
    let noReceiptLifecycle;
    let decisionSubmitted = false;
    let decisionCallId;
    let decisionToolFailure;
    const decisionToolFailures = /* @__PURE__ */ new Map();
    const delivery = createReceiptDeliveryPolicy();
    const tool = wrapPackageOwnedToolDefinition({
      ...options.tool,
      label: options.roleLabel,
      async execute(...args) {
        if (decisionSubmitted && decisionCallId !== args[0]) {
          throw new Error("Auditor decision was submitted more than once");
        }
        try {
          const result = await options.tool.execute(...args);
          delivery.recordAccepted();
          decision = args[1];
          decisionCallId = args[0];
          decisionToolFailure = void 0;
          decisionToolFailures.delete(args[0]);
          decisionSubmitted = true;
          return result;
        } catch (error) {
          decisionToolFailure = error;
          decisionToolFailures.set(args[0], error);
          throw error;
        }
      }
    });
    const parentSessionManager = options.context.sessionManager;
    const parentHeader = parentSessionManager?.getHeader?.();
    const parentSessionFile = parentSessionManager?.getSessionFile?.();
    const parentAttemptEntryId = parentSessionManager?.getLeafId?.();
    const auditorSessionManager = createRecordSession({
      cwd,
      kind: "auditor-roles",
      ...parentSessionManager === void 0 ? {} : { parent: parentSessionManager }
    });
    const { openInProcessAgentSession: openSession } = await import("./in-process-session.ts");
    const { session, dispose } = await openSession({
      cwd,
      agentDir: scratch,
      model: inherited.model,
      thinkingLevel: options.context.thinkingLevel ?? "off",
      modelRuntime: inherited.runtime,
      systemPrompt: options.systemPrompt,
      customTools: [wrapPackageOwnedToolDefinition({ ...options.dossierTool, label: options.roleLabel }), tool],
      sessionManager: auditorSessionManager
    });
    const binding = {
      version: 1,
      parent: {
        ...parentHeader?.id === void 0 ? {} : { sessionId: parentHeader.id },
        ...parentSessionFile === void 0 ? {} : { sessionFile: parentSessionFile },
        ...parentAttemptEntryId === null || parentAttemptEntryId === void 0 ? {} : { attemptEntryId: parentAttemptEntryId }
      }
    };
    auditorSessionManager.appendCustomEntry(AUDITOR_PARENT_ATTEMPT_BINDING_ENTRY_TYPE, binding);
    let turns = 0;
    const sessionUsage = emptyUsage();
    let boundaryResponse;
    let retentionFailure;
    let retainedResponse;
    let rejectedDecisionResponse;
    let promptNeighboringFailure;
    let promptDecisionFailures = [];
    const registeredToolNames = new Set(session.getAllTools().map((entry) => entry.name));
    const evidenceToolFailures = /* @__PURE__ */ new Map();
    for (const name of registeredToolNames) {
      if (name === tool.name) continue;
      const definition = session.getToolDefinition(name);
      if (definition === void 0) continue;
      const execute = definition.execute.bind(definition);
      definition.execute = async (...args) => {
        try {
          return await execute(...args);
        } catch (error) {
          evidenceToolFailures.set(args[0], error);
          throw error;
        }
      };
    }
    const findToolFailure = (response) => {
      const callIds = response.content.flatMap((part) => part.type === "toolCall" && part.name !== tool.name && registeredToolNames.has(part.name) ? [part.id] : []);
      for (const callId of callIds) {
        if (evidenceToolFailures.has(callId)) return evidenceToolFailures.get(callId);
      }
      const callIdSet = new Set(callIds);
      return [...session.messages].reverse().find((message) => message.role === "toolResult" && callIdSet.has(message.toolCallId) && message.isError);
    };
    const drainRejectedDecisionFailures = (response) => {
      for (const part of response.content) {
        if (part.type !== "toolCall" || part.name !== tool.name || !decisionToolFailures.has(part.id)) continue;
        decisionToolFailure = decisionToolFailures.get(part.id);
        promptDecisionFailures.push(decisionToolFailure);
        decisionToolFailures.delete(part.id);
      }
    };
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "message_end" && event.message.role === "assistant" && boundaryResponse === void 0) {
        turns += 1;
        addUsage(sessionUsage, event.message.usage);
        retainedResponse = event.message;
        try {
          options.retainResponse?.(event.message);
        } catch (error) {
          retentionFailure = error;
        }
        for (const part of event.message.content) {
          if (part.type === "toolCall" && part.name === tool.name) {
            rejectedDecisionResponse = event.message;
            if (decision === void 0) {
              decision = part.arguments;
              decisionCallId = part.id;
              if (part.arguments === void 0) decisionSubmitted = true;
            }
          }
        }
        if (turns >= AUDITOR_TURN_LIMIT) boundaryResponse = event.message;
      }
      if (event.type === "turn_end") {
        if (rejectedDecisionResponse !== void 0) {
          promptNeighboringFailure = findToolFailure(rejectedDecisionResponse);
          drainRejectedDecisionFailures(rejectedDecisionResponse);
        }
        if (decisionSubmitted || promptNeighboringFailure !== void 0 || boundaryResponse !== void 0 && rejectedDecisionResponse === void 0 || retentionFailure !== void 0) {
          void session.abort();
        }
      }
    });
    const abort = () => {
      void session.abort();
    };
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });
    try {
      try {
        const promptAllowingRejectedDecision = async (prompt) => {
          rejectedDecisionResponse = void 0;
          promptNeighboringFailure = void 0;
          decisionToolFailure = void 0;
          promptDecisionFailures = [];
          let promptFailure;
          try {
            await session.prompt(prompt);
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
        while (!decisionSubmitted && (boundaryResponse === void 0 || decisionToolFailure !== void 0) && inherited.streamFailure === void 0 && delivery.nextAction() === "request-delivery") {
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
        if (!decisionSubmitted && inherited.streamFailure === void 0 && delivery.nextAction() === "no-receipt") {
          const runPointer = options.context.sessionManager.getSessionFile() ?? options.context.cwd ?? process.cwd();
          const attemptPointer = binding.parent.attemptEntryId ?? binding.parent.sessionId ?? `current:${runPointer}`;
          const facts = delivery.facts({ runPointer, attemptPointer });
          decision = facts;
          decisionToolFailure = void 0;
          auditorSessionManager.appendCustomEntry(NO_RECEIPT_LIFECYCLE_ENTRY_TYPE, facts);
          noReceiptLifecycle = facts;
        }
      } catch (error) {
        if (options.signal?.aborted) throw options.signal.reason;
        if (inherited.streamFailure !== void 0) throw inherited.streamFailure;
        throw error;
      }
      if (options.signal?.aborted) throw options.signal.reason;
      if (inherited.streamFailure !== void 0) throw inherited.streamFailure;
      if (!decisionSubmitted && decisionToolFailure !== void 0) throw decisionToolFailure;
      const relevantResponse = !decisionSubmitted ? boundaryResponse : [...session.messages].reverse().find((message) => message.role === "assistant" && message.content.some((part) => part.type === "toolCall" && part.name === tool.name));
      if (relevantResponse !== void 0) {
        const toolFailure = findToolFailure(relevantResponse);
        if (toolFailure !== void 0) throw toolFailure;
      }
      if (retentionFailure !== void 0 && retainedResponse?.stopReason !== "error") throw retentionFailure;
      if (boundaryResponse !== void 0 && !decisionSubmitted && noReceiptLifecycle === void 0) {
        const toolNames = boundaryResponse.content.flatMap((part) => part.type === "toolCall" ? [part.name] : []);
        throw new AuditorTurnLimitError(AUDITOR_TURN_LIMIT, turns, {
          stopReason: boundaryResponse.stopReason,
          toolNames
        });
      }
      const assistants = [...session.messages].reverse().filter((message) => message.role === "assistant");
      const response = !decisionSubmitted ? assistants[0] : assistants.find((message) => message.content.some((part) => part.type === "toolCall" && part.name === tool.name));
      if (response !== void 0) {
        try {
          if (retainedResponse === void 0) options.retainResponse?.(response);
          else if (retentionFailure !== void 0) throw retentionFailure;
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
          auditorSessionManager.appendCustomEntry(AUDITOR_COMPLIANCE_FAILURE_ENTRY_TYPE, {
            version: 1,
            parent: binding.parent,
            failure: {
              cause: failure.knownCause,
              ...failure.failureCode === void 0 ? {} : { identity: { name: failure.name, code: failure.failureCode } },
              ...failure.message === "" ? {} : { diagnostic: failure.message },
              details: failure.details
            }
          });
          throw failure;
        }
      }
      if (response === void 0 || response.stopReason === "error" || response.stopReason === "aborted" || !decisionSubmitted && decision === void 0) {
        throw new Error(`${options.roleLabel} exited without a readable decision receipt`);
      }
      return {
        decision,
        response: { ...response, usage: sessionUsage },
        ...noReceiptLifecycle === void 0 ? {} : { noReceiptLifecycle }
      };
    } finally {
      options.signal?.removeEventListener("abort", abort);
      unsubscribe();
      dispose();
    }
  });
}
export {
  AUDITOR_TURN_LIMIT,
  AuditorTurnLimitError,
  DEFAULT_COMPLIANCE_IDLE_MAX_RETRIES,
  createInheritedRuntime,
  executeAuditorChild,
  executeEvidenceChild,
  withInProcessScratch
};
