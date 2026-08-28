/**
 * Pi Institutional Sub-Session Open Seam (#518 / #233).
 * Adapts Pi AgentSession / ModelRuntime / ModelRegistry into the host-neutral
 * HostInstitutionalSessionHandle contract.
 * Zero Pi type leakage out of this module.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  ModelRuntime,
  SettingsManager,
  type AgentToolResult,
  type SessionManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  InMemoryCredentialStore,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  type Provider,
  type ProviderStreamOptions,
  type Usage,
} from "@earendil-works/pi-ai";

import { createRecordSession } from "../archivist-record-entry.ts";
import type {
  HostAssistantTurnResult,
  HostInstitutionalModelSelection,
  HostInstitutionalSessionEvent,
  HostInstitutionalSessionHandle,
  HostInstitutionalSessionOptions,
  HostSessionUsage,
} from "../host-contracts.ts";
import {
  createStreamIdleGuard,
  isStreamIdleTimeoutError,
} from "../stream-idle-guard.ts";
import {
  hasUpstreamErrorTestimony,
  isNonSuccessHttpStatus,
  projectConfirmedRemotePayload,
} from "../upstream-error-testimony.ts";

export const DEFAULT_COMPLIANCE_IDLE_MAX_RETRIES = 2;

// ── Legacy openInProcessAgentSession (preserved for Navigator B) ───────────

type OpenInProcessAgentSessionBase = {
  readonly cwd: string;
  readonly agentDir?: string;
  readonly model: Model<Api>;
  readonly modelRuntime: ModelRuntime;
  readonly thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  readonly systemPrompt?: string;
  readonly customTools?: ToolDefinition[];
  readonly noTools?: "all" | "builtin";
  readonly tools?: string[];
};

export type OpenInProcessAgentSessionOptions = 
  | (OpenInProcessAgentSessionBase & {
      readonly sessionManager: SessionManager;
      readonly kind?: never;
      readonly subject?: never;
      readonly parent?: never;
    })
  | (OpenInProcessAgentSessionBase & {
      readonly sessionManager?: undefined;
      readonly kind: string;
      readonly subject?: string;
      readonly parent?: { getSessionFile(): string | undefined };
    });

function resolveSessionManager(options: OpenInProcessAgentSessionOptions): SessionManager {
  if (options.sessionManager !== undefined) return options.sessionManager;
  return createRecordSession({
    cwd: options.cwd,
    kind: options.kind,
    ...(options.subject === undefined ? {} : { subject: options.subject }),
    ...(options.parent === undefined ? {} : { parent: options.parent }),
  });
}

export async function openInProcessAgentSession(
  options: OpenInProcessAgentSessionOptions,
): Promise<{ session: Awaited<ReturnType<typeof createAgentSession>>["session"]; dispose(): void }> {
  const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const sessionManager = resolveSessionManager(options);

  const createArgs: Parameters<typeof createAgentSession>[0] = {
    cwd: options.cwd,
    model: options.model,
    thinkingLevel: options.thinkingLevel ?? "off",
    modelRuntime: options.modelRuntime,
    sessionManager,
    settingsManager: settings,
    ...(options.noTools === undefined ? {} : { noTools: options.noTools }),
    ...(options.tools === undefined ? {} : { tools: options.tools }),
    ...(options.customTools === undefined ? {} : { customTools: options.customTools }),
  };

  if (options.agentDir !== undefined) {
    const loader = new DefaultResourceLoader({
      cwd: options.cwd,
      agentDir: options.agentDir,
      settingsManager: settings,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      ...(options.systemPrompt === undefined ? {} : { systemPrompt: options.systemPrompt }),
    });
    await loader.reload();
    createArgs.agentDir = options.agentDir;
    createArgs.resourceLoader = loader;
  } else if (options.systemPrompt !== undefined) {
    throw new Error("openInProcessAgentSession requires agentDir when systemPrompt is set");
  }

  const { session } = await createAgentSession(createArgs);
  return {
    session,
    dispose() {
      session.dispose();
    },
  };
}

// ── Stream / remote error projection helpers ───────────────────────────────

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function addUsage(total: Usage, next?: Usage): void {
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

function numericHttpStatus(value: unknown): number | undefined {
  return isNonSuccessHttpStatus(value) ? value : undefined;
}

type StructuredRemoteProjection = {
  readonly hasTestimony: boolean;
  readonly httpStatus?: number;
  readonly diagnostics?: unknown;
  readonly body?: unknown;
  readonly code?: unknown;
  readonly errno?: unknown;
};

function projectStructuredRemote(error: unknown): StructuredRemoteProjection {
  let httpStatus: number | undefined;
  let diagnostics: unknown;
  let body: unknown;
  let code: unknown;
  let errno: unknown;
  let cursor: unknown = error;
  const seen = new Set<unknown>();
  while (typeof cursor === "object" && cursor !== null && !seen.has(cursor)) {
    seen.add(cursor);
    const record = cursor as Record<string, unknown>;
    const nodeStatus = numericHttpStatus(record.statusCode)
      ?? numericHttpStatus(record.status)
      ?? numericHttpStatus(record.httpStatus);
    const nodeDiagnostics = Array.isArray(record.diagnostics) && record.diagnostics.length > 0
      ? record.diagnostics
      : undefined;
    const nodeHasTestimony = hasUpstreamErrorTestimony({
      ...(nodeStatus === undefined ? {} : { httpStatus: nodeStatus }),
      ...(nodeDiagnostics === undefined ? {} : { diagnostics: nodeDiagnostics }),
    });
    if (httpStatus === undefined && nodeStatus !== undefined) httpStatus = nodeStatus;
    if (diagnostics === undefined && nodeDiagnostics !== undefined) diagnostics = nodeDiagnostics;
    if (nodeHasTestimony) {
      const payload = projectConfirmedRemotePayload(record);
      if (body === undefined && payload.body !== undefined) body = payload.body;
      if (code === undefined && payload.code !== undefined) code = payload.code;
      if (errno === undefined && payload.errno !== undefined) errno = payload.errno;
    }
    cursor = record.cause;
  }
  return {
    hasTestimony: hasUpstreamErrorTestimony({
      ...(httpStatus === undefined ? {} : { httpStatus }),
      ...(diagnostics === undefined ? {} : { diagnostics }),
    }),
    ...(httpStatus === undefined ? {} : { httpStatus }),
    ...(diagnostics === undefined ? {} : { diagnostics }),
    ...(body === undefined ? {} : { body }),
    ...(code === undefined ? {} : { code }),
    ...(errno === undefined ? {} : { errno }),
  };
}

function attachObservedHttpStatus<T extends AssistantMessage>(
  message: T,
  observedHttpStatus: number | undefined,
): T {
  if (observedHttpStatus === undefined) return message;
  if (message.stopReason !== "error" && message.stopReason !== "aborted") return message;
  if (numericHttpStatus(observedHttpStatus) === undefined) return message;
  if (projectStructuredRemote(message).httpStatus !== undefined) return message;
  return Object.assign(message, {
    status: observedHttpStatus,
    statusCode: observedHttpStatus,
  });
}

function enrichStreamEvent(event: unknown, observedHttpStatus: number | undefined): unknown {
  if (observedHttpStatus === undefined || event === null || typeof event !== "object") return event;
  const record = event as Record<string, unknown>;
  if (record.type === "error" && record.error !== null && typeof record.error === "object") {
    return {
      ...record,
      error: attachObservedHttpStatus(record.error as AssistantMessage, observedHttpStatus),
    };
  }
  if (record.type === "done" && record.message !== null && typeof record.message === "object") {
    return {
      ...record,
      message: attachObservedHttpStatus(record.message as AssistantMessage, observedHttpStatus),
    };
  }
  if (record.partial !== null && typeof record.partial === "object") {
    return {
      ...record,
      partial: attachObservedHttpStatus(record.partial as AssistantMessage, observedHttpStatus),
    };
  }
  return event;
}

// ── S3 Institutional Session Open Seam ─────────────────────────────────────

export type OpenPiInstitutionalSessionOptions = HostInstitutionalSessionOptions & {
  readonly modelRegistry?: any;
  readonly runCompletion?: (
    model: Model<Api>,
    context: Context,
    options: ProviderStreamOptions,
  ) => Promise<AssistantMessage>;
  readonly injectedSystemPrompt?: string;
  readonly label?: string;
};

export async function openPiInstitutionalSession(
  options: OpenPiInstitutionalSessionOptions,
): Promise<HostInstitutionalSessionHandle> {
  const label = options.label ?? "Institutional sub-session";
  const selection = options.selection;

  // 1. Scratch management
  let scratchDir: string | undefined;
  let resolvedAgentDir = options.agentDir;
  if (resolvedAgentDir === undefined) {
    scratchDir = await mkdtemp(join(options.credentialScratchParent ?? tmpdir(), "ak-institutional-"));
    resolvedAgentDir = scratchDir;
  }

  try {
    // 2. Auth resolution in Pi layer via explicit selection (Hop 3)
    let sourceRegistry: ModelRegistry;
    if (options.modelRegistry !== undefined) {
      sourceRegistry = options.modelRegistry;
    } else {
      const baseRuntime = await ModelRuntime.create();
      sourceRegistry = new ModelRegistry(baseRuntime);
    }

    const foundModel = typeof sourceRegistry.find === "function"
      ? sourceRegistry.find(selection.provider, selection.model)
      : undefined;
    const modelToUse = foundModel ?? {
      id: selection.model,
      name: selection.model,
      api: (selection.provider === "openai-codex" ? "openai-codex-responses" : selection.provider) as any,
      provider: selection.provider,
      baseUrl: "",
      reasoning: selection.thinking !== undefined && selection.thinking !== "off",
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 16384,
    };

    let resolution: { auth: { baseUrl?: string; apiKey?: string; headers?: Record<string, string | null> }; env?: Record<string, string> } | undefined;
    if (typeof sourceRegistry.getProviderAuth === "function") {
      resolution = await sourceRegistry.getProviderAuth(selection.provider).catch((error: unknown) => {
        throw new Error(`${label} authentication failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      });
      if (resolution === undefined) {
        throw new Error(`${label} authentication failed: provider is not configured: ${selection.provider}`);
      }
    }

    let authResult: { ok: boolean; error?: string; apiKey?: string; headers?: Record<string, string | null>; env?: Record<string, string> } | undefined;
    if (typeof sourceRegistry.getApiKeyAndHeaders === "function") {
      authResult = await sourceRegistry.getApiKeyAndHeaders(modelToUse as any);
      if (authResult && !authResult.ok) {
        throw new Error(`${label} authentication failed: ${authResult.error}`);
      }
    }

    const resolvedApiKey = authResult?.apiKey ?? resolution?.auth?.apiKey;
    const resolvedHeaders = authResult?.headers ?? resolution?.auth?.headers;
    const resolvedEnv = authResult?.env ?? resolution?.env;
    const effectiveBaseUrl = resolution?.auth?.baseUrl ?? modelToUse.baseUrl;

    const effectiveModel: Model<Api> = {
      ...modelToUse,
      baseUrl: effectiveBaseUrl,
    };

    // 3. Standalone ModelRuntime + Provider with idle-only retry.
    // spec-2: the adapter constructs its OWN runtime/provider registration.
    // Auth is resolved only by explicit selection above and seeded into the
    // child runtime's own credential store — never inherited ambiently from
    // the parent ExtensionContext/Provider.
    const credentials = new InMemoryCredentialStore();
    const runtime = await ModelRuntime.create({
      credentials,
      modelsPath: null,
    });

    // The provider this child runtime will serve requests for. Resolved by
    // explicit selection from the source registry (Pi auth true source), not
    // captured from the parent session's ambient provider.
    const childProvider: Provider | undefined = typeof sourceRegistry.getProvider === "function"
      ? sourceRegistry.getProvider(selection.provider)
      : undefined;

    // Seed the child runtime's own credential store with the explicitly
    // resolved auth so stream auth resolution is self-contained. No ambient
    // fallback: absence of a resolved apiKey is not silently supplied.
    if (resolvedApiKey !== undefined) {
      await credentials.modify(selection.provider, async () => ({
        type: "api_key",
        key: resolvedApiKey,
        ...(resolvedEnv === undefined ? {} : { env: resolvedEnv }),
      }));
    }

    const abortReason = (signal: AbortSignal): unknown =>
      signal.reason ?? new Error(`${label} provider stream aborted`);

    async function waitForStream<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
      if (signal.aborted) throw abortReason(signal);
      let onAbort: (() => void) | undefined;
      try {
        return await Promise.race([
          promise,
          new Promise<never>((_resolve, reject) => {
            onAbort = () => reject(abortReason(signal));
            signal.addEventListener("abort", onAbort, { once: true });
          }),
        ]);
      } finally {
        if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
      }
    }

    const createRetriedStream = (
      simple: boolean,
      model: Model<Api>,
      context: Context,
      request?: ProviderStreamOptions,
    ): ReturnType<Provider["stream"]> => {
      const wrapped = createAssistantMessageEventStream();
      void (async () => {
        for (let attempt = 0; ; attempt += 1) {
          const idle = createStreamIdleGuard(
            options.signal === undefined ? {} : { parentSignal: options.signal },
          );
          let observedHttpStatus: number | undefined;
          try {
            const requestSignal = request?.signal;
            const streamSignal = requestSignal === undefined
              ? idle.signal
              : AbortSignal.any([idle.signal, requestSignal]);
            const priorOnResponse = request?.onResponse;
            const retriedRequest: ProviderStreamOptions = {
              ...(request ?? {}),
              ...(resolvedEnv === undefined ? {} : { env: resolvedEnv }),
              signal: streamSignal,
              onResponse: async (
                response: { status: number; headers: Record<string, string> },
                resModel: Model<Api>,
              ) => {
                if (typeof response?.status === "number") observedHttpStatus = response.status;
                await priorOnResponse?.(response, resModel);
              },
            };

            if (options.runCompletion !== undefined) {
              await new Promise<void>((resolve) => setImmediate(resolve));
              if (streamSignal.aborted) throw abortReason(streamSignal);
              const completed = await waitForStream(
                options.runCompletion(
                  model,
                  options.injectedSystemPrompt === undefined
                    ? context
                    : { ...context, systemPrompt: options.injectedSystemPrompt },
                  retriedRequest,
                ),
                streamSignal,
              );
              const response: AssistantMessage = attachObservedHttpStatus({
                ...completed,
                api: model.api,
                provider: model.provider,
                model: model.id,
              }, observedHttpStatus);
              if (response.stopReason === "error" || response.stopReason === "aborted") {
                wrapped.push({ type: "error", reason: response.stopReason, error: response });
              } else {
                wrapped.end(response);
              }
              return;
            }

            if (childProvider === undefined) {
              throw new Error(`${label} provider not found: ${model.provider}`);
            }

            const source = simple
              ? childProvider.streamSimple(model, context, retriedRequest as any)
              : childProvider.stream(model, context, retriedRequest as any);
            let sawEvent = false;
            const iterator = source[Symbol.asyncIterator]();
            while (true) {
              const next = await waitForStream(iterator.next(), idle.signal);
              if (next.done) break;
              sawEvent = true;
              idle.poke();
              wrapped.push(enrichStreamEvent(next.value, observedHttpStatus) as any);
            }
            const response = attachObservedHttpStatus(
              await waitForStream(source.result(), idle.signal),
              observedHttpStatus,
            );
            if (!sawEvent) wrapped.end(response);
            return;
          } catch (error) {
            if (request?.signal?.aborted) {
              const response: AssistantMessage = {
                role: "assistant",
                content: [],
                api: model.api,
                provider: model.provider,
                model: model.id,
                usage: emptyUsage(),
                stopReason: "aborted",
                errorMessage: `${label} session aborted`,
                timestamp: Date.now(),
              };
              wrapped.push({ type: "error", reason: "aborted", error: response });
              wrapped.end(response);
              return;
            }
            const failure = isStreamIdleTimeoutError(idle.signal.reason) ? idle.signal.reason : error;
            if (
              options.idleRetry !== false
              && isStreamIdleTimeoutError(failure)
              && attempt < DEFAULT_COMPLIANCE_IDLE_MAX_RETRIES
              && options.signal?.aborted !== true
            ) {
              continue;
            }
            const projected = projectStructuredRemote(failure);
            const httpStatus = projected.httpStatus ?? numericHttpStatus(observedHttpStatus);
            const response = {
              role: "assistant" as const,
              content: [] as [],
              api: model.api,
              provider: model.provider,
              model: model.id,
              usage: emptyUsage(),
              stopReason: "error" as const,
              errorMessage: failure instanceof Error ? failure.message : String(failure),
              timestamp: Date.now(),
              ...(projected.diagnostics === undefined ? {} : { diagnostics: projected.diagnostics }),
              ...(httpStatus === undefined ? {} : { status: httpStatus, statusCode: httpStatus }),
              ...(projected.body === undefined ? {} : { body: projected.body }),
              ...(projected.code === undefined ? {} : { code: projected.code }),
              ...(projected.errno === undefined ? {} : { errno: projected.errno }),
            } as unknown as AssistantMessage;
            wrapped.push({ type: "error", reason: "error", error: response });
            wrapped.end(response);
            return;
          } finally {
            idle.dispose();
          }
        }
      })();
      return wrapped as ReturnType<Provider["stream"]>;
    };

    const provider: Provider = {
      id: selection.provider,
      name: childProvider?.name ?? label,
      ...(effectiveBaseUrl ? { baseUrl: effectiveBaseUrl } : {}),
      ...(resolvedHeaders ? { headers: resolvedHeaders as any } : {}),
      auth: {
        apiKey: {
          name: `${label} authentication`,
          async resolve() {
            return {
              auth: {
                ...(resolvedApiKey === undefined ? {} : { apiKey: resolvedApiKey }),
                ...(resolvedHeaders === undefined ? {} : { headers: resolvedHeaders }),
                ...(effectiveBaseUrl === undefined ? {} : { baseUrl: effectiveBaseUrl }),
              },
              ...(resolvedEnv === undefined ? {} : { env: resolvedEnv }),
            };
          },
        },
      },
      getModels() { return [effectiveModel]; },
      stream(model, childContext, request) {
        return createRetriedStream(false, model, childContext, request as ProviderStreamOptions | undefined);
      },
      streamSimple(model, childContext, request) {
        return createRetriedStream(true, model, childContext, request as ProviderStreamOptions | undefined);
      },
    };

    runtime.registerNativeProvider(provider);
    await runtime.refresh({ allowNetwork: false });

    // 4. Settings and ResourceLoader (fixed adapter policies: no extensions/skills/themes/templates/context-files)
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
      systemPrompt: options.systemPrompt,
    });
    await loader.reload();

    // 5. SessionManager resolution
    let sessionManager: SessionManager;
    if (options.sessionManager !== undefined) {
      sessionManager = options.sessionManager as SessionManager;
    } else if (options.sessionIdentity !== undefined) {
      sessionManager = createRecordSession({
        cwd: options.cwd,
        kind: options.sessionIdentity.kind,
        ...(options.sessionIdentity.subject === undefined ? {} : { subject: options.sessionIdentity.subject }),
        ...(options.sessionIdentity.parent === undefined ? {} : { parent: options.sessionIdentity.parent }),
      });
    } else {
      sessionManager = createRecordSession({
        cwd: options.cwd,
        kind: "institutional",
      });
    }

    // 6. Tools mapping
    const customTools: ToolDefinition[] = [];
    if (options.customTools !== undefined) {
      customTools.push(...(options.customTools as ToolDefinition[]));
    }
    if (options.tools !== undefined) {
      for (const hostTool of options.tools) {
        customTools.push({
          name: hostTool.name,
          label: hostTool.label,
          description: hostTool.description,
          parameters: hostTool.parameters,
          execute: async (toolCallId, params, signal, update, _ctx) => {
            const res = await hostTool.execute(
              toolCallId,
              params as any,
              signal,
              update === undefined ? undefined : (u) => update(u as AgentToolResult<unknown>),
              undefined as any,
            );
            return res as AgentToolResult<unknown>;
          },
        });
      }
    }

    // 7. Create AgentSession
    const { session } = await createAgentSession({
      cwd: options.cwd,
      model: effectiveModel,
      thinkingLevel: (options.selection.thinking ?? "off") as any,
      modelRuntime: runtime,
      sessionManager,
      settingsManager: settings,
      agentDir: resolvedAgentDir,
      resourceLoader: loader,
      ...(options.noTools === undefined ? {} : { noTools: options.noTools }),
      ...(options.toolsAllowlist === undefined ? {} : { tools: options.toolsAllowlist as string[] }),
      ...(customTools.length === 0 ? {} : { customTools }),
    });

    // 8. Event subscriptions
    const listeners = new Set<(event: HostInstitutionalSessionEvent) => void>();
    const accumulatedUsage = emptyUsage();

    const unsubscribeSession = session.subscribe((event) => {
      if (event.type === "message_end") {
        const msg = event.message as AssistantMessage;
        if (msg.role === "assistant" && msg.usage) {
          addUsage(accumulatedUsage, msg.usage);
        }
        for (const listener of listeners) {
          listener({
            type: "message_end",
            role: msg.role,
            ...(msg.usage === undefined ? {} : { usage: msg.usage as HostSessionUsage }),
          });
        }
      } else if (event.type === "turn_end") {
        const msg = event.message as AssistantMessage;
        for (const listener of listeners) {
          listener({
            type: "turn_end",
            ...(msg.stopReason === undefined ? {} : { stopReason: msg.stopReason }),
          });
        }
      } else if (event.type === "tool_execution_start") {
        for (const listener of listeners) {
          listener({
            type: "tool_call",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            args: (event as any).args ?? (event as any).input,
          });
        }
      } else if (event.type === "tool_execution_end") {
        for (const listener of listeners) {
          listener({
            type: "tool_result",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            isError: event.isError,
            details: (event as any).result ?? (event as any).details,
          });
        }
      }
    });

    let closed = false;
    const sessionFile = sessionManager.getSessionFile();
    const sessionId = (sessionManager as any).getHeader?.()?.id;

    const handle: HostInstitutionalSessionHandle = {
      ...(sessionFile === undefined ? {} : { sessionFile }),
      ...(sessionId === undefined ? {} : { sessionId }),

      async prompt(text: string): Promise<HostAssistantTurnResult> {
        const abortSession = () => { void session.abort(); };
        if (options.signal?.aborted) abortSession();
        else options.signal?.addEventListener("abort", abortSession, { once: true });

        try {
          await session.prompt(text);
          const lastAssistant = [...session.messages]
            .reverse()
            .find((message) => message.role === "assistant") as AssistantMessage | undefined;

          return {
            text: session.getLastAssistantText() ?? "",
            ...(lastAssistant?.stopReason === undefined ? {} : { stopReason: lastAssistant.stopReason }),
            ...(lastAssistant?.errorMessage === undefined ? {} : { errorMessage: lastAssistant.errorMessage }),
            usage: accumulatedUsage as HostSessionUsage,
            messages: session.messages,
          };
        } finally {
          options.signal?.removeEventListener("abort", abortSession);
        }
      },

      subscribe(listener: (event: HostInstitutionalSessionEvent) => void): () => void {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },

      abort(): void {
        void session.abort();
      },

      async close(): Promise<void> {
        if (closed) return;
        closed = true;
        listeners.clear();
        unsubscribeSession();
        session.dispose();

        if (scratchDir !== undefined) {
          try {
            await rm(scratchDir, { recursive: true, force: true });
          } catch (error) {
            throw error;
          }
        }
      },
    };

    return handle;
  } catch (openError) {
    if (scratchDir !== undefined) {
      try {
        await rm(scratchDir, { recursive: true, force: true });
      } catch (cleanupFailure) {
        // ADR 0018 / #518 §1④: primary failure and cleanup failure stay
        // separated — cleanup must not mask the original open cause.
        throw new AggregateError(
          [openError, cleanupFailure],
          `${label} open failed and its scratch cleanup also failed`,
          { cause: openError },
        );
      }
    }
    throw openError;
  }
}