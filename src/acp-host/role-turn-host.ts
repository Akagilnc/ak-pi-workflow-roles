import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

import type { RoleTurnHost, RoleTurnRequest, RoleTurnResult } from "../host-contracts.ts";
import { sessionDirectoryOf } from "../role-run-placement.ts";
import {
  createSerializedRoleTurnHost,
  driveExternalRoleTurnRounds,
  disposeExternalRoleTurn,
  externalHostFailure as failure,
  raceAgainstHostAbort,
  recordTurnDelivery,
} from "../external-host-turn-loop.ts";
import { describeErrorIdentity } from "../public-cli/run-lifecycle.ts";
import { projectThrownFailureLeaf, retainPackageFault } from "../public-cli/settlement.ts";

import {
  copyAndRecordHostDossier,
  recordNativeSessionPointer,
} from "../host-session-record.ts";
import {
  NAVIGATOR_OUTPUT_TOOL_NAME,
  navigatorProseFromUnknown,
} from "../package-contracts/navigator-output.ts";
import {
  renderSystemPromptOverride,
  resolveBoundHostSessionId,
  type PreparedRoleTurn,
  type SessionIdentityAuthority,
} from "../prepared-role-turn.ts";
import { acpModelId, type AcpHostDescription } from "./description.ts";

import { isRecord } from "../unknown-value.ts";

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
  if (isRecord(nested)) {
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
  if (isRecord(content)) {
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
  /** Observed native termination / RPC report, absent before either exists. */
  result?(): RoleTurnResult | undefined;
  /** Return spontaneous native termination, not a package-initiated daemon stop. */
  close(): Promise<void | RoleTurnResult>;
}

export type AcpRoleTurnHostConfig = Readonly<{
  sessionIdentity: SessionIdentityAuthority;
  /** Seat-table host key (e.g. grok-build) for sitian host field. */
  hostName: string;
  /**
   * How the seat model reaches the agent: "set_model" sends an ACP
   * `session/set_model` RPC once the session exists (new or loaded); "argv"
   * leaves it to the connect argv (--model). Catalog modelId shape is
   * `setModelId` (host-native).
   */
  modelPassing: AcpHostDescription["modelPassing"];
  /** Host-native set_model catalog id; see AcpHostDescription.setModelId. */
  setModelId?: AcpHostDescription["setModelId"];
  connect(request: RoleTurnRequest): Promise<AcpConnection>;
  prepare(request: RoleTurnRequest): Promise<PreparedRoleTurn>;
}>;

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
  const pending = new Map<number, { resolve(value: Readonly<Record<string, unknown>>): void; reject(error: unknown): void }>();
  const notificationHandlers: Array<(method: string, params: Readonly<Record<string, unknown>>) => void> = [];
  if (options.onNotification !== undefined) notificationHandlers.push(options.onNotification);
  let nextId = 0;
  let closed = false;
  let terminalError: unknown;
  let spawned = false;
  let stoppedByPackage = false;
  let nativeExit: Pick<RoleTurnResult, "code" | "signal" | "timedOut"> | undefined;
  let rpcFailure: RoleTurnResult["knownFailure"];
  child.once("spawn", () => { spawned = true; });
  // Native stderr bytes stay separate from transport exception diagnostics.
  let stderr = "";
  const settleClosed = (error: unknown): void => {
    if (closed) return;
    closed = true;
    terminalError = error;
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };
  // Framing corruption or a known required capability with unusable shape still
  // closes the child. Unknown client methods are answered in-band (JSON-RPC
  // method not found) and do not terminate the leg (#760).
  const terminate = (error: unknown): void => {
    settleClosed(error);
    child.stdin.end();
    stoppedByPackage = child.kill("SIGTERM") || stoppedByPackage;
  };
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  }).on("error", terminate);
  child.on("error", settleClosed);
  child.stdin.on("error", terminate);
  createInterface({ input: child.stdout }).on("error", terminate).on("line", (line) => {
    try {
      const message = JSON.parse(line) as RpcReply;
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
      if (message.error !== undefined) {
        const diagnostic = typeof message.error === "object" && message.error !== null
          && "message" in message.error && typeof message.error.message === "string"
          ? message.error.message : JSON.stringify(message.error);
        rpcFailure ??= { diagnostic, details: message };
        waiter.reject(acpError("acp-upstream-error", diagnostic, message));
      } else waiter.resolve((message.result ?? {}) as Readonly<Record<string, unknown>>);
    } catch (error) {
      terminate(error);
    }
  });
  const processClosed = new Promise<void>((resolve) => {
    child.once("close", (code, signal) => {
      // ENOENT also emits close, but no host process was launched in that case.
      if (spawned) nativeExit = { code, timedOut: false, ...(signal === null ? {} : { signal }) };
      settleClosed(acpError("acp-closed", "ACP process closed"));
      resolve();
    });
  });
  return Promise.resolve({
    request(method, params) {
      if (closed) return Promise.reject(terminalError);
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, (error) => {
          if (error === null || error === undefined) return;
          const waiter = pending.get(id);
          if (waiter === undefined) return;
          pending.delete(id);
          waiter.reject(error);
        });
      });
    },
    notify(method, params) {
      if (closed) throw terminalError;
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    },
    onNotification(handler) {
      notificationHandlers.push(handler);
    },
    stderr() {
      return stderr;
    },
    result() {
      if (nativeExit === undefined && rpcFailure === undefined) return undefined;
      return {
        ...(nativeExit ?? { code: null, timedOut: false }),
        stderr,
        ...(rpcFailure === undefined ? {} : { knownFailure: rpcFailure }),
      };
    },
    async close() {
      if (!closed) terminate(acpError("acp-connection-closed", "ACP connection is closed"));
      await processClosed;
      return !stoppedByPackage && nativeExit !== undefined ? { ...nativeExit, stderr } : undefined;
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
    let sessionOpened = false;
    let accepted = false;
    const sessionParent = config.sessionIdentity.resolveSessionFile(request.principal);
    let outcome: RoleTurnResult = failure("session", "AcpNoOutcome", "no-outcome");
    let reportedFailure: RoleTurnResult["knownFailure"];
    let packageFailure: RoleTurnResult["knownFailure"];
    try {
      if (prepared.mcpServers.length === 0) {
        outcome = failure("activation", "UncontrolledAcpSession", "ak-config-missing");
      } else {
      connection = await config.connect(request);
      const rpc = (
        method: string,
        params: Readonly<Record<string, unknown>>,
      ): Promise<Readonly<Record<string, unknown>>> => connection!.request(method, params);

      // #959: navigator free-form agent text — only while session/prompt is in flight.
      // session/load replays history via session/update; those must not enter the bucket
      // (resume / set_model load would otherwise prepend prior turns as "this turn" prose).
      const agentProseChunks: string[] = [];
      let collectAgentProse = false;
      connection.onNotification?.((method, params) => {
        const isSessionUpdate = method === "session/update";
        if (!isSessionUpdate) return;
        if (collectAgentProse) {
          const chunk = acpAgentTextChunk(params);
          if (chunk !== undefined) agentProseChunks.push(chunk);
        }
      });

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
          && (entry as { modelId?: unknown }).modelId === acpModelId(config, request.model))) {
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
          const loadedId = typeof loaded.sessionId === "string" && loaded.sessionId !== ""
            ? loaded.sessionId
            : bindSessionId;
          if (config.hostName !== "hermes") recordNativeSessionPointer({
            host: config.hostName, sessionId: loadedId, cwd: request.cwd, sessionParent, home: request.home,
          });
          return loadedId;
        };
        let sessionReady = true;
        if (request.continuation.kind === "resume") {
          const boundSessionId = await resolveBoundHostSessionId(request, config.sessionIdentity);
          if (boundSessionId !== undefined && boundSessionId !== "") {
            sessionId = boundSessionId;
            sessionId = await loadSession(boundSessionId);
            sessionOpened = true;
          } else {
            outcome = failure(
              "session",
              "AcpSessionFailure",
              "session-id-missing",
              undefined,
              "resume requires a bound session id",
            );
            sessionReady = false;
          }
        } else {
          const session = await rpc("session/new", sessionBindParams);
          sessionId = typeof session.sessionId === "string" ? session.sessionId : undefined;
          if (sessionId === undefined || sessionId === "") {
            outcome = failure("session", "AcpSessionFailure", "session-id-missing");
            sessionReady = false;
          } else {
            if (config.hostName !== "hermes") recordNativeSessionPointer({
              host: config.hostName, sessionId, cwd: request.cwd, sessionParent, home: request.home,
            });
            sessionOpened = true;
            await config.sessionIdentity.bind(request.principal, sessionId);
          }
        }

        if (sessionReady) {
        // set_model host-native catalog id (#778 / #1146); may rebuild agent — re-bind via loadSession.
        if (config.modelPassing === "set_model" && request.model !== undefined && sessionId !== undefined) {
          await rpc("session/set_model", {
            sessionId,
            modelId: acpModelId(config, request.model),
          });
          sessionId = await loadSession(sessionId);
        }

        const activeConnection = connection;
        const activeSessionId = sessionId;
        const turnResult = await driveExternalRoleTurnRounds(prepared, request, {
          roundLimitName: "AcpRoundLimit",
          currentSessionId: () => sessionId,
          async runRound({ prompt, abortSignal }) {
            // One history row per actual session/prompt start (催交回合各算一次).
            // MCP advertises tool.parameters; prepared.jsonSchema is the headless
            // draft-07 stamp of that clone — record the delivered parameters face.
            const { $schema: _headlessStamp, ...deliveredSchema } = prepared.jsonSchema;
            await recordTurnDelivery(request.runDirectory, {
              systemPrompt: systemPromptOverride,
              outputSchema: deliveredSchema,
            }, "acp-host");
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
                abortSignal,
                "ACP host aborted",
              );
            } catch (error) {
              collectAgentProse = false;
              agentProseChunks.length = 0;
              throw error;
            }
            collectAgentProse = false;
            if (result.stopReason === "refusal") {
              agentProseChunks.length = 0;
              reportedFailure = { diagnostic: result.stopReason, details: result };
              return {
                status: "terminal",
                result: {
                  code: null,
                  stderr: activeConnection.stderr?.() ?? "",
                  timedOut: false,
                  knownFailure: reportedFailure,
                },
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
        outcome = turnResult;
        } // sessionReady
        } // model match else
      } // mcpServers else
    } catch (error) {
      const native = connection?.result?.();
      reportedFailure = native?.knownFailure;
      outcome = native ?? { code: null, stderr: connection?.stderr?.() ?? "", timedOut: false };
      await retainPackageFault({
        runDirectory: request.runDirectory,
        diagnostic: `ACP turn exception beside native host facts: ${describeErrorIdentity(error)}`,
        error,
      });
      // Native abnormal exit / RPC report stays primary. Otherwise this is a
      // real package exception, not a host cause inferred from missing output.
      if (outcome.knownFailure === undefined && !outcome.timedOut && outcome.signal === undefined
        && (native === undefined || outcome.code === 0 || outcome.code === null)) {
        packageFailure = projectThrownFailureLeaf(error);
        outcome = { ...outcome, knownFailure: packageFailure };
      }
    } finally {
      let naturalTermination: RoleTurnResult | void = undefined;
      if (connection !== undefined) {
        if (sessionId !== undefined && !accepted) {
          try { connection.notify("session/cancel", { sessionId }); }
          catch (error) {
            await retainPackageFault({
              runDirectory: request.runDirectory,
              diagnostic: `session cancel failed beside host terminal: ${describeErrorIdentity(error)}`,
              error,
            });
          }
        }
        try { naturalTermination = await connection.close(); }
        catch (error) {
          await retainPackageFault({
            runDirectory: request.runDirectory,
            diagnostic: `connection close failed beside host terminal: ${describeErrorIdentity(error)}`,
            error,
          });
        }
      }
      // Both success and failure drain the native stderr stream, including
      // bytes arriving after the last RPC response.
      outcome = { ...outcome, stderr: connection?.stderr?.() ?? outcome.stderr };
      // On abnormal paths, teardown has now drained the real close/stderr.
      // A successful ACP protocol turn remains successful: its ordinary
      // connection cleanup is not reclassified as a role failure.
      const native = connection?.result?.() ?? naturalTermination;
      if (native !== undefined && (naturalTermination !== undefined || outcome.code !== 0
        || outcome.knownFailure !== undefined || outcome.timedOut || outcome.signal !== undefined)) {
        // A late native failure stays primary over a package failure. An own
        // SIGTERM stop alone is ordinary disposal, not a guessed host cause.
        const nativeFailed = (native.code !== null && native.code !== 0)
          || (naturalTermination !== undefined && (native.timedOut || native.signal !== undefined));
        let knownFailure = outcome.knownFailure;
        if (nativeFailed && knownFailure !== undefined && knownFailure !== reportedFailure) {
          if (knownFailure !== packageFailure) await retainPackageFault({
            runDirectory: request.runDirectory,
            diagnostic: knownFailure.diagnostic ?? "ACP package failure beside late native termination",
            error: knownFailure,
          });
          knownFailure = reportedFailure;
        }
        const { knownFailure: _nativeFailure, ...facts } = native;
        outcome = { ...facts, ...(knownFailure === undefined ? {} : { knownFailure }) };
      }
      if (config.hostName !== "hermes" && sessionOpened && sessionId !== undefined) {
        try {
          copyAndRecordHostDossier({
            host: config.hostName,
            sessionId,
            cwd: request.cwd,
            sessionDirectory: sessionDirectoryOf(request.runDirectory),
            sessionParent,
            ...(request.home !== undefined ? { home: request.home } : {}),
          });
        } catch (error) {
          await retainPackageFault({
            runDirectory: request.runDirectory,
            diagnostic: `host dossier copy failed beside host terminal: ${describeErrorIdentity(error)}`,
            error,
          });
        }
      }
      outcome = await disposeExternalRoleTurn(prepared, request, outcome);
    }
    return outcome;
  });
}
