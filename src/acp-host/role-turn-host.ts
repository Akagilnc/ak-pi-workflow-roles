import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

import type { RoleTurnHost, RoleTurnKnownFailure, RoleTurnRequest, RoleTurnResult } from "../host-contracts.ts";
import {
  createSerializedRoleTurnHost,
  driveExternalRoleTurnRounds,
  raceAgainstHostAbort,
} from "../external-host-turn-loop.ts";

import { reportHostSessionEvent } from "../host-session-record.ts";
import {
  NAVIGATOR_OUTPUT_TOOL_NAME,
  navigatorProseFromUnknown,
} from "../package-contracts/navigator-output.ts";
import {
  renderSystemPromptOverride,
  type PreparedRoleTurn,
  type SessionIdentityAuthority,
} from "../prepared-role-turn.ts";
import { acpModelId, type AcpHostDescription } from "./description.ts";

/**
 * #959: collect free-form agent text from ACP session/update stream.
 * Used only when the navigator seat spoke prose without calling the output tool.
 * ACP agent speech is only agent_message / agent_message_chunk — never user,
 * thought, or other *_message kinds (load replay must not poison the bucket).
 *
 * Standard ACP nests under params.update: { sessionUpdate, content }.
 * Flat params.sessionUpdate / string params.update remain accepted for host variants.
 */
function acpAgentTextChunk(params: Readonly<Record<string, unknown>>): string | undefined {
  let kind: unknown;
  let content: unknown;
  let textFallback: unknown;

  const nested = params.update;
  if (typeof nested === "object" && nested !== null && !Array.isArray(nested)) {
    const record = nested as Record<string, unknown>;
    kind = record.sessionUpdate;
    content = record.content;
    textFallback = record.text;
  } else {
    kind = params.sessionUpdate ?? nested;
    content = params.content;
    textFallback = params.text;
  }

  if (kind !== "agent_message_chunk" && kind !== "agent_message") return undefined;
  if (typeof content === "string" && content.length > 0) return content;
  if (typeof content === "object" && content !== null && !Array.isArray(content)) {
    const record = content as Record<string, unknown>;
    if (typeof record.text === "string" && record.text.length > 0) return record.text;
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (typeof part === "string" && part.length > 0) parts.push(part);
      else if (typeof part === "object" && part !== null) {
        const record = part as Record<string, unknown>;
        if (typeof record.text === "string" && record.text.length > 0) parts.push(record.text);
      }
    }
    if (parts.length > 0) return parts.join("");
  }
  if (typeof textFallback === "string" && textFallback.length > 0) return textFallback;
  return undefined;
}

/** ACP v1 surface used by the generic ACP adapter. Protocol details stay in this module. */
export interface AcpConnection {
  request(method: string, params: Readonly<Record<string, unknown>>): Promise<Readonly<Record<string, unknown>>>;
  notify(method: string, params: Readonly<Record<string, unknown>>): void;
  /** Subscribe to agent→client notifications (session/update stream, etc.). */
  onNotification?(handler: (method: string, params: Readonly<Record<string, unknown>>) => void): void;
  /** Full process stderr accumulated so far (#836). */
  stderr?(): string;
  close(): Promise<void>;
}

export type AcpRoleTurnHostConfig = Readonly<{
  sessionIdentity: SessionIdentityAuthority;
  /** Seat-table host key (e.g. grok-build) for sitian host field. */
  hostName: string;
  /** Whether a bound resume reuses the native session or mints a fresh one. */
  boundResume: AcpHostDescription["boundResume"];
  /**
   * How the seat model reaches the agent: "set_model" sends an ACP
   * `session/set_model` RPC with modelId `provider:model` once the session
   * exists (new or loaded); "argv" leaves it to the connect argv (--model).
   */
  modelPassing: AcpHostDescription["modelPassing"];
  connect(request: RoleTurnRequest): Promise<AcpConnection>;
  prepare(request: RoleTurnRequest): Promise<PreparedRoleTurn>;
}>;

function failure(
  cause: "activation" | "session" | "output",
  name: string,
  code: string,
  details?: Readonly<Record<string, unknown>>,
  diagnostic?: string,
): RoleTurnResult {
  return {
    code: null,
    stderr: "",
    timedOut: false,
    knownFailure: {
      cause,
      identity: { name, code },
      ...(diagnostic === undefined ? {} : { diagnostic }),
      ...(details === undefined ? {} : { details }),
    },
  };
}

