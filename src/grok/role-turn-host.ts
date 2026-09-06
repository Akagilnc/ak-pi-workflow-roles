import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

import type { RoleTurnHost, RoleTurnKnownFailure, RoleTurnRequest, RoleTurnResult } from "../host-contracts.ts";
import { renderAgentStartMaterials } from "../agent-start-materials.ts";

/** ACP v1 surface used by the Grok adapter. Protocol details stay in this module. */
export interface GrokAcpConnection {
  request(method: string, params: Readonly<Record<string, unknown>>): Promise<Readonly<Record<string, unknown>>>;
  notify(method: string, params: Readonly<Record<string, unknown>>): void;
  /** Subscribe to agent→client notifications (session/update stream, etc.). */
  onNotification?(handler: (method: string, params: Readonly<Record<string, unknown>>) => void): void;
  close(): Promise<void>;
}

/** The shared envelope, prepared before session/new (systemPrompt delivery) and
 * able to observe the host's real builtin tool surface once it arrives post-session. */
export type GrokPreparedTurn = Readonly<{
  mcpServers: readonly Readonly<Record<string, unknown>>[];
  /**
   * Structured system-prompt authority. `body` is the provider-facing prompt
   * bytes; `materials` are typed agent-start reading materials (e.g. Notary
   * session bound) that the adapter folds into the override at the provider
   * boundary. This structure is the authoritative production input of the
   * send path — never a test-only parallel face.
   */
  systemPrompt: { readonly body: string; readonly materials: readonly unknown[] };
  /** Effective user prompt after host-side input transform (canonical Skill invocation). */
  prompt: string;
  /**
   * Host abort signal armed only by typed infrastructure failure (envelope
   * rememberInfrastructureFailure / non-correctable MCP catch). Lawful
   * context.abort() (seal / non-sole) does not arm it. executeTurn races
   * session/prompt against this so infra declarations terminate even when
   * ACP never resolves (#593).
   */
  abortSignal?: AbortSignal;
  /** Shared ledger consumes the complete ACP round after session/prompt resolves. */
  closeRound(): Promise<
    | { readonly accepted: true }
    | { readonly accepted: false; readonly retry: { readonly code: string; readonly toolCallIds: readonly string[] } }
    | { readonly accepted: false; readonly failure: RoleTurnKnownFailure }
  >;
  dispose?(): Promise<void>;
}>;

/** Fold structured system-prompt authority into the provider-visible ACP override. */
export function renderGrokSystemPromptOverride(authority: {
  readonly body: string;
  readonly materials: readonly unknown[];
}): string {
  return renderAgentStartMaterials(authority.body, authority.materials);
}

export type GrokSessionIdentityAuthority = Readonly<{
  load(principal: RoleTurnRequest["principal"]): Promise<string | undefined>;
  bind(principal: RoleTurnRequest["principal"], sessionId: string): Promise<void>;
  /** Durable principal session path for layout ownership / isAvailable — not a rebuild source (#617 DK-4). */
  resolveSessionFile(principal: RoleTurnRequest["principal"]): string;
}>;

export type GrokRoleTurnHostConfig = Readonly<{
  sessionIdentity: GrokSessionIdentityAuthority;
  connect(request: RoleTurnRequest): Promise<GrokAcpConnection>;
  prepare(request: RoleTurnRequest): Promise<GrokPreparedTurn>;
}>;

function failure(cause: "activation" | "session" | "output", name: string, code: string, details?: Readonly<Record<string, unknown>>): RoleTurnResult {
  return {
    code: null,
    stderr: "",
    timedOut: false,
    knownFailure: {
      cause,
      identity: { name, code },
      ...(details === undefined ? {} : { details }),
    },
  };
}

type RpcReply = { readonly id?: unknown; readonly method?: unknown; readonly params?: unknown; readonly result?: unknown; readonly error?: unknown };

function hostAbortedError(): Error & { readonly code: "host-aborted" } {
  return Object.assign(new Error("Grok host aborted"), { code: "host-aborted" as const });
}

function acpError(code: string, message: string, cause?: unknown): Error & { readonly code: string } {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { code });
}

