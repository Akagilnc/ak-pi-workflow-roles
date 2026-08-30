import type { RoleTurnHost, RoleTurnRequest, RoleTurnResult } from "../host-contracts.ts";

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

/**
 * Main-session Grok adapter. The injected composition callbacks are the shared
 * envelope boundary: this module owns ACP lifecycle, never role policy.
 */
export function createGrokRoleTurnHost(config: GrokRoleTurnHostConfig): RoleTurnHost {
  let serial = Promise.resolve();
  return {
    executeTurn(request) {
      const execution = serial.then(async (): Promise<RoleTurnResult> => {
        if (request.model !== undefined && request.model.model !== "grok-build") {
          return failure("activation", "GrokHostModelMismatch", "host-model-mismatch", {
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
          await connection.request("initialize", {
            protocolVersion: 1,
            clientCapabilities: {},
          });
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
          // the shared ledger has seen every MCP execute in the round; cancellation
          // prevents a sealed role session from accepting further work.
          connection.notify("session/cancel", { sessionId });
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
    GROK_HOME: grokHome,
    GROK_MEMORY: "0",
    GROK_SUBAGENTS: "0",
  };
}
