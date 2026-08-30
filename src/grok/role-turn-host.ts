import { execFile, spawn } from "node:child_process";
import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

import type { RoleTurnHost, RoleTurnKnownFailure, RoleTurnRequest, RoleTurnResult } from "../host-contracts.ts";

/** ACP v1 surface used by the Grok adapter. Protocol details stay in this module. */
export interface GrokAcpConnection {
  request(method: string, params: Readonly<Record<string, unknown>>): Promise<Readonly<Record<string, unknown>>>;
  notify(method: string, params: Readonly<Record<string, unknown>>): void;
  close(): Promise<void>;
}

export type GrokControlledInspection = Readonly<{
  /** Active configuration whose source is neither Grok builtin nor AK injection. */
  privateActive: readonly string[];
  /** Active AK-owned configuration observed by the same first-party inspect call. */
  akActive: readonly string[];
}>;

export type GrokPreparedTurn = Readonly<{
  mcpServers: readonly Readonly<Record<string, unknown>>[];
  systemPrompt: string;
  /** Shared ledger consumes the complete ACP round after session/prompt resolves. */
  closeRound(input: { readonly sessionId: string; readonly promptResult: Readonly<Record<string, unknown>> }): Promise<
    | { readonly accepted: true }
    | { readonly accepted: false; readonly retry: { readonly code: string; readonly toolCallIds: readonly string[] } }
    | { readonly accepted: false; readonly failure: RoleTurnKnownFailure }
  >;
  dispose?(): Promise<void>;
}>;

export type GrokCapabilityDeclaration = Readonly<{
  nativeToolNarrowing: false;
  preToolUseDeny: boolean;
}>;

export type GrokSessionIdentityAuthority = Readonly<{
  load(principal: RoleTurnRequest["principal"]): Promise<string | undefined>;
  bind(principal: RoleTurnRequest["principal"], sessionId: string): Promise<void>;
}>;

