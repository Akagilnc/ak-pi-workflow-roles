import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import type {
  HostContext,
  HostEventRegistration,
  HostToolDefinition,
  RoleHost,
  RoleTurnKnownFailure,
  RoleTurnRequest,
} from "../host-contracts.ts";
import { packagedRoleInputFlag, packagedRolePhaseFlag } from "../packaged-role-registry.ts";
import {
  configureRoleRuntimeEnvelope,
  type RoleRuntimeDependencies,
  type RoleRuntimeEnvelope,
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
  let preferredTools: string[] = [];
  let rejection: { readonly code: string; readonly toolCallIds: readonly string[] } | undefined;
  const runId = request.runDirectory.split("/").filter(Boolean).at(-1) ?? randomUUID();
  await mkdir(request.runDirectory, { recursive: true });
  let sessionFile = join(request.runDirectory, "grok-envelope.jsonl");
  const context: HostContext = {
    cwd: request.cwd,
    mode: "print",
    model: request.model === undefined ? undefined : { provider: request.model.provider },
    sessionManager: {
      getLeafEntry: () => undefined,
      getLeafId: () => runId,
      getEntries: () => [],
      getSessionDir: () => request.runDirectory,
      getSessionFile: () => sessionFile,
      getHeader: () => ({ type: "session", id: runId }),
      setSessionFile(path) { sessionFile = path; },
      appendCustomEntry(customType, data) { customEntries.push({ customType, data }); },
    },
    abort() {},
  };
  const host: RoleHost = {
    deliverSubmissionRejection(value) { rejection = value; },
    registerFlag(name, definition) { if (!flags.has(name) && definition.default !== undefined) flags.set(name, definition.default); },
    getFlag(name) { return flags.get(name); },
    registerTool(tool) { tools.set(tool.name, tool); },
    getAllTools() { return [...tools.keys()].map((name) => ({ name })); },
    // Grok receives tool choice as role guidance; every tool registered for the
    // seat remains reachable through MCP.
    setActiveTools(names) { preferredTools = [...names]; },
    getActiveTools() { return [...preferredTools]; },
    on(...registration: HostEventRegistration) {
      const [event, handler] = registration;
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
  };
  const envelope: RoleRuntimeEnvelope = {
    appendEntry(customType: string, data?: unknown) { customEntries.push({ customType, data }); },
    async sendMessage(message) {
      if (typeof message === "object" && message !== null && "content" in message && typeof message.content === "string") {
        customEntries.push({ customType: "message", data: message.content });
      }
    },
  } as RoleRuntimeEnvelope;
  configureRoleRuntimeEnvelope(options.dependencies, host, envelope);

  const emit = async (event: string, value: unknown): Promise<unknown[]> => {
    const results: unknown[] = [];
    for (const handler of handlers.get(event) ?? []) {
      results.push(await (handler as (value: unknown, context: HostContext) => unknown)(value, context));
    }
    return results;
  };
  await emit("session_start", { reason: request.continuation.kind });
  await emit("input", { text: request.continuation.prompt, source: "interactive" });
  const basePrompt = await loadMainRoleSessionMaterials(request.activation.role);
  const methodPrompt = (await Promise.all(request.methods.map(({ path }) => readFile(path, "utf8")))).join("\n\n");
  const promptResults = await emit("before_agent_start", {
    prompt: request.continuation.prompt,
    systemPrompt: [basePrompt, methodPrompt].filter(Boolean).join("\n\n"),
    systemPromptOptions: {},
  });
  const systemPrompt = [...promptResults].reverse().find((value): value is { systemPrompt: string } =>
    typeof value === "object" && value !== null && "systemPrompt" in value && typeof value.systemPrompt === "string")?.systemPrompt
    ?? [basePrompt, methodPrompt].filter(Boolean).join("\n\n");

  const token = randomUUID();
  const server = createServer((socket) => serveSocket(socket));
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
            await emit("tool_execution_start", { toolCallId, toolName: name });
            const blocked = (await emit("tool_call", { toolCallId, toolName: name, input: params?.arguments ?? {} }))
              .some((value) => typeof value === "object" && value !== null && "block" in value && value.block === true);
            if (blocked) throw new Error(`AK tool blocked: ${name}`);
            try {
              const result = await tool.execute(toolCallId, (params?.arguments ?? {}) as never, undefined, undefined, context);
              let projected = { content: result.content, details: result.details, isError: false };
              for (const value of await emit("tool_result", { toolCallId, toolName: name, ...projected })) {
                if (typeof value !== "object" || value === null) continue;
                projected = {
                  content: "content" in value && Array.isArray(value.content) ? value.content as typeof projected.content : projected.content,
                  details: "details" in value ? value.details : projected.details,
                  isError: "isError" in value && value.isError === true,
                };
              }
              await emit("tool_execution_end", { toolCallId, toolName: name, isError: projected.isError });
              reply(socket, rpc.id, { content: projected.content, structuredContent: projected.details, ...(projected.isError ? { isError: true } : {}) });
            } catch (error) {
              const details = rejection === undefined
                ? { cause: "infrastructure", code: "ak-tool-execution-failed" }
                : { cause: "rejection", code: rejection.code, toolCallIds: rejection.toolCallIds };
              const projected = {
                content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
                details,
                isError: true,
              };
              await emit("tool_result", { toolCallId, toolName: name, ...projected });
              await emit("tool_execution_end", { toolCallId, toolName: name, isError: true });
              reply(socket, rpc.id, { content: projected.content, structuredContent: details, isError: true });
            }
          } catch (error) { reply(socket, rpc.id, undefined, error); }
        })();
      }
    });
  }
  await listen(server, options.socketPath);
  const relay = fileURLToPath(new URL("./mcp-relay.mjs", import.meta.url));
  let disposed = false;
  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    await emit("session_shutdown", {});
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
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
    systemPrompt,
    async closeRound() {
      await emit("turn_end", { turnIndex: 0, calls: [...calls] });
      let closure: { customType: string; data: unknown } | undefined;
      for (let index = customEntries.length - 1; index >= 0; index -= 1) {
        if (customEntries[index]?.customType === "ak-role-submission-closure") { closure = customEntries[index]; break; }
      }
      calls.length = 0;
      if (closure !== undefined) return { accepted: true as const };
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
    },
    dispose,
  };
}
