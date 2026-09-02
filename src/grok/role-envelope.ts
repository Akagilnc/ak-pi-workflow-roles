import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { appendFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { requireGatekeeperPass } from "../gatekeeper-role.ts";
import type {
  HostContext,
  HostEventRegistration,
  HostSkillExpansionEvidence,
  HostToolDefinition,
  RoleEnvelopeHost,
  RoleHost,
  RoleTurnKnownFailure,
  RoleTurnRequest,
} from "../host-contracts.ts";
import { packagedRoleInputFlag, packagedRolePhaseFlag } from "../packaged-role-registry.ts";
import { stripSkillFrontmatter } from "../package-resources/method-skill.ts";
import {
  createRoleRuntimeExtension,
  type RoleRuntimeDependencies,
} from "../role-runtime.ts";
import { loadMainRoleSessionMaterials } from "../session-opening-materials.ts";
import {
  createGrokRoleTurnHost,
  type GrokPreparedTurn,
  type GrokRoleTurnHostConfig,
} from "./role-turn-host.ts";

type Handler = HostEventRegistration[1];
type RpcRequest = { readonly id: number; readonly token: string; readonly method: string; readonly params?: Record<string, unknown> };
type ToolCallParams = { readonly name?: unknown; readonly arguments?: unknown };

/** Parse the canonical Skill invocation produced by the shared input transform. */
export function parseCanonicalSkillInvocation(prompt: string): { readonly name: string; readonly userMessage: string } | undefined {
  const match = /^\/skill:([A-Za-z0-9_-]+)(?:\s+([\s\S]*))?$/s.exec(prompt.trim());
  if (match === null) return undefined;
  return { name: match[1]!, userMessage: (match[2] ?? "").trim() };
}

/** Build host-side Skill expansion evidence from pre-read RoleTurnRequest.methods. */
export function buildGrokSkillExpansion(
  methodSkills: ReadonlyMap<string, { readonly path: string; readonly body: string }>,
  prompt: string,
): HostSkillExpansionEvidence | undefined {
  const parsed = parseCanonicalSkillInvocation(prompt);
  if (parsed === undefined) return undefined;
  const method = methodSkills.get(parsed.name);
  if (method === undefined) return undefined;
  return Object.freeze({
    name: parsed.name,
    location: method.path,
    content: `References are relative to ${dirname(method.path)}.\n\n${method.body}`,
    userMessage: parsed.userMessage,
  });
}

export function projectGrokActivationFlags(request: RoleTurnRequest): Map<string, boolean | string> {
  const activation = request.activation;
  const flags = new Map<string, boolean | string>([["ak-role", activation.role]]);
  const inputFlag = packagedRoleInputFlag(activation.role);
  const phaseFlag = packagedRolePhaseFlag(activation.role);
  if ("phase" in activation && phaseFlag !== undefined) flags.set(phaseFlag, activation.phase);
  if (inputFlag !== undefined) {
    const path = "taskPath" in activation ? activation.taskPath
      : "packetPath" in activation ? activation.packetPath
        : "casePath" in activation ? activation.casePath
          : "inputPath" in activation ? activation.inputPath
            : "sourceRun" in activation ? activation.sourceRun : undefined;
    if (path !== undefined) flags.set(inputFlag, path);
  }
  if (activation.role === "fixer" && activation.prerequisitesPath !== undefined) flags.set("ak-fixer-prerequisites", activation.prerequisitesPath);
  if (activation.role === "reviewer") {
    flags.set("ak-review-base", activation.baseRevision);
    flags.set("ak-review-authority-refs", JSON.stringify(activation.authorityRefs));
    if (activation.ticketNumber !== undefined) flags.set("ak-review-ticket-number", String(activation.ticketNumber));
  }
  if (activation.role === "countersign" && activation.ticketNumber !== undefined) {
    flags.set("ak-countersign-ticket-number", String(activation.ticketNumber));
  }
  if (activation.role === "notary" && activation.ticketNumber !== undefined) {
    flags.set("ak-notary-ticket-number", String(activation.ticketNumber));
  }
  if (activation.role === "gleaner-left") {
    flags.set("ak-gleaner-left-base", activation.baseRevision);
  }
  if (activation.role === "collector") {
    flags.set("ak-collector-repo", activation.repo);
    flags.set("ak-collector-pr", activation.pr);
    if (activation.requestManifestPath !== undefined) flags.set("ak-collector-request-manifest", activation.requestManifestPath);
  }
  return flags;
}

async function listen(server: Server, path: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => { server.off("error", reject); resolve(); });
  });
}