export type GrokRoleTurnHostConfig = Readonly<{
  sessionIdentity: GrokSessionIdentityAuthority;
  connect(request: RoleTurnRequest): Promise<GrokAcpConnection>;
  inspect(request: RoleTurnRequest): Promise<GrokControlledInspection>;
  prepare(request: RoleTurnRequest): Promise<GrokPreparedTurn>;
  recordCapabilities(request: RoleTurnRequest, declaration: GrokCapabilityDeclaration): void | Promise<void>;
  installPreToolUseDeny?(request: RoleTurnRequest): void | Promise<void>;
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
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  child.on("error", (error) => settleClosed(new Error(`Grok ACP process error: ${error.message}`, { cause: error })));
  createInterface({ input: child.stdout }).on("line", (line) => {
    let message: RpcReply;
    try { message = JSON.parse(line) as RpcReply; }
    catch (error) {
      settleClosed(new Error(`Invalid Grok ACP JSON: ${String(error)}`, { cause: error }));
      child.stdin.end();
      child.kill("SIGTERM");
      return;
    }
    if (typeof message.method === "string") {
      const params = typeof message.params === "object" && message.params !== null
        ? message.params as Readonly<Record<string, unknown>> : {};
      options.onNotification?.(message.method, params);
      if (typeof message.id === "number") {
        if (message.method !== "session/request_permission") {
          settleClosed(new Error(`Unsupported Grok ACP client request: ${message.method}`));
          child.stdin.end();
          child.kill("SIGTERM");
          return;
        }
        const choices = Array.isArray(params.options) ? params.options : [];
        const selected = choices.find((value) =>
          typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "allow_once") as { optionId?: unknown } | undefined;
        if (typeof selected?.optionId !== "string") {
          settleClosed(new Error("Grok ACP permission request omitted allow_once"));
          child.stdin.end();
          child.kill("SIGTERM");
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
    if (message.error !== undefined) waiter.reject(new Error(`Grok ACP error: ${JSON.stringify(message.error)}`));
    else waiter.resolve((message.result ?? {}) as Readonly<Record<string, unknown>>);
  });
  child.on("close", (code) => settleClosed(new Error(`Grok ACP closed (${String(code)}): ${stderr}`)));
  return Promise.resolve({
    request(method, params) {
      if (closed) return Promise.reject(terminalError ?? new Error("Grok ACP connection is closed"));
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, (error) => {
          if (error === null || error === undefined) return;
          const waiter = pending.get(id);
          if (waiter === undefined) return;
          pending.delete(id);
          waiter.reject(new Error(`Grok ACP write failed: ${error.message}`, { cause: error }));
        });
      });
    },
    notify(method, params) {
      if (closed) throw terminalError ?? new Error("Grok ACP connection is closed");
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    },
    async close() {
      if (closed) return;
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
        if (request.model !== undefined && request.model.provider !== "xai") {
          return failure("activation", "GrokHostModelMismatch", "host-model-mismatch", {
            provider: request.model.provider,
            model: request.model.model,
          });
        }
        const inspected = await config.inspect(request);
        if (inspected.privateActive.length !== 0) {
          return failure("activation", "UncontrolledGrokSession", "private-config-active", {
            privateActive: [...inspected.privateActive],
          });
        }
        const prepared = await config.prepare(request);
        let connection: GrokAcpConnection | undefined;
        let sessionId: string | undefined;
        let accepted = false;
        try {
          if (inspected.akActive.length === 0 || prepared.mcpServers.length === 0) {
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
          const hookMeta = initialized._meta as { "x.ai/hooks"?: { blockingEvents?: unknown; decisions?: unknown } } | undefined;
          const hookCapability = hookMeta?.["x.ai/hooks"];
          const canDeny = Array.isArray(hookCapability?.blockingEvents)
            && hookCapability.blockingEvents.includes("pre_tool_use")
            && Array.isArray(hookCapability.decisions)
            && hookCapability.decisions.includes("deny");
          const preToolUseDeny = canDeny && config.installPreToolUseDeny !== undefined;
          if (preToolUseDeny) await config.installPreToolUseDeny?.(request);
          await config.recordCapabilities(request, { nativeToolNarrowing: false, preToolUseDeny });
          const modelState = initializeMeta?.modelState;
          const availableModels = Array.isArray(modelState?.availableModels) ? modelState.availableModels : undefined;
          if (request.model !== undefined && availableModels !== undefined && !availableModels.some((entry) =>
            typeof entry === "object" && entry !== null && (entry as { modelId?: unknown }).modelId === request.model?.model)) {
            return failure("activation", "GrokHostModelMismatch", "host-model-mismatch", {
              provider: request.model.provider,
              model: request.model.model,
            });
          }
          const continuation = request.continuation;
          const resumedSessionId = continuation.kind === "resume"
            ? await config.sessionIdentity.load(request.principal)
            : undefined;
          if (continuation.kind === "resume" && resumedSessionId === undefined) {
            return failure("session", "GrokAcpSessionFailure", "session-binding-missing");
          }
          const session = await connection.request(
            continuation.kind === "resume" ? "session/load" : "session/new",
            {
              ...(resumedSessionId === undefined ? {} : { sessionId: resumedSessionId }),
              cwd: request.cwd,
              mcpServers: prepared.mcpServers,
              _meta: { systemPromptOverride: prepared.systemPrompt, yoloMode: false },
            },
          );
          sessionId = resumedSessionId ?? (typeof session.sessionId === "string" ? session.sessionId : undefined);
          if (sessionId === undefined || sessionId === "") {
            return failure("session", "GrokAcpSessionFailure", "session-id-missing");
          }
          if (continuation.kind === "initial") await config.sessionIdentity.bind(request.principal, sessionId);
          let prompt = continuation.prompt;
          for (let attempt = 0; attempt < 8; attempt += 1) {
            const result = await connection.request("session/prompt", {
              sessionId,
              prompt: [{ type: "text", text: prompt }],
            });
            if (result.stopReason === "refusal") {
              return failure("output", "GrokAcpRefusal", "refusal", { sessionId });
            }
            // session/prompt resolution is ACP's typed round boundary. At this point
            // the shared ledger has seen every MCP execute in the round.
            const closure = await prepared.closeRound({ sessionId, promptResult: result });
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
            await connection.close();
          }
          await prepared.dispose?.();
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

type InspectItem = {
  readonly name?: unknown;
  readonly path?: unknown;
  readonly disabled?: unknown;
  readonly enabled?: unknown;
  readonly compatibilityStatus?: unknown;
  readonly source?: { readonly type?: unknown; readonly path?: unknown };
};

/** Classify first-party inspect JSON by provenance; wording and item counts are irrelevant. */
export function classifyGrokInspection(document: Readonly<Record<string, unknown>>, packageRoot: string): GrokControlledInspection {
  const privateActive = new Set<string>();
  const akActive = new Set<string>();
  const externalCompat = document.externalCompat as { cells?: unknown } | undefined;
  if (Array.isArray(externalCompat?.cells)) {
    for (const cell of externalCompat.cells as Array<{ vendor?: unknown; surface?: unknown; enabled?: unknown }>) {
      if (cell.enabled !== true) continue;
      privateActive.add(`externalCompat:${String(cell.vendor)}:${String(cell.surface)}`);
    }
  }
  for (const section of ["skills", "agents", "plugins", "mcpServers", "hooks", "projectInstructions"] as const) {
    const items = document[section];
    if (!Array.isArray(items)) continue;
    for (const value of items as InspectItem[]) {
      if (value.disabled === true || value.enabled === false || value.compatibilityStatus === "disabled") continue;
      const source = value.source;
      const sourceType = source?.type;
      const path = typeof source?.path === "string"
        ? source.path
        : typeof value.path === "string" ? value.path : "";
      const identity = `${section}:${typeof value.name === "string" ? value.name : path}`;
      if (sourceType === "builtin" || sourceType === "bundled") continue;
      if (path === packageRoot || path.startsWith(`${packageRoot}/`)) akActive.add(identity);
      else privateActive.add(identity);
    }
  }
  return { privateActive: [...privateActive].sort(), akActive: [...akActive].sort() };
}

const execFileAsync = promisify(execFile);

/** Copy only Grok's authentication authority into an otherwise isolated home. */
export async function prepareControlledGrokHome(sourceHome: string, controlledHome: string): Promise<void> {
  await mkdir(controlledHome, { recursive: true, mode: 0o700 });
  await copyFile(join(sourceHome, ".grok", "auth.json"), join(controlledHome, "auth.json"));
}

/** First-party structured inspection under the exact environment used by ACP. */
export async function inspectControlledGrok(options: {
  readonly binary: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly packageRoot: string;
}): Promise<GrokControlledInspection> {
  const { stdout } = await execFileAsync(options.binary, ["inspect", "--json"], {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
  });
  const document: unknown = JSON.parse(stdout);
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    throw new Error("Grok structured inspection did not return an object");
  }
  return classifyGrokInspection(document as Readonly<Record<string, unknown>>, options.packageRoot);
}

/** Exact child environment shared by inspect and ACP agent processes. */
export function controlledGrokChildEnv(base: NodeJS.ProcessEnv, grokHome: string): NodeJS.ProcessEnv {
  return {
    ...base,
    ...PRIVATE_COMPAT_ENV,
    HOME: grokHome,
    GROK_HOME: grokHome,
    GROK_MEMORY: "0",
    GROK_SUBAGENTS: "0",
  };
}