/** One ACP JSON-RPC stdio process. Natural close/SIGTERM are its only lifecycle exits. */
export function connectGrokAcpStdio(options: {
  readonly binary: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly model?: string;
  readonly toolset?: string;
  readonly onNotification?: (method: string, params: Readonly<Record<string, unknown>>) => void;
}): Promise<GrokAcpConnection> {
  const args = [
    "agent",
    ...(options.model === undefined ? [] : ["--model", options.model]),
    "stdio",
  ];
  const env = options.toolset === undefined
    ? options.env
    : { ...options.env, GROK_CONFIG: JSON.stringify({ toolset: options.toolset }) };
  const child = spawn(options.binary, args, { cwd: options.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map<number, { resolve(value: Readonly<Record<string, unknown>>): void; reject(error: Error): void }>();
  const notificationHandlers: Array<(method: string, params: Readonly<Record<string, unknown>>) => void> = [];
  if (options.onNotification !== undefined) notificationHandlers.push(options.onNotification);
  let nextId = 0;
  let closed = false;
  let terminalError: Error | undefined;
  let stderr = "";
  const settleClosed = (error: Error): void => {
    if (closed) return;
    closed = true;
    terminalError = error;
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };
  // One terminal path: any malformed/unsupported frame or process death closes stdin,
  // kills the child, and settles every pending request with the same typed error.
  const terminate = (error: Error): void => {
    settleClosed(error);
    child.stdin.end();
    child.kill("SIGTERM");
  };
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  child.on("error", (error) => settleClosed(acpError("acp-process-error", `Grok ACP process error: ${error.message}`, error)));
  createInterface({ input: child.stdout }).on("line", (line) => {
    let message: RpcReply;
    try { message = JSON.parse(line) as RpcReply; }
    catch (error) {
      terminate(acpError("acp-invalid-json", `Invalid Grok ACP JSON: ${String(error)}`, error));
      return;
    }
    if (typeof message.method === "string") {
      const params = typeof message.params === "object" && message.params !== null
        ? message.params as Readonly<Record<string, unknown>> : {};
      for (const handler of notificationHandlers) handler(message.method, params);
      if (typeof message.id === "number") {
        if (message.method !== "session/request_permission") {
          terminate(acpError("acp-unsupported-client-request", `Unsupported Grok ACP client request: ${message.method}`));
          return;
        }
        const choices = Array.isArray(params.options) ? params.options : [];
        const selected = choices.find((value) =>
          typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "allow_once") as { optionId?: unknown } | undefined;
        if (typeof selected?.optionId !== "string") {
          terminate(acpError("acp-permission-missing-allow-once", "Grok ACP permission request omitted allow_once"));
          return;
        }
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { outcome: { outcome: "selected", optionId: selected.optionId } } })}\n`);
      }
      return;
    }
    if (typeof message.id !== "number") return;
    const waiter = pending.get(message.id);
    if (waiter === undefined) return;
    pending.delete(message.id);
    if (message.error !== undefined) waiter.reject(acpError("acp-upstream-error", `Grok ACP error: ${JSON.stringify(message.error)}`));
    else waiter.resolve((message.result ?? {}) as Readonly<Record<string, unknown>>);
  });
  child.on("close", (code) => settleClosed(acpError("acp-closed", `Grok ACP closed (${String(code)}): ${stderr}`)));
  return Promise.resolve({
    request(method, params) {
      if (closed) return Promise.reject(terminalError ?? acpError("acp-connection-closed", "Grok ACP connection is closed"));
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, (error) => {
          if (error === null || error === undefined) return;
          const waiter = pending.get(id);
          if (waiter === undefined) return;
          pending.delete(id);
          waiter.reject(acpError("acp-write-failed", `Grok ACP write failed: ${error.message}`, error));
        });
      });
    },
    notify(method, params) {
      if (closed) throw terminalError ?? acpError("acp-connection-closed", "Grok ACP connection is closed");
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    },
    onNotification(handler) {
      notificationHandlers.push(handler);
    },
    async close() {
      if (closed) return;
      settleClosed(acpError("acp-connection-closed", "Grok ACP connection is closed"));
      child.stdin.end();
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => child.once("close", () => resolve()));
    },
  });
}

/**
 * Main-session Grok adapter. The injected composition callbacks are the shared
 * envelope boundary: this module owns ACP lifecycle, never role policy.
 */
export function createGrokRoleTurnHost(config: GrokRoleTurnHostConfig): RoleTurnHost {
  let serial = Promise.resolve();
  return {
    executeTurn(request) {
      const execution = serial.then(async (): Promise<RoleTurnResult> => {
        const continuation = request.continuation;
        const prepared = await config.prepare(request);
        let connection: GrokAcpConnection | undefined;
        let sessionId: string | undefined;
        let accepted = false;
        try {
          // AK injection proof is prepared MCP composition (envelope).
          if (prepared.mcpServers.length === 0) {
            return failure("activation", "UncontrolledGrokSession", "ak-config-missing");
          }
          connection = await config.connect(request);
          const initialized = await connection.request("initialize", {
            protocolVersion: 1,
            clientCapabilities: {},
          });
          const initializeMeta = initialized._meta as {
            modelState?: { availableModels?: unknown };
          } | undefined;
          const modelState = initializeMeta?.modelState;
          const availableModels = Array.isArray(modelState?.availableModels) ? modelState.availableModels : undefined;
          if (request.model !== undefined && availableModels !== undefined && !availableModels.some((entry) =>
            typeof entry === "object" && entry !== null && (entry as { modelId?: unknown }).modelId === request.model?.model)) {
            return failure("activation", "GrokHostModelMismatch", "host-model-mismatch", {
              provider: request.model.provider,
              model: request.model.model,
            });
          }

          // #617 DK-7: hand Pi session path once; Grok reads the file itself.
          const priorNativePaths =
            continuation.kind === "resume"
            && request.hostTransition?.previousHost === "pi"
              ? request.hostTransition.priorNativePaths
              : undefined;
          if (continuation.kind === "resume") {
            const boundSessionId = await config.sessionIdentity.load(request.principal);
            if (boundSessionId !== undefined && boundSessionId !== "") {
              // Same-host Grok resume reuses native ACP session via session/load.
              const loaded = await connection.request("session/load", {
                sessionId: boundSessionId,
                cwd: request.cwd,
                mcpServers: prepared.mcpServers,
                _meta: { systemPromptOverride: renderGrokSystemPromptOverride(prepared.systemPrompt), yoloMode: false },
              });
              sessionId = typeof loaded.sessionId === "string" && loaded.sessionId !== ""
                ? loaded.sessionId
                : boundSessionId;
            } else {
              // Unbound resume (cross-host or lost binding): session/new + bind.
              const session = await connection.request(
                "session/new",
                {
                  cwd: request.cwd,
                  mcpServers: prepared.mcpServers,
                  _meta: { systemPromptOverride: renderGrokSystemPromptOverride(prepared.systemPrompt), yoloMode: false },
                },
              );
              sessionId = typeof session.sessionId === "string" ? session.sessionId : undefined;
              if (sessionId === undefined || sessionId === "") {
                return failure("session", "GrokAcpSessionFailure", "session-id-missing");
              }
              await config.sessionIdentity.bind(request.principal, sessionId);
            }
          } else {
            // Initial run: session/new + bind.
            const session = await connection.request(
              "session/new",
              {
                cwd: request.cwd,
                mcpServers: prepared.mcpServers,
                _meta: { systemPromptOverride: renderGrokSystemPromptOverride(prepared.systemPrompt), yoloMode: false },
              },
            );
            sessionId = typeof session.sessionId === "string" ? session.sessionId : undefined;
            if (sessionId === undefined || sessionId === "") {
              return failure("session", "GrokAcpSessionFailure", "session-id-missing");
            }
            await config.sessionIdentity.bind(request.principal, sessionId);
          }

          let prompt =
            priorNativePaths !== undefined && priorNativePaths.length > 0
              ? `${prepared.prompt}\n${priorNativePaths.join("\n")}`
              : prepared.prompt;
          // Envelope infra abort and parent cancellation (#675 nested summons) are
          // the same race face here: either one ends the ACP round and the finally
          // block cancels + closes the child session.
          const abortSignal =
            request.signal === undefined
              ? prepared.abortSignal
              : prepared.abortSignal === undefined
                ? request.signal
                : AbortSignal.any([prepared.abortSignal, request.signal]);
          const activeConnection = connection;

          /** Race ACP prompt against envelope abort so infra failInfrastructure cannot hang (#593). */
          const promptOrAbort = async (
            params: Readonly<Record<string, unknown>>,
          ): Promise<Readonly<Record<string, unknown>>> => {
            if (abortSignal?.aborted) {
              // Prefer closeRound's typed failure over a bare abort race winner.
              throw hostAbortedError();
            }
            const promptRequest = activeConnection.request("session/prompt", params);
            if (abortSignal === undefined) return promptRequest;
            return new Promise<Readonly<Record<string, unknown>>>((resolve, reject) => {
              let settled = false;
              const onAbort = (): void => {
                if (settled) return;
                settled = true;
                promptRequest.catch(() => {});
                reject(hostAbortedError());
              };
              abortSignal.addEventListener("abort", onAbort, { once: true });
              promptRequest.then(
                (value) => {
                  if (settled) return;
                  settled = true;
                  abortSignal.removeEventListener("abort", onAbort);
                  resolve(value);
                },
                (error) => {
                  if (settled) return;
                  settled = true;
                  abortSignal.removeEventListener("abort", onAbort);
                  reject(error);
                },
              );
            });
          };
          for (let attempt = 0; attempt < 8; attempt += 1) {
            let result: Readonly<Record<string, unknown>>;
            try {
              const promptParts: Array<Record<string, unknown>> = [
                { type: "text", text: prompt },
              ];
              result = await promptOrAbort({
                sessionId,
                prompt: promptParts,
              });
            } catch (error) {
              // Envelope abort (typed infra declaration): closeRound owns the failure record.
              if (
                typeof error === "object"
                && error !== null
                && (error as { code?: unknown }).code === "host-aborted"
              ) {
                const closure = await prepared.closeRound();
                if ("failure" in closure) {
                  return { code: null, stderr: "", timedOut: false, knownFailure: closure.failure };
                }
                return failure("session", "HostAborted", "host-aborted", { sessionId });
              }
              throw error;
            }
            if (result.stopReason === "refusal") {
              return failure("output", "GrokAcpRefusal", "refusal", { sessionId });
            }
            // session/prompt resolution is the sole typed round boundary before seal
            // when the turn ends without host abort; abort path closes above.
            const closure = await prepared.closeRound();
            if (closure.accepted) {
              // Wait for ACP's typed close acknowledgement before tearing down the
              // process; Stop hooks and fire-and-forget cancellation are not closure.
              await connection.request("session/close", { sessionId });
              accepted = true;
              return { code: 0, stderr: "", timedOut: false };
            }
            if ("failure" in closure) {
              return { code: null, stderr: "", timedOut: false, knownFailure: closure.failure };
            }
            prompt = `The prior terminal submission was rejected (${closure.retry.code}). Resubmit it as the sole terminal tool call. Rejected call ids: ${closure.retry.toolCallIds.join(", ") || "none"}.`;
          }
          return failure("output", "GrokAcpRoundLimit", "round-retry-limit", { sessionId });
        } finally {
          if (connection !== undefined) {
            if (sessionId !== undefined && !accepted) {
              try { connection.notify("session/cancel", { sessionId }); }
              catch { /* Preserve the original turn result or failure. */ }
            }
            try { await connection.close(); }
            catch { /* Preserve the original turn result or failure. */ }
          }
          try { await prepared.dispose?.(); }
          catch { /* Preserve the original turn result or failure. */ }
        }
      });
      serial = execution.then(() => undefined, () => undefined);
      return execution;
    },
  };
}

const PRIVATE_COMPAT_ENV = Object.fromEntries(
  ["CLAUDE", "CURSOR", "CODEX"].flatMap((vendor) =>
    ["SKILLS", "RULES", "AGENTS", "MCPS", "HOOKS", "SESSIONS"].map((kind) =>
      [`GROK_${vendor}_${kind}_ENABLED`, "false"] as const)),
);

/** Child environment shared by ACP agent processes. */
export function controlledGrokChildEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...base,
    ...PRIVATE_COMPAT_ENV,
    GROK_MEMORY: "0",
    GROK_SUBAGENTS: "0",
  };
}
