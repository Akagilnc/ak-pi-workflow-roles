import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ENGINE_FLAG_NAME, normalizeEngineName } from "./engine-detour.ts";
import { requireGatekeeperPass } from "./gatekeeper-pass-envelope.ts";
import type {
  HostContext,
  HostEventRegistration,
  HostSkillExpansionEvidence,
  HostToolDefinition,
  RoleEnvelopeHost,
  RoleHost,
  RoleTurnKnownFailure,
  RoleTurnRequest,
} from "./host-contracts.ts";
import { packagedRoleOutputTool } from "./packaged-role-registry.ts";
import { stripSkillFrontmatter } from "./package-resources/method-skill.ts";
import {
  createRoleRuntimeExtension,
  type RoleRuntimeDependencies,
} from "./role-runtime.ts";
import type { PreparedRoleTurn } from "./prepared-role-turn.ts";
import { projectActivationFlags } from "./role-activation-flags.ts";
import {
  isCorrectableExecuteError,
  mechanicalSubmissionRejectionResumeMessage,
  projectCorrectableExecuteRejection,
} from "./submission-correctable-error.ts";
import {
  buildNavigatorInfrastructureFailureFact,
  extractInfrastructureFailureEvidence,
} from "./navigator-invocation-identity.ts";

export { projectActivationFlags };

type Handler = HostEventRegistration[1];
type RpcRequest = { readonly id: number; readonly token: string; readonly method: string; readonly params?: Record<string, unknown> };
type ToolCallParams = { readonly name?: unknown; readonly arguments?: unknown };
type ContentPart = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

/**
 * Build host-side Skill expansion evidence from pre-read RoleTurnRequest.methods.
 * Non-pi hosts never parse Pi `/skill:` syntax (ADR 0082 `pi-no-privilege`);
 * a single bound method treats the plain prompt as the preserved user message.
 * Pi-native slash forms stay inside `src/pi/` only.
 */
export function buildSkillExpansion(
  methodSkills: ReadonlyMap<string, { readonly path: string; readonly body: string }>,
  prompt: string,
): HostSkillExpansionEvidence | undefined {
  if (methodSkills.size !== 1) return undefined;
  const entry = methodSkills.entries().next().value;
  if (entry === undefined) return undefined;
  const [name, method] = entry;
  return Object.freeze({
    name,
    location: method.path,
    content: `References are relative to ${dirname(method.path)}.\n\n${method.body}`,
    // Non-pi typed chain keeps original task bytes (ticket #822 r3); no consumer trim.
    userMessage: prompt,
  });
}

async function listen(server: Server, path: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => { server.off("error", reject); resolve(); });
  });
}

/** JSON Schema draft-07 document for host-native `--json-schema` (headless). */
export function terminatingToolJsonSchema(parameters: unknown): Readonly<Record<string, unknown>> {
  const cloned = JSON.parse(JSON.stringify(parameters)) as Record<string, unknown>;
  // $schema last so a newer declaration on the tool parameters cannot override draft-07.
  return Object.freeze({
    ...cloned,
    $schema: "http://json-schema.org/draft-07/schema#",
  });
}

