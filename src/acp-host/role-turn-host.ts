import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

import type { RoleTurnHost, RoleTurnKnownFailure, RoleTurnRequest, RoleTurnResult } from "../host-contracts.ts";
import {
  createSerializedRoleTurnHost,
  driveExternalRoleTurnRounds,
  raceAgainstHostAbort,
} from "../external-host-turn-loop.ts";
import { retainDiagnosticTail } from "../diagnostic-tail.ts";
import { reportHostSessionEvent } from "../host-session-record.ts";
import {
  renderSystemPromptOverride,
  type PreparedRoleTurn,
  type SessionIdentityAuthority,
} from "../prepared-role-turn.ts";
import { acpModelId, type AcpHostDescription } from "./description.ts";

/** ACP v1 surface used by the generic ACP adapter. Protocol details stay in this module. */
export interface AcpConnection {
  request(method: string, params: Readonly<Record<string, unknown>>): Promise<Readonly<Record<string, unknown>>>;
  notify(method: string, params: Readonly<Record<string, unknown>>): void;
  /** Subscribe to agent→client notifications (session/update stream, etc.). */
  onNotification?(handler: (method: string, params: Readonly<Record<string, unknown>>) => void): void;
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
    stderr = retainDiagnosticTail(stderr + chunk);
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
    try {
      if (prepared.mcpServers.length === 0) {
        return failure("activation", "UncontrolledAcpSession", "ak-config-missing");
      }
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

      connection.onNotification?.((method, params) => {
        if (method !== "session/update" || hostSessionRecordFailure !== undefined) return;
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
          return failure("activation", "AcpHostModelMismatch", "host-model-mismatch", {
            provider: request.model.provider,
            model: request.model.model,
          });
        }

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
        if (sessionId === undefined) {
          const session = await rpc("session/new", sessionBindParams);
          sessionId = typeof session.sessionId === "string" ? session.sessionId : undefined;
          if (sessionId === undefined || sessionId === "") {
            return failure("session", "AcpSessionFailure", "session-id-missing");
          }
          await config.sessionIdentity.bind(request.principal, sessionId);
        }

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
              if (hostSessionRecordFailure !== undefined) {
                return { status: "terminal", result: hostSessionRecordResult() };
              }
              throw error;
            }
            if (result.stopReason === "refusal") {
              return {
                status: "terminal",
                result: failure("output", "AcpRefusal", "refusal", { sessionId }),
              };
            }
            return { status: "delivered" };
          },
          async afterAccepted() {
            await rpc("session/close", { sessionId: activeSessionId });
            accepted = true;
          },
        });
        if (hostSessionRecordFailure !== undefined) return hostSessionRecordResult();
        return turnResult;
      } catch (error) {
        // recordAbort races setup RPCs via raceAgainstHostAbort (host-aborted code);
        // noteHostSessionRecordFailure always sets the typed failure before aborting.
        if (hostSessionRecordFailure !== undefined) return hostSessionRecordResult();
        throw error;
      }
    } finally {
      if (connection !== undefined) {
        if (sessionId !== undefined && !accepted) {
          try { connection.notify("session/cancel", { sessionId }); }
          catch { /* keep turn result */ }
        }
        try { await connection.close(); }
        catch { /* keep turn result */ }
      }
      try { await prepared.dispose?.(); }
      catch { /* keep turn result */ }
    }
  });
}
