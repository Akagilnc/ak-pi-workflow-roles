import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

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
    | { readonly accepted: false; readonly failure: RoleTurnKnownFailure }
  >;
}>;

export type GrokRoleTurnHostConfig = Readonly<{
  connect(request: RoleTurnRequest): Promise<GrokAcpConnection>;
  inspect(request: RoleTurnRequest): Promise<GrokControlledInspection>;
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

type RpcReply = { readonly id?: unknown; readonly result?: unknown; readonly error?: unknown };

/** One ACP JSON-RPC stdio process. Natural close/SIGTERM are its only lifecycle exits. */
export function connectGrokAcpStdio(options: {
  readonly binary: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly model?: string;
}): Promise<GrokAcpConnection> {
  const args = ["agent", ...(options.model === undefined ? [] : ["--model", options.model]), "--always-approve", "stdio"];
  const child = spawn(options.binary, args, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] });
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
      for (const waiter of pending.values()) waiter.reject(new Error(`Invalid Grok ACP JSON: ${String(error)}`));
      pending.clear();
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
        if (prepared.mcpServers.length === 0) {
          return failure("activation", "UncontrolledGrokSession", "ak-config-missing");
        }
        const connection = await config.connect(request);
        try {
          const initialized = await connection.request("initialize", {
            protocolVersion: 1,
            clientCapabilities: {},
          });
          const modelState = (initialized._meta as { modelState?: { availableModels?: unknown } } | undefined)?.modelState;
          const availableModels = Array.isArray(modelState?.availableModels) ? modelState.availableModels : undefined;
          if (request.model !== undefined && availableModels !== undefined && !availableModels.some((entry) =>
            typeof entry === "object" && entry !== null && (entry as { modelId?: unknown }).modelId === request.model?.model)) {
            return failure("activation", "GrokHostModelMismatch", "host-model-mismatch", {
              provider: request.model.provider,
              model: request.model.model,
            });
          }
          const continuation = request.continuation;
          const session = await connection.request(
            continuation.kind === "resume" ? "session/load" : "session/new",
            {
              ...(continuation.kind === "resume" ? { sessionId: String((request.principal as { sessionId?: unknown }).sessionId ?? "") } : {}),
              cwd: request.cwd,
              mcpServers: prepared.mcpServers,
              _meta: { systemPromptOverride: prepared.systemPrompt },
            },
          );
          const sessionId = continuation.kind === "resume"
            ? String((request.principal as { sessionId?: unknown }).sessionId ?? "")
            : session.sessionId;
          if (typeof sessionId !== "string" || sessionId === "") {
            return failure("session", "GrokAcpSessionFailure", "session-id-missing");
          }
          const result = await connection.request("session/prompt", {
            sessionId,
            prompt: [{ type: "text", text: continuation.prompt }],
          });
          if (result.stopReason === "refusal") {
            return failure("output", "GrokAcpRefusal", "refusal", { sessionId });
          }
          // session/prompt resolution is ACP's typed round boundary. At this point
          // the shared ledger has seen every MCP execute in the round.
          const closure = await prepared.closeRound({ sessionId, promptResult: result });
          if (!closure.accepted) {
            return { code: null, stderr: "", timedOut: false, knownFailure: closure.failure };
          }
          // Wait for ACP's typed close acknowledgement before tearing down the
          // process; Stop hooks and fire-and-forget cancellation are not closure.
          await connection.request("session/close", { sessionId });
          return { code: 0, stderr: "", timedOut: false };
        } finally {
          await connection.close();
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

type InspectItem = { readonly name?: unknown; readonly disabled?: unknown; readonly enabled?: unknown; readonly source?: { readonly type?: unknown; readonly path?: unknown } };

/** Classify first-party inspect JSON by provenance; wording and item counts are irrelevant. */
export function classifyGrokInspection(document: Readonly<Record<string, unknown>>, packageRoot: string): GrokControlledInspection {
  const privateActive = new Set<string>();
  const akActive = new Set<string>();
  for (const section of ["skills", "agents", "plugins", "mcpServers", "hooks", "projectInstructions"] as const) {
    const items = document[section];
    if (!Array.isArray(items)) continue;
    for (const value of items as InspectItem[]) {
      if (value.disabled === true || value.enabled === false) continue;
      const source = value.source;
      const sourceType = source?.type;
      const path = typeof source?.path === "string" ? source.path : "";
      const identity = `${section}:${typeof value.name === "string" ? value.name : path}`;
      if (sourceType === "builtin" || sourceType === "bundled") continue;
      if (path === packageRoot || path.startsWith(`${packageRoot}/`)) akActive.add(identity);
      else privateActive.add(identity);
    }
  }
  return { privateActive: [...privateActive].sort(), akActive: [...akActive].sort() };
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
