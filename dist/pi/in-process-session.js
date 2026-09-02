import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  ModelRuntime,
  SettingsManager
} from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  InMemoryCredentialStore
} from "@earendil-works/pi-ai";
import { createRecordSession } from "../archivist-record-entry.js";
import {
  createStreamIdleGuard,
  isStreamIdleTimeoutError,
  StreamIdleTimeoutError
} from "../stream-idle-guard.js";
import {
  hasUpstreamErrorTestimony,
  isNonSuccessHttpStatus,
  projectConfirmedRemotePayload
} from "../upstream-error-testimony.js";
const DEFAULT_COMPLIANCE_IDLE_MAX_RETRIES = 2;
function streamIdleTimeoutFromUnknown(value) {
  if (isStreamIdleTimeoutError(value)) return value;
  const message = value instanceof Error ? value.message : typeof value === "string" ? value : void 0;
  if (message === void 0) return void 0;
  const match = /stream idle timeout after (\d+)ms/i.exec(message);
  return match !== null && match[1] !== void 0 ? new StreamIdleTimeoutError(Number(match[1])) : void 0;
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
  if (!next) return;
  total.input += next.input;
  total.output += next.output;
  total.cacheRead += next.cacheRead;
  total.cacheWrite += next.cacheWrite;
  total.totalTokens += next.totalTokens;
  total.cost.input += next.cost?.input ?? 0;
  total.cost.output += next.cost?.output ?? 0;
  total.cost.cacheRead += next.cost?.cacheRead ?? 0;
  total.cost.cacheWrite += next.cost?.cacheWrite ?? 0;
  total.cost.total += next.cost?.total ?? 0;
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
async function openPiInstitutionalSession(options) {
  const label = options.label ?? "Institutional sub-session";
  const selection = options.selection;
  let scratchDir;
  let resolvedAgentDir = options.agentDir;
  if (resolvedAgentDir === void 0) {
    scratchDir = await mkdtemp(join(options.credentialScratchParent ?? tmpdir(), "ak-institutional-"));
    resolvedAgentDir = scratchDir;
  }
  try {
    const childRuntime = await ModelRuntime.create();
    const childRegistry = new ModelRegistry(childRuntime);
    const childProvider = typeof childRegistry.getProvider === "function" ? childRegistry.getProvider(selection.provider) : void 0;
    const foundModel = typeof childRegistry.find === "function" ? childRegistry.find(selection.provider, selection.model) : void 0;
    const withTypedReason = (error, reason) => Object.assign(error, { reason });
    if (childProvider === void 0) {
      throw withTypedReason(
        new Error(`${label} model is unavailable: ${selection.provider}/${selection.model}`),
        "model"
      );
    }
    const providerDefaultModel = childProvider.getModels?.()[0];
    const fallbackApi = providerDefaultModel?.api ?? childProvider?.api ?? (selection.provider === "openai-codex" ? "openai-codex-responses" : "openai-completions");
    const modelToUse = foundModel ?? {
      id: selection.model,
      name: selection.model,
      api: fallbackApi,
      provider: selection.provider,
      baseUrl: providerDefaultModel?.baseUrl ?? "",
      reasoning: selection.thinking !== void 0 && selection.thinking !== "off",
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128e3,
      maxTokens: 16384
    };
    let resolution;
    if (typeof childRegistry.getProviderAuth === "function") {
      resolution = await childRegistry.getProviderAuth(selection.provider).catch((error) => {
        throw withTypedReason(
          new Error(`${label} authentication failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error }),
          "auth"
        );
      });
      if (resolution === void 0) {
        throw withTypedReason(
          new Error(`${label} authentication failed: provider is not configured: ${selection.provider}`),
          "auth"
        );
      }
    }
    let authResult;
    if (typeof childRegistry.getApiKeyAndHeaders === "function") {
      authResult = await childRegistry.getApiKeyAndHeaders(modelToUse);
      if (authResult && !authResult.ok) {
        throw withTypedReason(
          new Error(`${label} authentication failed: ${authResult.error}`),
          "auth"
        );
      }
    }
    const resolvedApiKey = authResult?.apiKey ?? resolution?.auth?.apiKey;
    const resolvedHeaders = authResult?.headers ?? resolution?.auth?.headers;
    const resolvedEnv = authResult?.env ?? resolution?.env;
    const effectiveBaseUrl = resolution?.auth?.baseUrl ?? modelToUse.baseUrl;
    const effectiveModel = {
      ...modelToUse,
      baseUrl: effectiveBaseUrl
    };
    const credentials = new InMemoryCredentialStore();
    const runtime = await ModelRuntime.create({
      credentials,
      modelsPath: null
    });
    if (resolvedApiKey !== void 0) {
      await credentials.modify(selection.provider, async () => ({
        type: "api_key",
        key: resolvedApiKey,
        ...resolvedEnv === void 0 ? {} : { env: resolvedEnv }
      }));
    }
    const abortReason = (signal) => signal.reason ?? new Error(`${label} provider stream aborted`);
    let streamFailureValue;
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
          let observedHttpPayload;
          try {
            const requestSignal = request?.signal;
            const streamSignal = requestSignal === void 0 ? idle.signal : AbortSignal.any([idle.signal, requestSignal]);
            const priorOnResponse = request?.onResponse;
            const priorFetch = request?.fetch;
            const baseFetch = priorFetch ?? globalThis.fetch.bind(globalThis);
            const statusAwareFetch = async (input, init) => {
              const response2 = await baseFetch(input, init);
              if (isNonSuccessHttpStatus(response2?.status)) {
                observedHttpStatus = response2.status;
                try {
                  const parsed = JSON.parse(await response2.clone().text());
                  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
                    observedHttpPayload = projectConfirmedRemotePayload(parsed);
                  }
                } catch {
                }
              }
              return response2;
            };
            const retriedRequest = {
              ...request ?? {},
              ...resolvedEnv === void 0 ? {} : { env: resolvedEnv },
              signal: streamSignal,
              maxRetries: 0,
              fetch: statusAwareFetch,
              onResponse: async (response2, resModel) => {
                if (typeof response2?.status === "number") observedHttpStatus = response2.status;
                await priorOnResponse?.(response2, resModel);
              }
            };
            if (childProvider === void 0) {
              throw withTypedReason(
                new Error(`${label} provider not found: ${model.provider}`),
                "model"
              );
            }
            const source = simple ? childProvider.streamSimple(model, context, retriedRequest) : childProvider.stream(model, context, retriedRequest);
            let sawEvent = false;
            const attemptEvents = [];
            const iterator = source[Symbol.asyncIterator]();
            while (true) {
              const next = await waitForStream(iterator.next(), idle.signal);
              if (next.done) break;
              sawEvent = true;
              idle.poke();
              attemptEvents.push(enrichStreamEvent(next.value, observedHttpStatus));
            }
            const response = attachObservedHttpStatus(
              await waitForStream(source.result(), idle.signal),
              observedHttpStatus
            );
            if (response.stopReason === "error") {
              const errorMessage = response.errorMessage ?? `${label} provider stream failed`;
              const idleFailure = streamIdleTimeoutFromUnknown(errorMessage);
              if (options.idleRetry !== false && idleFailure !== void 0 && attempt < DEFAULT_COMPLIANCE_IDLE_MAX_RETRIES && options.signal?.aborted !== true) {
                continue;
              }
              const failure = idleFailure ?? new Error(errorMessage, { cause: response });
              const httpStatus = numericHttpStatus(observedHttpStatus) ?? numericHttpStatus(response.statusCode) ?? numericHttpStatus(response.status);
              if (httpStatus !== void 0) {
                Object.assign(failure, {
                  statusCode: httpStatus,
                  status: httpStatus,
                  ...observedHttpPayload ?? {}
                });
                Object.assign(response, {
                  statusCode: httpStatus,
                  status: httpStatus,
                  ...observedHttpPayload ?? {}
                });
              }
              streamFailureValue = failure;
            }
            for (const ev of attemptEvents) {
              wrapped.push(ev);
            }
            wrapped.end(response);
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
                errorMessage: `${label} session aborted`,
                timestamp: Date.now()
              };
              wrapped.push({ type: "error", reason: "aborted", error: response2 });
              wrapped.end(response2);
              return;
            }
            const failure = isStreamIdleTimeoutError(idle.signal.reason) ? idle.signal.reason : error;
            const idleFailure = streamIdleTimeoutFromUnknown(failure);
            if (options.idleRetry !== false && idleFailure !== void 0 && attempt < DEFAULT_COMPLIANCE_IDLE_MAX_RETRIES && options.signal?.aborted !== true) {
              continue;
            }
            const typedFailure = idleFailure ?? failure;
            const projected = projectStructuredRemote(failure);
            const httpStatus = projected.httpStatus ?? numericHttpStatus(observedHttpStatus);
            const payload = projectConfirmedRemotePayload({
              body: projected.body ?? observedHttpPayload?.body,
              code: projected.code ?? observedHttpPayload?.code,
              errno: projected.errno ?? observedHttpPayload?.errno
            });
            if (httpStatus !== void 0 && typeof typedFailure === "object" && typedFailure !== null) {
              Object.assign(typedFailure, { statusCode: httpStatus, status: httpStatus, ...payload });
            }
            streamFailureValue = typedFailure;
            const response = {
              role: "assistant",
              content: [],
              api: model.api,
              provider: model.provider,
              model: model.id,
              usage: emptyUsage(),
              stopReason: "error",
              errorMessage: failure instanceof Error ? failure.message : String(failure),
              timestamp: Date.now(),
              ...projected.diagnostics === void 0 ? {} : { diagnostics: projected.diagnostics },
              ...httpStatus === void 0 ? {} : { status: httpStatus, statusCode: httpStatus },
              ...payload
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
    const provider = {
      id: selection.provider,
      name: childProvider?.name ?? label,
      ...effectiveBaseUrl ? { baseUrl: effectiveBaseUrl } : {},
      ...resolvedHeaders ? { headers: resolvedHeaders } : {},
      auth: {
        apiKey: {
          name: `${label} authentication`,
          async resolve() {
            return {
              auth: {
                ...resolvedApiKey === void 0 ? {} : { apiKey: resolvedApiKey },
                ...resolvedHeaders === void 0 ? {} : { headers: resolvedHeaders },
                ...effectiveBaseUrl === void 0 ? {} : { baseUrl: effectiveBaseUrl }
              },
              ...resolvedEnv === void 0 ? {} : { env: resolvedEnv }
            };
          }
        }
      },
      getModels() {
        return [effectiveModel];
      },
      stream(model, childContext, request) {
        return createRetriedStream(false, model, childContext, request);
      },
      streamSimple(model, childContext, request) {
        return createRetriedStream(true, model, childContext, request);
      }
    };
    runtime.registerNativeProvider(provider);
    await runtime.refresh({ allowNetwork: false });
    const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const loader = new DefaultResourceLoader({
      cwd: options.cwd,
      agentDir: resolvedAgentDir,
      settingsManager: settings,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: options.systemPrompt
    });
    await loader.reload();
    let sessionManager;
    if (options.sessionManager !== void 0) {
      sessionManager = options.sessionManager;
    } else if (options.sessionIdentity !== void 0) {
      sessionManager = createRecordSession({
        cwd: options.cwd,
        kind: options.sessionIdentity.kind,
        ...options.sessionIdentity.subject === void 0 ? {} : { subject: options.sessionIdentity.subject },
        ...options.sessionIdentity.parent === void 0 ? {} : { parent: options.sessionIdentity.parent }
      });
    } else {
      sessionManager = createRecordSession({
        cwd: options.cwd,
        kind: "institutional"
      });
    }
    const customTools = [];
    if (options.customTools !== void 0) {
      customTools.push(...options.customTools);
    }
    if (options.tools !== void 0) {
      for (const hostTool of options.tools) {
        customTools.push({
          name: hostTool.name,
          label: hostTool.label,
          description: hostTool.description,
          parameters: hostTool.parameters,
          execute: async (toolCallId, params, signal, update, _ctx) => {
            const res = await hostTool.execute(
              toolCallId,
              params,
              signal,
              update === void 0 ? void 0 : (u) => update(u),
              void 0
            );
            return res;
          }
        });
      }
    }
    const requestedThinking = options.selection.thinking === "max" ? "max" : "off";
    const { session } = await createAgentSession({
      cwd: options.cwd,
      model: effectiveModel,
      thinkingLevel: requestedThinking,
      modelRuntime: runtime,
      sessionManager,
      settingsManager: settings,
      agentDir: resolvedAgentDir,
      resourceLoader: loader,
      ...options.noTools === void 0 ? {} : { noTools: options.noTools },
      ...options.toolsAllowlist === void 0 ? {} : { tools: options.toolsAllowlist },
      ...customTools.length === 0 ? {} : { customTools }
    });
    if (requestedThinking === "max" && session.thinkingLevel !== "max") {
      session.dispose();
      throw withTypedReason(
        new Error(
          `${label} thinking level max is unavailable for ${selection.provider}/${selection.model}`
        ),
        "thinking"
      );
    }
    const listeners = /* @__PURE__ */ new Set();
    const accumulatedUsage = emptyUsage();
    let lastEmittedAssistant;
    const unsubscribeSession = session.subscribe((event) => {
      if (event.type === "message_end") {
        const msg = event.message;
        if (msg.role === "assistant") {
          lastEmittedAssistant = msg;
          if (msg.usage) {
            addUsage(accumulatedUsage, msg.usage);
          }
        }
        for (const listener of listeners) {
          listener({
            type: "message_end",
            role: msg.role,
            message: msg,
            ...msg.usage === void 0 ? {} : { usage: msg.usage }
          });
        }
      } else if (event.type === "turn_end") {
        const msg = event.message;
        for (const listener of listeners) {
          listener({
            type: "turn_end",
            ...msg.stopReason === void 0 ? {} : { stopReason: msg.stopReason }
          });
        }
      } else if (event.type === "tool_execution_start") {
        for (const listener of listeners) {
          listener({
            type: "tool_call",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            args: event.args ?? event.input
          });
        }
      } else if (event.type === "tool_execution_end") {
        for (const listener of listeners) {
          listener({
            type: "tool_result",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            isError: event.isError,
            details: event.result ?? event.details
          });
        }
      }
    });
    let closed = false;
    const sessionFile = sessionManager.getSessionFile();
    const sessionId = sessionManager.getHeader?.()?.id;
    const handle = {
      ...sessionFile === void 0 ? {} : { sessionFile },
      ...sessionId === void 0 ? {} : { sessionId },
      async prompt(text) {
        const abortSession = () => {
          void session.abort();
        };
        if (options.signal?.aborted) abortSession();
        else options.signal?.addEventListener("abort", abortSession, { once: true });
        let promptError;
        try {
          await session.prompt(text);
        } catch (error) {
          promptError = error;
        } finally {
          options.signal?.removeEventListener("abort", abortSession);
        }
        const lastAssistant = [...session.messages].reverse().find((message) => message.role === "assistant");
        if (lastAssistant !== void 0 && lastAssistant !== lastEmittedAssistant) {
          lastEmittedAssistant = lastAssistant;
          for (const listener of listeners) {
            listener({
              type: "message_end",
              role: lastAssistant.role,
              message: lastAssistant,
              ...lastAssistant.usage === void 0 ? {} : { usage: lastAssistant.usage }
            });
          }
        }
        if (promptError !== void 0 && lastAssistant === void 0) {
          throw promptError;
        }
        return {
          text: session.getLastAssistantText() ?? "",
          ...lastAssistant?.stopReason === void 0 ? {} : { stopReason: lastAssistant.stopReason },
          ...lastAssistant?.errorMessage === void 0 ? {} : { errorMessage: lastAssistant.errorMessage },
          usage: accumulatedUsage,
          messages: session.messages
        };
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      abort() {
        void session.abort();
      },
      async close() {
        if (closed) return;
        closed = true;
        listeners.clear();
        try {
          unsubscribeSession();
        } finally {
          session.dispose();
        }
        if (scratchDir !== void 0) {
          try {
            await rm(scratchDir, { recursive: true, force: true });
          } catch (error) {
            throw error;
          }
        }
      }
    };
    return {
      handle,
      // Read lazily: the provider stream runs during session.prompt, so the
      // primary failure is only known after that turn completes. A getter keeps
      // this reflecting the latest value instead of freezing it at open time.
      get streamFailure() {
        return streamFailureValue;
      }
    };
  } catch (openError) {
    if (scratchDir !== void 0) {
      try {
        await rm(scratchDir, { recursive: true, force: true });
      } catch (cleanupFailure) {
        throw new AggregateError(
          [openError, cleanupFailure],
          `${label} open failed and its scratch cleanup also failed`,
          { cause: openError }
        );
      }
    }
    throw openError;
  }
}
export {
  DEFAULT_COMPLIANCE_IDLE_MAX_RETRIES,
  openPiInstitutionalSession
};