/** Success→dispose failure; existing failure keeps primary cause + cleanup detail. */
function withCleanupFailure(outcome: RoleTurnResult, cleanupError: unknown): RoleTurnResult {
  const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
  if (outcome.knownFailure === undefined) {
    return failure("session", "AcpDisposeFailure", "dispose-failed", { cleanupError: message }, message);
  }
  return {
    ...outcome,
    knownFailure: {
      ...outcome.knownFailure,
      details: { ...(outcome.knownFailure.details ?? {}), cleanupError: message },
    },
  };
}

type RpcReply = { readonly id?: unknown; readonly method?: unknown; readonly params?: unknown; readonly result?: unknown; readonly error?: unknown };

function acpError(code: string, message: string, cause?: unknown): Error & { readonly code: string } {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { code });
}

/** One ACP JSON-RPC stdio process. Natural close/SIGTERM are its only lifecycle exits. */
export function connectAcpStdio(options: {
  readonly binary: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly onNotification?: (method: string, params: Readonly<Record<string, unknown>>) => void;
}): Promise<AcpConnection> {
  const child = spawn(options.binary, [...options.args], { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map<number, { resolve(value: Readonly<Record<string, unknown>>): void; reject(error: Error): void }>();
  const notificationHandlers: Array<(method: string, params: Readonly<Record<string, unknown>>) => void> = [];
  if (options.onNotification !== undefined) notificationHandlers.push(options.onNotification);
  let nextId = 0;
  let closed = false;
  let terminalError: Error | undefined;
  // Rolling diagnostic tail only — not an unbounded transcript face (same class as headless).
  let stderr = "";
  const settleClosed = (error: Error): void => {
    if (closed) return;
    closed = true;
    terminalError = error;
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };
  // Framing corruption or a known required capability with unusable shape still
  // closes the child. Unknown client methods are answered in-band (JSON-RPC
  // method not found) and do not terminate the leg (#760).
  const terminate = (error: Error): void => {
    settleClosed(error);
    child.stdin.end();
    child.kill("SIGTERM");
  };
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.on("error", (error) => settleClosed(acpError("acp-process-error", `ACP process error: ${error.message}`, error)));
  createInterface({ input: child.stdout }).on("line", (line) => {
    let message: RpcReply;
    try { message = JSON.parse(line) as RpcReply; }
    catch (error) {
      terminate(acpError("acp-invalid-json", `Invalid ACP JSON: ${String(error)}`, error));
      return;
    }
    if (typeof message.method === "string") {
      const params = typeof message.params === "object" && message.params !== null
        ? message.params as Readonly<Record<string, unknown>> : {};
      for (const handler of notificationHandlers) handler(message.method, params);
      if (typeof message.id === "number") {
        if (message.method !== "session/request_permission") {
          // Vendor extensions (_x.ai/*, …) and any other unhandled client request:
          // JSON-RPC method-not-found reply; session continues (#760).
          child.stdin.write(`${JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32601, message: `Method not found: ${message.method}` },
          })}\n`);
          return;
        }
        const choices = Array.isArray(params.options) ? params.options : [];
        const selected = choices.find((value) =>
          typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "allow_once") as { optionId?: unknown } | undefined;
        if (typeof selected?.optionId !== "string") {
          terminate(acpError("acp-permission-missing-allow-once", "ACP permission request omitted allow_once"));
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
    if (message.error !== undefined) waiter.reject(acpError("acp-upstream-error", `ACP error: ${JSON.stringify(message.error)}`));
    else waiter.resolve((message.result ?? {}) as Readonly<Record<string, unknown>>);
  });
  child.on("close", (code) => settleClosed(acpError("acp-closed", `ACP closed (${String(code)}): ${stderr}`)));
  return Promise.resolve({
    request(method, params) {
      if (closed) return Promise.reject(terminalError ?? acpError("acp-connection-closed", "ACP connection is closed"));
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, (error) => {
          if (error === null || error === undefined) return;
          const waiter = pending.get(id);
          if (waiter === undefined) return;
          pending.delete(id);
          waiter.reject(acpError("acp-write-failed", `ACP write failed: ${error.message}`, error));
        });
      });
    },
    notify(method, params) {
      if (closed) throw terminalError ?? acpError("acp-connection-closed", "ACP connection is closed");
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    },
    onNotification(handler) {
      notificationHandlers.push(handler);
    },
    stderr() {
      return stderr;
    },
    async close() {
      if (closed) return;
      settleClosed(acpError("acp-connection-closed", "ACP connection is closed"));
      child.stdin.end();
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => child.once("close", () => resolve()));
    },
  });
}

/** ACP last hop (#820): session open/load/close, prompt, MCP mount, capability/model. */
export function createAcpRoleTurnHost(config: AcpRoleTurnHostConfig): RoleTurnHost {
  return createSerializedRoleTurnHost(async (request): Promise<RoleTurnResult> => {
    const prepared = await config.prepare(request);
    const systemPromptOverride = renderSystemPromptOverride(prepared.systemPrompt);
    let connection: AcpConnection | undefined;
    let sessionId: string | undefined;
    let accepted = false;
    // Mutable so dispose failure can outrank a clean turn (headless withCleanupFailure face).
    let outcome: RoleTurnResult = failure("session", "AcpNoOutcome", "no-outcome");
    try {
      if (prepared.mcpServers.length === 0) {
        outcome = failure("activation", "UncontrolledAcpSession", "ak-config-missing");
      } else {
      connection = await config.connect(request);
      // Live host-session records: ACP session/update → sitian sole entry (#811).
      // One abort + one race helper + one outer projection — write failure ends
      // any in-flight RPC as typed session infrastructure failure.
      const sessionParent = config.sessionIdentity.resolveSessionFile(request.principal);
      const recordAbort = new AbortController();
      let hostSessionRecordFailure: RoleTurnKnownFailure | undefined;
      const hostSessionRecordResult = (): RoleTurnResult => ({
        code: null,
        stderr: "",
        timedOut: false,
        knownFailure: hostSessionRecordFailure!,
      });
      const noteHostSessionRecordFailure = (error: unknown): void => {
        if (hostSessionRecordFailure !== undefined) return;
        hostSessionRecordFailure = {
          cause: "session",
          identity: { name: "HostSessionRecordFailure", code: "host-session-record-failed" },
          diagnostic: error instanceof Error ? error.message : String(error),
        };
        try { recordAbort.abort(); } catch { /* already aborted */ }
      };
      const rpc = (
        method: string,
        params: Readonly<Record<string, unknown>>,
      ): Promise<Readonly<Record<string, unknown>>> =>
        raceAgainstHostAbort(connection!.request(method, params), recordAbort.signal, "host-session-record-failed");

      // #959: navigator free-form agent text — only while session/prompt is in flight.
      // session/load replays history via session/update; those must not enter the bucket
      // (resume / set_model load would otherwise prepend prior turns as "this turn" prose).
      const agentProseChunks: string[] = [];
      let collectAgentProse = false;
      connection.onNotification?.((method, params) => {
        if (method !== "session/update" || hostSessionRecordFailure !== undefined) return;
        if (collectAgentProse) {
          const chunk = acpAgentTextChunk(params);
          if (chunk !== undefined) agentProseChunks.push(chunk);
        }
        try {
          reportHostSessionEvent({
            host: config.hostName,
            cwd: request.cwd,
            sessionParent,
            source: "acp-host",
            event: { method, params },
          });
        } catch (error) {
          noteHostSessionRecordFailure(error);
        }
      });

      try {
        const initialized = await rpc("initialize", {
          protocolVersion: 1,
          clientCapabilities: {},
        });
        const initializeMeta = initialized._meta as {
          modelState?: { availableModels?: unknown };
        } | undefined;
        const availableModels = Array.isArray(initializeMeta?.modelState?.availableModels)
          ? initializeMeta.modelState.availableModels
          : undefined;
        if (request.model !== undefined && availableModels !== undefined && !availableModels.some((entry) =>
          typeof entry === "object" && entry !== null
          && (entry as { modelId?: unknown }).modelId === acpModelId(config.modelPassing, request.model))) {
          outcome = failure("activation", "AcpHostModelMismatch", "host-model-mismatch", {
            provider: request.model.provider,
            model: request.model.model,
          });
        } else {

        const sessionBindParams = {
          cwd: request.cwd,
          mcpServers: prepared.mcpServers,
          _meta: { systemPromptOverride, yoloMode: false },
        };
        const loadSession = async (bindSessionId: string): Promise<string> => {
          const loaded = await rpc("session/load", {
            sessionId: bindSessionId,
            ...sessionBindParams,
          });
          return typeof loaded.sessionId === "string" && loaded.sessionId !== ""
            ? loaded.sessionId
            : bindSessionId;
        };
        if (request.continuation.kind === "resume" && config.boundResume === "session/load") {
          const boundSessionId = await config.sessionIdentity.load(request.principal);
          if (boundSessionId !== undefined && boundSessionId !== "") {
            sessionId = await loadSession(boundSessionId);
          }
        }
        let sessionReady = true;
        if (sessionId === undefined) {
          const session = await rpc("session/new", sessionBindParams);
          sessionId = typeof session.sessionId === "string" ? session.sessionId : undefined;
          if (sessionId === undefined || sessionId === "") {
            outcome = failure("session", "AcpSessionFailure", "session-id-missing");
            sessionReady = false;
          } else {
            await config.sessionIdentity.bind(request.principal, sessionId);
          }
        }

        if (sessionReady) {
        // set_model seat provider:model (#778); may rebuild agent — re-bind via loadSession.
        if (config.modelPassing === "set_model" && request.model !== undefined && sessionId !== undefined) {
          await rpc("session/set_model", {
            sessionId,
            modelId: acpModelId(config.modelPassing, request.model),
          });
          sessionId = await loadSession(sessionId);
        }

        const activeConnection = connection;
        const activeSessionId = sessionId;
        const turnResult = await driveExternalRoleTurnRounds(prepared, request, {
          roundLimitName: "AcpRoundLimit",
          currentSessionId: () => sessionId,
          async runRound({ prompt, abortSignal }) {
            if (hostSessionRecordFailure !== undefined) return { status: "terminal", result: hostSessionRecordResult() };
            // Envelope infra abort, parent cancellation (#675), and host-session
            // record abort (#811) share one race face for in-flight prompt.
            const abortParts: AbortSignal[] = [recordAbort.signal];
            if (abortSignal !== undefined) abortParts.push(abortSignal);
            const combinedAbort = AbortSignal.any(abortParts);
            let result: Readonly<Record<string, unknown>>;
            // Open the prose gate only for this prompt round; clear any stale chunks first.
            agentProseChunks.length = 0;
            collectAgentProse = prepared.terminatingToolName === NAVIGATOR_OUTPUT_TOOL_NAME;
            try {
              result = await raceAgainstHostAbort(
                activeConnection.request("session/prompt", {
                  sessionId: activeSessionId,
                  prompt: [{ type: "text", text: prompt }],
                }),
                combinedAbort,
                "ACP host aborted",
              );
            } catch (error) {
              collectAgentProse = false;
              agentProseChunks.length = 0;
              if (hostSessionRecordFailure !== undefined) {
                return { status: "terminal", result: hostSessionRecordResult() };
              }
              throw error;
            }
            collectAgentProse = false;
            if (result.stopReason === "refusal") {
              agentProseChunks.length = 0;
              return {
                status: "terminal",
                result: failure("output", "AcpRefusal", "refusal", { sessionId }),
              };
            }
            // #959: navigator prose exit when the model spoke without the output tool.
            // Tool path still wins via MCP; ingest is a no-op once the tool already sealed.
            // Emptiness via shared projector; payload keeps original bytes (LLM 原话过手).
            if (prepared.terminatingToolName === NAVIGATOR_OUTPUT_TOOL_NAME) {
              const prose = agentProseChunks.join("");
              agentProseChunks.length = 0;
              if (navigatorProseFromUnknown(prose) !== undefined) {
                await prepared.ingestStructuredOutput({ prose });
              }
            } else {
              agentProseChunks.length = 0;
            }
            return { status: "delivered", stderr: activeConnection.stderr?.() ?? "" };
          },
          async afterAccepted() {
            await rpc("session/close", { sessionId: activeSessionId });
            accepted = true;
          },
        });
        outcome = hostSessionRecordFailure !== undefined ? hostSessionRecordResult() : turnResult;
        } // sessionReady
        } // model match else
      } catch (error) {
        // recordAbort races setup RPCs via raceAgainstHostAbort (host-aborted code);
        // noteHostSessionRecordFailure always sets the typed failure before aborting.
        if (hostSessionRecordFailure !== undefined) {
          outcome = hostSessionRecordResult();
        } else {
          throw error;
        }
      }
      } // mcpServers else
    } finally {
      if (connection !== undefined) {
        if (sessionId !== undefined && !accepted) {
          try { connection.notify("session/cancel", { sessionId }); }
          catch { /* keep turn result */ }
        }
        try { await connection.close(); }
        catch { /* keep turn result */ }
      }
      try {
        await prepared.dispose?.();
      } catch (cleanupError) {
        outcome = withCleanupFailure(outcome, cleanupError);
      }
    }
    return outcome;
  });
}