/**
 * Build one AK-owned MCP projection from the shared eight-seat envelope.
 * The child process is a protocol relay only; all tools execute in this process.
 */
export function createComposedGrokRoleTurnHost(
  config: Omit<GrokRoleTurnHostConfig, "prepare"> & {
    readonly roleRuntimeDependencies: RoleRuntimeDependencies;
    readonly socketPath?: (request: RoleTurnRequest) => string;
  },
) {
  return createGrokRoleTurnHost({
    ...config,
    prepare: (request) => prepareGrokRoleEnvelope({
      request,
      dependencies: config.roleRuntimeDependencies,
      socketPath: config.socketPath?.(request) ?? `/tmp/ak-grok-mcp-${randomUUID()}.sock`,
    }),
  });
}

export async function prepareGrokRoleEnvelope(options: {
  readonly request: RoleTurnRequest;
  readonly dependencies: RoleRuntimeDependencies;
  readonly socketPath: string;
}): Promise<GrokPreparedTurn> {
  const { request } = options;
  const flags = projectGrokActivationFlags(request);
  const tools = new Map<string, HostToolDefinition>();
  const handlers = new Map<string, Handler[]>();
  const calls: Array<{ toolCallId: string; toolName: string }> = [];
  const customEntries: Array<{ customType: string; data: unknown }> = [];
  /** Truthful parent-session books for first-record-then-audit / navigator lifecycle (#590). */
  const sessionEntries: Array<Record<string, unknown>> = [];
  const methodSkills = new Map<string, { path: string; body: string }>();
  let preferredTools: string[] = [];
  let rejection: { readonly code: string; readonly toolCallIds: readonly string[] } | undefined;
  const runId = request.runDirectory.split("/").filter(Boolean).at(-1) ?? randomUUID();
  await mkdir(request.runDirectory, { recursive: true });

  // Canonical Skill expansion consumes RoleTurnRequest.methods (typed true source).
  for (const method of request.methods) {
    if (method.kind !== "skill") continue;
    const name = basename(dirname(method.path));
    const raw = await readFile(method.path, "utf8");
    methodSkills.set(name, { path: method.path, body: stripSkillFrontmatter(raw).trim() });
  }

  // Durable principal layout matches public-cli settlement (session/session.jsonl).
  // Create the header only when absent; resume must keep every prior byte and append.
  // Session JSONL is the sole durable books true source: hydrate in-memory entries
  // from existing bytes so shared lifecycle getEntries sees unfinished markers/history
  // (#590 grok-resume-session-hydration).
  let sessionFile = join(request.runDirectory, "session", "session.jsonl");
  await mkdir(dirname(sessionFile), { recursive: true });
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
    if ((error as { code?: unknown }).code !== "EEXIST") throw error;
  }
  {
    const raw = await readFile(sessionFile, "utf8");
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      const entry = JSON.parse(line) as Record<string, unknown>;
      // Header is owned by getHeader(); Pi getEntries excludes it.
      if (entry.type === "session") continue;
      sessionEntries.push(entry);
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
      getSessionDir: () => join(request.runDirectory, "session"),
      getSessionFile: () => sessionFile,
      getHeader: () => ({ type: "session", id: runId }),
      setSessionFile(path) { sessionFile = path; },
      appendCustomEntry(customType, data) {
        const entry = { type: "custom", customType, data };
        sessionEntries.push(entry);
        customEntries.push({ customType, data });
        // Same external face as Pi session custom entries (type/customType/data JSONL).
        appendFileSync(
          sessionFile,
          `${JSON.stringify(entry)}\n`,
          "utf8",
        );
      },
    },
    abort() {},
  };
  const bookCustomMessage = (customType: string, message: { content?: string; details?: unknown }): void => {
    const payload = {
      ...(message.content === undefined ? {} : { content: message.content }),
      ...(message.details === undefined ? {} : { details: message.details }),
    };
    const entry = { type: "custom_message", customType, ...payload, message: payload };
    sessionEntries.push(entry);
    customEntries.push({ customType, data: message.details ?? message.content });
    // Pi custom_message face: type/customType/message.details JSONL so
    // extractNavigatorFact can read grok-build parent-session books.
    appendFileSync(sessionFile, `${JSON.stringify(entry)}\n`, "utf8");
  };

  const emit = async (event: string, value: unknown): Promise<unknown[]> => {
    const results: unknown[] = [];
    for (const handler of handlers.get(event) ?? []) {
      results.push(await (handler as (value: unknown, context: HostContext) => unknown)(value, context));
    }
    return results;
  };

  const host: RoleHost = {
    deliverSubmissionRejection(value) { rejection = value; },
    capabilities: {
      skillExpansion(prompt): HostSkillExpansionEvidence | undefined {
        return buildGrokSkillExpansion(methodSkills, prompt);
      },
    },
    registerFlag(name, definition) { if (!flags.has(name) && definition.default !== undefined) flags.set(name, definition.default); },
    getFlag(name) { return flags.get(name); },
    registerTool(tool) { tools.set(tool.name, tool); },
    // The real AK-owned surface only; Grok's builtin surface is host-side and
    // observable after session/new, never echoed back into role-requested names.
    getAllTools() { return [...tools.keys()].map((name) => ({ name })); },
    // Grok receives tool choice as role guidance; every tool registered for the
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
  function rememberProjectedRejection(details: unknown, toolCallId: string): void {
    if (typeof details !== "object" || details === null) return;
    const record = details as Record<string, unknown>;
    if (record.cause === "infrastructure") return;
    const code = typeof record.code === "string" && record.code.length > 0
      ? record.code
      : record.status === "bounce" || record.status === "no_receipt"
        ? record.status
        : undefined;
    if (code === undefined) return;
    rejection = { code, toolCallIds: [toolCallId] };
  }
  async function projectToolResult(
    toolCallId: string,
    toolName: string,
    initial: {
      content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
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
    if (projected.isError) rememberProjectedRejection(projected.details, toolCallId);
    await emit("tool_execution_end", { toolCallId, toolName, isError: projected.isError });
    return projected;
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
              reply(socket, rpc.id, { tools: [...tools.values()].map((tool) => {
                return { name: tool.name, description: tool.description, inputSchema: tool.parameters };
              }) });
              return;
            }
            if (rpc.method !== "tools/call") throw new Error(`Unsupported relay method: ${rpc.method}`);
            const params = rpc.params as ToolCallParams | undefined;
            const name = params?.name;
            if (typeof name !== "string") throw new Error("MCP tool name is missing");
            const tool = tools.get(name);
            if (tool === undefined) throw new Error(`Unknown AK tool: ${name}`);
            const toolCallId = randomUUID();
            calls.push({ toolCallId, toolName: name });
            // First-record-then-audit: book the tool-call leaf before execute so
            // judge/doctor subject gates see the candidate on parent session books.
            sessionEntries.push({
              type: "message",
              message: {
                role: "assistant",
                content: [{
                  type: "toolCall",
                  id: toolCallId,
                  name,
                  arguments: params?.arguments ?? {},
                }],
              },
            });
            await emit("tool_execution_start", { toolCallId, toolName: name });
            const blocked = (await emit("tool_call", { toolCallId, toolName: name, input: params?.arguments ?? {} }))
              .some((value) => typeof value === "object" && value !== null && "block" in value && value.block === true);
            if (blocked) throw new Error(`AK tool blocked: ${name}`);
            try {
              const result = await tool.execute(toolCallId, (params?.arguments ?? {}) as never, undefined, undefined, context);
              const projected = await projectToolResult(toolCallId, name, {
                content: result.content,
                details: result.details,
                isError: false,
              });
              // Candidate only: do not emit turn_end here. Seal waits for the typed ACP
              // round boundary (closeRound after session/prompt), so delayed siblings stay
              // in the same round instead of becoming silent post-seal anomalies.
              reply(socket, rpc.id, { content: projected.content, structuredContent: projected.details, ...(projected.isError ? { isError: true } : {}) });
            } catch (error) {
              // The shared envelope's tool_result handler is the sole classifier:
              // it projects either the structured submission non-pass (correctable
              // rejection) or the typed infrastructure fact onto the reply.
              const projected = await projectToolResult(toolCallId, name, {
                content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
                details: { cause: "infrastructure" as const, code: "ak-tool-execution-failed" },
                isError: true,
              });
              reply(socket, rpc.id, { content: projected.content, structuredContent: projected.details, ...(projected.isError ? { isError: true } : {}) });
            }
          } catch (error) { reply(socket, rpc.id, undefined, error); }
        })();
      }
    });
  }
  await listen(server, options.socketPath);
  const relay = fileURLToPath(new URL("./mcp-relay.mjs", import.meta.url));
  let disposed = false;
  // Tools execute in this process (relay is protocol-only). Mirror Pi's child-env
  // AK_ROLE_RUN_DIR injection onto the parent so ledger runIdentity correlates
  // with settlement's bare admitted.runId via runIdFromRunDirectory. Inject only
  // after prepare succeeds (below); dispose must restore including unset.
  let priorAkRoleRunDir: string | undefined;
  let runDirInjected = false;
  const restoreAkRoleRunDir = (): void => {
    if (!runDirInjected) return;
    runDirInjected = false;
    if (priorAkRoleRunDir === undefined) delete process.env.AK_ROLE_RUN_DIR;
    else process.env.AK_ROLE_RUN_DIR = priorAkRoleRunDir;
  };
  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    try {
      await emit("session_shutdown", {});
      // Drop keep-alive / residual MCP relay sockets so test processes exit promptly.
      const closeAll = (server as unknown as { closeAllConnections?: () => void }).closeAllConnections;
      if (typeof closeAll === "function") closeAll.call(server);
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    } finally {
      restoreAkRoleRunDir();
    }
  };

  const closeRound: GrokPreparedTurn["closeRound"] = async () => {
    // Typed round boundary: hand the complete call list to the shared ledger once.
    if (calls.length > 0) {
      const roundCalls = [...calls];
      calls.length = 0;
      await emit("turn_end", { turnIndex: 0, calls: roundCalls });
    }
    let closure: { customType: string; data: unknown } | undefined;
    for (let index = customEntries.length - 1; index >= 0; index -= 1) {
      if (customEntries[index]?.customType === "ak-role-submission-closure") { closure = customEntries[index]; break; }
    }
    if (closure !== undefined) {
      // Pi flushes navigator attendance on agent_settled; session/prompt
      // resolution is grok-build's equivalent round boundary.
      await emit("agent_settled", {});
      return { accepted: true as const };
    }
    if (rejection !== undefined) {
      const retry = { code: rejection.code, toolCallIds: rejection.toolCallIds };
      rejection = undefined;
      return { accepted: false as const, retry };
    }
    const failure: RoleTurnKnownFailure = {
      cause: "output",
      identity: { name: "MissingSubmission", code: "round-ended-without-submission" },
    };
    return { accepted: false as const, failure };
  };

  // Shared envelope activation. systemPrompt must be ready before session/new
  // (ACP delivers it there), so activation runs during prepare.
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
  const basePrompt = await loadMainRoleSessionMaterials(request.activation.role);
  const methodPrompt = (await Promise.all(request.methods.map(({ path }) => readFile(path, "utf8")))).join("\n\n");
  const promptResults = await emit("before_agent_start", {
    prompt,
    systemPrompt: [basePrompt, methodPrompt].filter(Boolean).join("\n\n"),
    systemPromptOptions: {},
  });
  const systemPromptBody = [...promptResults].reverse().find((value): value is { systemPrompt: string } =>
    typeof value === "object" && value !== null && "systemPrompt" in value && typeof value.systemPrompt === "string")?.systemPrompt
    ?? [basePrompt, methodPrompt].filter(Boolean).join("\n\n");
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
  process.env.AK_ROLE_RUN_DIR = request.runDirectory;
  runDirInjected = true;

  return {
    mcpServers: [{
      name: `ak-${request.activation.role}`,
      command: process.execPath,
      args: [relay],
      env: [
        { name: "AK_GROK_MCP_SOCKET", value: options.socketPath },
        { name: "AK_GROK_MCP_TOKEN", value: token },
      ],
    }],
    systemPrompt: { body: systemPromptBody, materials: readingMaterials },
    prompt,
    closeRound,
    dispose,
  };
}