export async function prepareRoleEnvelope(options: {
  readonly request: RoleTurnRequest;
  readonly dependencies: RoleRuntimeDependencies;
  /**
   * MCP unix socket path for the protocol-relay child. Always required — AK tools
   * ride this single MCP path; headless structured_output reuses the same
   * terminating-tool ledger path without listing the terminating tool on MCP.
   */
  readonly socketPath: string;
  /**
   * Whether MCP `tools/list` advertises the role terminating tool.
   * ACP keeps it listed (session-tool receipt). Headless hides it so the host
   * native `--json-schema` / structured_output is the sole schema channel
   * (#750 submission-tool-is-schema-channel) and empty MCP probes cannot
   * pre-empt a later structured_output.
   */
  readonly listTerminatingToolOnMcp?: boolean;
  /**
   * Durable principal session path (header layout only).
   * Production passes DurablePrincipalAuthority.decode(principal).sessionFile so
   * isAvailable and envelope mint the same file. Tests may omit → runDirectory default.
   */
  readonly sessionFile?: string;
}): Promise<PreparedRoleTurn> {
  const { request } = options;
  if (options.socketPath === "") {
    throw new Error("prepareRoleEnvelope requires socketPath");
  }
  const listTerminatingToolOnMcp = options.listTerminatingToolOnMcp !== false;
  const earlyTerminatingTool = packagedRoleOutputTool(request.activation.role);
  if (earlyTerminatingTool === undefined) {
    throw new Error(`role has no terminating tool: ${request.activation.role}`);
  }
  const flags = projectActivationFlags(request);
  // #818 P1: engine axis is request-scoped on this RoleHost — never process.env.
  // Always project ("" = no engine) so ambient AK_ROLE_ENGINE cannot arm detour.
  flags.set(ENGINE_FLAG_NAME, normalizeEngineName(request.engine) ?? "");
  const tools = new Map<string, HostToolDefinition>();
  const handlers = new Map<string, Handler[]>();
  const calls: Array<{ toolCallId: string; toolName: string }> = [];
  const customEntries: Array<{ customType: string; data: unknown }> = [];
  /** In-memory turn books for role lifecycle and audit subjects. */
  const sessionEntries: Array<Record<string, unknown>> = [];
  const methodSkills = new Map<string, { path: string; body: string }>();
  let preferredTools: string[] = [];
  let rejection:
    | { readonly code: string; readonly toolCallIds: readonly string[]; readonly message: string }
    | undefined;
  /** Typed infrastructure failure for this ACP round; closeRound returns it as knownFailure (#593). */
  let infrastructureRoundFailure: RoleTurnKnownFailure | undefined;
  const hostAbort = new AbortController();
  const runId = request.runDirectory.split("/").filter(Boolean).at(-1) ?? randomUUID();
  await mkdir(request.runDirectory, { recursive: true });

  // Canonical Skill expansion consumes RoleTurnRequest.methods (typed true source).
  for (const method of request.methods) {
    if (method.kind !== "skill") continue;
    const name = basename(dirname(method.path));
    const raw = await readFile(method.path, "utf8");
    methodSkills.set(name, { path: method.path, body: stripSkillFrontmatter(raw).trim() });
  }

  // Durable principal file for isAvailable / resumable settlement (public-cli).
  // #617 DK-4: header layout only — never host conversation/tool writeback into Pi JSONL.
  let sessionFile = options.sessionFile ?? join(request.runDirectory, "session", "session.jsonl");
  await mkdir(dirname(sessionFile), { recursive: true });
  if (request.continuation.kind !== "resume") {
    try {
      await writeFile(
        sessionFile,
        `${JSON.stringify({
          type: "session",
          version: 3,
          id: runId,
          timestamp: new Date().toISOString(),
          cwd: request.cwd,
        })}\n`,
        { encoding: "utf8", flag: "wx" },
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  const context: HostContext = {
    cwd: request.cwd,
    mode: "print",
    model: request.model === undefined ? undefined : { provider: request.model.provider },
    sessionManager: {
      getLeafEntry: () => sessionEntries.at(-1) as ReturnType<HostContext["sessionManager"]["getLeafEntry"]>,
      getLeafId: () => runId,
      getEntries: () => sessionEntries as ReturnType<HostContext["sessionManager"]["getEntries"]>,
      getSessionDir: () => dirname(sessionFile),
      getSessionFile: () => sessionFile,
      getHeader: () => ({ type: "session", id: runId }),
      setSessionFile(path) { sessionFile = path; },
      appendCustomEntry(customType, data) {
        const entry = { type: "custom", customType, data };
        sessionEntries.push(entry);
        customEntries.push({ customType, data });
      },
    },
    abort() {
      // Lawful abort (non-sole rejection / seal / audit-escalation in submission-ledger)
      // must not poison ACP retry prompts (#593 r1). hostAbort is armed only by typed
      // infra: rememberInfrastructureFailure and non-correctable MCP catch.
    },
  };
  const bookCustomMessage = (customType: string, message: { content?: string; details?: unknown }): void => {
    const payload = {
      ...(message.content === undefined ? {} : { content: message.content }),
      ...(message.details === undefined ? {} : { details: message.details }),
    };
    const entry = { type: "custom_message", customType, ...payload, message: payload };
    sessionEntries.push(entry);
    customEntries.push({ customType, data: message.details ?? message.content });
  };

  const emit = async (event: string, value: unknown): Promise<unknown[]> => {
    const results: unknown[] = [];
    for (const handler of handlers.get(event) ?? []) {
      results.push(await (handler as (value: unknown, context: HostContext) => unknown)(value, context));
    }
    return results;
  };

  const host: RoleHost = {
    deliverSubmissionRejection(value) {
      // Mechanical round rejection has no officer receipt; shared resume text is the fact (#813).
      rejection = {
        code: value.code,
        toolCallIds: value.toolCallIds,
        message: mechanicalSubmissionRejectionResumeMessage(value.code),
      };
    },
    capabilities: {
      skillExpansion(prompt): HostSkillExpansionEvidence | undefined {
        return buildSkillExpansion(methodSkills, prompt);
      },
    },
    registerFlag(name, definition) { if (!flags.has(name) && definition.default !== undefined) flags.set(name, definition.default); },
    getFlag(name) { return flags.get(name); },
    registerTool(tool) { tools.set(tool.name, tool); },
    // The real AK-owned surface only; the host builtin surface is host-side and
    // observable after session/new, never echoed back into role-requested names.
    getAllTools() { return [...tools.keys()].map((name) => ({ name })); },
    // The host receives tool choice as role guidance; every tool registered for the
    // seat remains reachable through MCP.
    setActiveTools(names) { preferredTools = [...names]; },
    getActiveTools() { return [...preferredTools]; },
    async requireGatekeeperPass(options) {
      await requireGatekeeperPass({
        context: options.context,
        subject: options.subject,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        hostActions: {
          failInfrastructure: (error, _context, toolCallId) =>
            options.hostActions.failInfrastructure(error, options.context, toolCallId),
          bindSubmissionNonPass: options.hostActions.bindSubmissionNonPass,
        },
        toolCallId: options.toolCallId,
      });
    },
    on(...registration: HostEventRegistration) {
      const [event, handler] = registration;
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
  };
  const envelope: RoleEnvelopeHost = {
    host,
    appendEntry(customType: string, data?: unknown) {
      context.sessionManager.appendCustomEntry?.(customType, data);
    },
    async sendMessage(message) {
      if (typeof message !== "object" || message === null) return;
      const customType = typeof message.customType === "string" ? message.customType : undefined;
      if (customType === undefined) return;
      bookCustomMessage(customType, {
        ...(typeof message.content === "string" ? { content: message.content } : {}),
        ...(message.details === undefined ? {} : { details: message.details }),
      });
    },
    startKeepalive() {},
    stopKeepalive() {},
  };
  createRoleRuntimeExtension(options.dependencies)(envelope);

  const token = randomUUID();
  const server = createServer((socket) => serveSocket(socket));
  /** Correctable non-pass must arm the existing rejection state so closeRound returns retry. */
  function rememberProjectedRejection(
    details: unknown,
    toolCallId: string,
    content: ContentPart[],
  ): void {
    if (typeof details !== "object" || details === null) return;
    const record = details as Record<string, unknown>;
    if (record.cause === "infrastructure") return;
    if (record.kind === "role_infrastructure_failure") return;
    const code = typeof record.code === "string" && record.code.length > 0
      ? record.code
      : record.status === "bounce" || record.status === "escalate" || record.status === "no_receipt"
        ? record.status
        : undefined;
    if (code === undefined) return;
    // Officer bounce/escalate text is already the tool_result content (GatekeeperDecisionError
    // message = raw receipt). Adapters resume with this message — never a host-invented line (#813).
    rejection = {
      code,
      toolCallIds: [toolCallId],
      message: textDiagnostic(content) ?? code,
    };
  }
  function textDiagnostic(content: ContentPart[]): string | undefined {
    // Keep concatenated text bytes intact for resume relay (#813 online P2):
    // only emptiness uses the trimmed form; do not alter Markdown/spacing.
    const text = content
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("");
    return text.trim().length > 0 ? text : undefined;
  }
  /** Arm closeRound + abort path with the durable infrastructure failure for this round. */
  function rememberInfrastructureFailure(
    details: unknown,
    content: ContentPart[],
  ): void {
    if (infrastructureRoundFailure !== undefined) return;
    const record = typeof details === "object" && details !== null && !Array.isArray(details)
      ? details as Record<string, unknown>
      : undefined;
    const isInfra = record !== undefined && (
      record.cause === "infrastructure"
      || record.kind === "role_infrastructure_failure"
    );
    if (!isInfra) return;
    const diagnostic = textDiagnostic(content)
      ?? (typeof record.code === "string" && record.code.length > 0 ? record.code : undefined)
      ?? "role infrastructure failure";
    // Slot first, then abort: host-aborted closeRound must observe the filled fact
    // even while tool_result projection is still in flight (#593 r3).
    infrastructureRoundFailure = {
      cause: "output",
      identity: {
        name: "InfrastructureFailure",
        code: typeof record.code === "string" && record.code.length > 0
          ? record.code
          : "role-infrastructure-failure",
      },
      diagnostic,
      details: record,
    };
    hostAbort.abort();
  }
  /**
   * One non-correctable infra pathway for execute throws and pre-execution emits:
   * build fact → fill closeRound slot → arm hostAbort. Projection may follow.
   */
  function declareRoundInfrastructureFailure(error: unknown): {
    content: ContentPart[];
    details: Record<string, unknown>;
  } {
    const diagnostic = error instanceof Error ? error.message : String(error);
    const content: ContentPart[] = [{ type: "text", text: diagnostic }];
    const errorCode = typeof (error as unknown as { code?: unknown })?.code === "string"
      ? (error as unknown as { code: string }).code
      : "ak-tool-execution-failed";
    const details: Record<string, unknown> = {
      ...buildNavigatorInfrastructureFailureFact(),
      ...extractInfrastructureFailureEvidence(error),
      cause: "infrastructure",
      code: errorCode,
    };
    rememberInfrastructureFailure(details, content);
    return { content, details };
  }
  async function projectToolResult(
    toolCallId: string,
    toolName: string,
    initial: {
      content: ContentPart[];
      details: unknown;
      isError: boolean;
    },
  ): Promise<typeof initial> {
    let projected = initial;
    for (const value of await emit("tool_result", { toolCallId, toolName, ...projected })) {
      if (typeof value !== "object" || value === null) continue;
      projected = {
        content: "content" in value && Array.isArray(value.content)
          ? value.content as typeof projected.content
          : projected.content,
        details: "details" in value ? value.details : projected.details,
        isError: "isError" in value && value.isError === true,
      };
    }
    // Record toolResult in memory for role turn lifecycle.
    const toolResultEntry = {
      type: "message",
      message: {
        role: "toolResult" as const,
        toolCallId,
        toolName,
        content: projected.content,
        details: projected.details,
        isError: projected.isError,
      },
    };
    sessionEntries.push(toolResultEntry);
    if (projected.isError) {
      rememberInfrastructureFailure(projected.details, projected.content);
      rememberProjectedRejection(projected.details, toolCallId, projected.content);
    }
    await emit("tool_execution_end", { toolCallId, toolName, isError: projected.isError });
    return projected;
  }
  /**
   * Shared terminating/support tool path for MCP relay and headless structured_output.
   * Books the call, runs execute, projects tool_result; does not emit turn_end (closeRound).
   */
  async function invokeAkTool(name: string, args: unknown): Promise<{
    content: ContentPart[];
    isError: boolean;
    blocked?: true;
  }> {
    const tool = tools.get(name);
    if (tool === undefined) throw new Error(`Unknown AK tool: ${name}`);
    const toolCallId = randomUUID();
    calls.push({ toolCallId, toolName: name });
    // First-record-then-audit: book the tool-call leaf in memory before execute so
    // judge/doctor subject gates see the candidate on parent session books.
    sessionEntries.push({
      type: "message",
      message: {
        role: "assistant" as const,
        content: [{
          type: "toolCall",
          id: toolCallId,
          name,
          arguments: args ?? {},
        }],
      },
    });
    try {
      await emit("tool_execution_start", { toolCallId, toolName: name });
      const blocked = (await emit("tool_call", { toolCallId, toolName: name, input: (args ?? {}) as Record<string, unknown> }))
        .some((value) => typeof value === "object" && value !== null && "block" in value && value.block === true);
      if (blocked) {
        // Lawful seatbelt/block stays bare rejection — not infrastructure (#593 r3).
        return { content: [{ type: "text", text: `AK tool blocked: ${name}` }], isError: true, blocked: true };
      }
    } catch (error) {
      // Pre-execution emit failure shares the non-correctable infra pathway (#593 r3).
      const declared = declareRoundInfrastructureFailure(error);
      try {
        const projected = await projectToolResult(toolCallId, name, {
          content: declared.content,
          details: declared.details,
          isError: true,
        });
        return { content: projected.content, isError: true };
      } catch {
        return { content: declared.content, isError: true };
      }
    }
    try {
      const result = await tool.execute(toolCallId, (args ?? {}) as never, undefined, undefined, context);
      const projected = await projectToolResult(toolCallId, name, {
        content: result.content,
        details: result.details,
        isError: false,
      });
      // Candidate only: seal waits for closeRound after the host round boundary.
      return { content: projected.content, isError: projected.isError };
    } catch (error) {
      let content: ContentPart[];
      let details: Record<string, unknown>;
      if (isCorrectableExecuteError(error)) {
        const projected = projectCorrectableExecuteRejection(error);
        content = [{ type: "text", text: projected.diagnostic }];
        details = projected.details;
      } else {
        // Slot-before-abort; projectToolResult may still project durable details.
        ({ content, details } = declareRoundInfrastructureFailure(error));
      }
      // The shared envelope's tool_result handler is the sole classifier:
      // it projects either the structured submission non-pass (correctable
      // rejection) or the typed infrastructure fact onto the reply.
      const projected = await projectToolResult(toolCallId, name, {
        content,
        details,
        isError: true,
      });
      return { content: projected.content, isError: projected.isError };
    }
  }

  function reply(socket: Socket, id: number, result?: unknown, error?: unknown): void {
    const rpcError = error instanceof Error
      ? { code: "ak-relay-failure", name: error.name, message: error.message }
      : { code: "ak-relay-failure", name: "RelayFailure", message: String(error) };
    socket.write(`${JSON.stringify({ id, ...(error === undefined ? { result } : { error: rpcError }) })}\n`);
  }
  function serveSocket(socket: Socket): void {
    let buffer = "";
    socket.setEncoding("utf8").on("data", (chunk) => {
      buffer += chunk;
      for (;;) {
        const end = buffer.indexOf("\n");
        if (end < 0) break;
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        void (async () => {
          let rpc: RpcRequest;
          try { rpc = JSON.parse(line) as RpcRequest; }
          catch (error) { reply(socket, -1, undefined, error); return; }
          if (rpc.token !== token) { reply(socket, rpc.id, undefined, "unauthorized relay"); return; }
          try {
            if (rpc.method === "tools/list") {
              const listed = [...tools.values()].filter((tool) =>
                listTerminatingToolOnMcp || tool.name !== earlyTerminatingTool);
              reply(socket, rpc.id, { tools: listed.map((tool) => {
                return { name: tool.name, description: tool.description, inputSchema: tool.parameters };
              }) });
              return;
            }
            if (rpc.method !== "tools/call") throw new Error(`Unsupported relay method: ${rpc.method}`);
            const params = rpc.params as ToolCallParams | undefined;
            const name = params?.name;
            if (typeof name !== "string") throw new Error("MCP tool name is missing");
            // Headless schema channel owns the terminating receipt — refuse MCP
            // terminating calls so an empty probe cannot book a non-sealable candidate.
            if (!listTerminatingToolOnMcp && name === earlyTerminatingTool) {
              throw new Error(`terminating tool ${name} is schema-channel only on this host`);
            }
            const outcome = await invokeAkTool(name, params?.arguments ?? {});
            if (outcome.blocked === true) {
              reply(socket, rpc.id, undefined, new Error(outcome.content.map((p) => p.type === "text" ? p.text : "").join("")));
              return;
            }
            reply(socket, rpc.id, { content: outcome.content, ...(outcome.isError ? { isError: true } : {}) });
          } catch (error) { reply(socket, rpc.id, undefined, error); }
        })();
      }
    });
  }
  const relay = fileURLToPath(new URL("./mcp-relay.mjs", import.meta.url));
  await listen(server, options.socketPath);
  let disposed = false;
  // Tools execute in this process (relay is protocol-only). Mirror Pi's child-env
  // AK_ROLE_RUN_DIR / AK_ROLE_COURT_ATTEMPT injection onto the parent so ledger
  // identity sees the same signals. Engine axis is request-scoped via RoleHost
  // flag — never process.env (#818 P1). Run-dir may wait
  // until prepare succeeds. Dispose restores including unset.
  let priorAkRoleRunDir: string | undefined;
  let priorAkRoleCourtAttempt: string | undefined;
  let runDirInjected = false;
  const restoreAkRoleRunEnv = (): void => {
    if (!runDirInjected) return;
    runDirInjected = false;
    if (priorAkRoleRunDir === undefined) delete process.env.AK_ROLE_RUN_DIR;
    else process.env.AK_ROLE_RUN_DIR = priorAkRoleRunDir;
    if (priorAkRoleCourtAttempt === undefined) delete process.env.AK_ROLE_COURT_ATTEMPT;
    else process.env.AK_ROLE_COURT_ATTEMPT = priorAkRoleCourtAttempt;
  };
  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    const cleanupFailures: unknown[] = [];
    try {
      await emit("session_shutdown", {});
    } catch (error) {
      cleanupFailures.push(error);
    }
    try {
      restoreAkRoleRunEnv();
    } catch (error) {
      cleanupFailures.push(error);
    }
    try {
      const closeAll = (server as unknown as { closeAllConnections?: () => void }).closeAllConnections;
      if (typeof closeAll === "function") closeAll.call(server);
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    } catch (error) {
      cleanupFailures.push(error);
    }
    if (cleanupFailures.length === 1) throw cleanupFailures[0];
    if (cleanupFailures.length > 1) {
      throw new AggregateError(cleanupFailures, "ACP envelope dispose cleanup failures", {
        cause: cleanupFailures[0],
      });
    }
  };

  const terminatingToolName: string = earlyTerminatingTool;
  async function ingestStructuredOutput(params: unknown): Promise<void> {
    // MCP path may already have invoked the terminating tool this round; skip the
    // duplicate so structured_output + tool-call does not arm non-sole.
    if (calls.some((call) => call.toolName === terminatingToolName)) return;
    await invokeAkTool(terminatingToolName, params ?? {});
  }

  const closeRound: PreparedRoleTurn["closeRound"] = async () => {
    // Typed round boundary: hand the complete call list to the shared ledger once.
    if (calls.length > 0) {
      const roundCalls = [...calls];
      calls.length = 0;
      await emit("turn_end", { turnIndex: 0, calls: roundCalls });
    }
    // Infrastructure failure outranks accepted closure / correctable retry (#593).
    if (infrastructureRoundFailure !== undefined) {
      return { accepted: false as const, failure: infrastructureRoundFailure };
    }
    let closure: { customType: string; data: unknown } | undefined;
    for (let index = customEntries.length - 1; index >= 0; index -= 1) {
      if (customEntries[index]?.customType === "ak-role-submission-closure") { closure = customEntries[index]; break; }
    }
    if (closure !== undefined) {
      // Pi flushes navigator attendance on agent_settled; session/prompt
      // resolution is the ACP host equivalent round boundary.
      await emit("agent_settled", {});
      return { accepted: true as const };
    }
    if (rejection !== undefined) {
      const retry = {
        code: rejection.code,
        toolCallIds: rejection.toolCallIds,
        message: rejection.message,
      };
      rejection = undefined;
      return { accepted: false as const, retry };
    }
    // #836: host ended without a recorded submission is not a failure.
    // Settlement presents ledger contents; empty ledger → no_receipt.
    await emit("agent_settled", {});
    return { accepted: true as const };
  };

  // Shared envelope activation. systemPrompt must be ready before session/new
  // (delivered via _meta.systemPromptOverride where the host honors it), so
  // activation runs during prepare. Engine axis already on RoleHost flags
  // (request-scoped); registerEngineDetourTool resolves via resolveEngineName.
  try {
    await emit("session_start", { reason: request.continuation.kind });
    const inputResults = await emit("input", { text: request.continuation.prompt, source: "interactive" });
    let prompt = request.continuation.prompt;
    for (const value of inputResults) {
      if (typeof value !== "object" || value === null) continue;
      const record = value as Record<string, unknown>;
      if (record.action === "transform" && typeof record.text === "string") prompt = record.text;
    }
    // Book the user assignment so judge audit subjects recover it from parent books.
    if (typeof prompt === "string" && prompt.trim() !== "") {
      sessionEntries.push({
        type: "message",
        message: { role: "user", content: prompt },
      });
    }
    // Method notes only here — role before_agent_start injects soul once.
    // Preloading session materials duplicated soul under the role tag (#632).
    const methodPrompt = (await Promise.all(request.methods.map(({ path }) => readFile(path, "utf8")))).join("\n\n");
    const promptResults = await emit("before_agent_start", {
      prompt,
      systemPrompt: methodPrompt,
      systemPromptOptions: {},
    });
    const systemPromptBody = [...promptResults].reverse().find((value): value is { systemPrompt: string } =>
      typeof value === "object" && value !== null && "systemPrompt" in value && typeof value.systemPrompt === "string")?.systemPrompt
      ?? methodPrompt;
    // Typed reading materials from agent-start handlers (machine face; independent of prompt bytes).
    // Folded into the provider-visible systemPrompt by the adapter at the send boundary.
    const readingMaterials: unknown[] = [];
    for (const value of promptResults) {
      if (typeof value !== "object" || value === null) continue;
      if (!("readingMaterial" in value)) continue;
      const material = (value as { readingMaterial?: unknown }).readingMaterial;
      if (material !== undefined) readingMaterials.push(material);
    }

    priorAkRoleRunDir = process.env.AK_ROLE_RUN_DIR;
    priorAkRoleCourtAttempt = process.env.AK_ROLE_COURT_ATTEMPT;
    process.env.AK_ROLE_RUN_DIR = request.runDirectory;
    if (request.courtAttemptId === undefined) delete process.env.AK_ROLE_COURT_ATTEMPT;
    else process.env.AK_ROLE_COURT_ATTEMPT = request.courtAttemptId;
    runDirInjected = true;

    const terminating = tools.get(terminatingToolName);
    if (terminating === undefined) {
      throw new Error(`terminating tool not registered after activation: ${terminatingToolName}`);
    }
    const jsonSchema = terminatingToolJsonSchema(terminating.parameters);
    return {
      mcpServers: [{
        name: `ak-${request.activation.role}`,
        command: process.execPath,
        args: [relay],
        env: [
          { name: "AK_ACP_MCP_SOCKET", value: options.socketPath },
          { name: "AK_ACP_MCP_TOKEN", value: token },
        ],
      }],
      systemPrompt: { body: systemPromptBody, materials: readingMaterials },
      prompt,
      abortSignal: hostAbort.signal,
      closeRound,
      dispose,
      jsonSchema,
      terminatingToolName,
      ingestStructuredOutput,
    };
  } catch (error) {
    // listen already succeeded; dispose is not yet caller-owned. Release the
    // unix listener before surfacing the activation/prepare failure. Keep both
    // causes when dispose also fails (failure-honesty; do not erase cleanup).
    try {
      await dispose();
    } catch (cleanupFailure) {
      throw new AggregateError(
        [error, cleanupFailure],
        "prepareRoleEnvelope activation failed and its dispose cleanup also failed",
        { cause: error },
      );
    }
    throw error;
  }
}
