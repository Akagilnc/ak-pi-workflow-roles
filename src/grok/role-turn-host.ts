import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { copyFile, lstat, mkdir, open, readFile, realpath, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative as pathRelative } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

import type { RoleTurnHost, RoleTurnKnownFailure, RoleTurnRequest, RoleTurnResult } from "../host-contracts.ts";
import { renderAgentStartMaterials } from "../agent-start-materials.ts";
import { installGrokPreToolUseDeny } from "./bash-seatbelt.ts";

/** ACP v1 surface used by the Grok adapter. Protocol details stay in this module. */
export interface GrokAcpConnection {
  request(method: string, params: Readonly<Record<string, unknown>>): Promise<Readonly<Record<string, unknown>>>;
  notify(method: string, params: Readonly<Record<string, unknown>>): void;
  /** Subscribe to agent→client notifications (session/update stream, etc.). */
  onNotification?(handler: (method: string, params: Readonly<Record<string, unknown>>) => void): void;
  close(): Promise<void>;
}

export type GrokControlledInspection = Readonly<{
  /** Active configuration whose source is neither Grok builtin nor AK injection. */
  privateActive: readonly string[];
  /** Active AK-owned configuration observed by the same first-party inspect call. */
  akActive: readonly string[];
}>;

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
  /**
   * Shared parent cursor for this turn's durable JSONL writes. prepare opens it
   * once; host user/assistant/builtin and envelope MCP appends must share it (#617).
   */
  sessionAppend?: GrokSessionAppendCursor;
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

/** Durable books session path (sole cross-host true source — #617 DK-1). */
export function grokSessionJsonlPath(runDirectory: string): string {
  return join(runDirectory, "session", "session.jsonl");
}

/**
 * Structured rebuild turns projected from session/session.jsonl (#617 DK-1).
 * Role conclusions live on toolCall.arguments and toolResult content/details —
 * text alone is lossy; Pi bash results often carry content with details absent.
 */
export type GrokRebuildTurn =
  | { readonly kind: "user"; readonly text: string }
  | { readonly kind: "assistant"; readonly text: string }
  | {
      readonly kind: "toolCall";
      readonly id: string;
      readonly name: string;
      readonly arguments: unknown;
    }
  | {
      readonly kind: "toolResult";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly content: unknown;
      readonly details: unknown;
      readonly isError: boolean;
    };

type ParsedSessionEntry = {
  readonly raw: Record<string, unknown>;
  readonly id: string | undefined;
  readonly parentId: string | null | undefined;
};

function parseSessionJsonlEntries(sessionJsonl: string): ParsedSessionEntry[] {
  const entries: ParsedSessionEntry[] = [];
  for (const line of sessionJsonl.split("\n")) {
    if (line.trim() === "") continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch (error) {
      throw Object.assign(
        new Error("session JSONL contains an unparseable non-empty line", { cause: error }),
        { code: "session-history-corrupt" as const },
      );
    }
    const id = typeof entry.id === "string" && entry.id.trim() !== "" ? entry.id : undefined;
    const parentId =
      entry.parentId === null || typeof entry.parentId === "string"
        ? (entry.parentId as string | null)
        : undefined;
    entries.push({ raw: entry, id, parentId });
  }
  return entries;
}

/**
 * Pi SessionManager leaf rule: last tree-linked entry in file order is current leaf.
 * Walk parentId ancestry root→leaf so abandoned forks never enter rebuild (#617).
 * Missing parent or cycle fails loud — never wash a broken chain into full-file order.
 */
export function selectActiveSessionBranchEntries(
  sessionJsonl: string,
): readonly Record<string, unknown>[] {
  const entries = parseSessionJsonlEntries(sessionJsonl);
  const byId = new Map<string, ParsedSessionEntry>();
  let leaf: ParsedSessionEntry | undefined;
  for (const entry of entries) {
    if (entry.raw.type === "session") continue;
    if (entry.id === undefined) continue;
    byId.set(entry.id, entry);
    leaf = entry;
  }
  if (leaf === undefined) {
    // No tree links (header-only / legacy unlinked lines): physical order is the only path.
    return entries.map((entry) => entry.raw);
  }
  const path: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  let current: ParsedSessionEntry | undefined = leaf;
  while (current !== undefined) {
    if (current.id !== undefined) {
      if (seen.has(current.id)) {
        throw Object.assign(
          new Error("session JSONL parent chain contains a cycle"),
          { code: "session-history-corrupt" as const },
        );
      }
      seen.add(current.id);
    }
    path.push(current.raw);
    if (current.parentId === null || current.parentId === undefined) break;
    const parent = byId.get(current.parentId);
    if (parent === undefined) {
      throw Object.assign(
        new Error("session JSONL parent chain references a missing entry"),
        { code: "session-history-corrupt" as const },
      );
    }
    current = parent;
  }
  path.reverse();
  return path;
}

/**
 * Authoritative session→rebuild projector. JSONL is the sole history authority:
 * active leaf ancestry only; user/assistant text plus toolCall.arguments and
 * toolResult content+details survive so cross-host resume keeps role conclusions.
 * Non-empty unparseable lines and broken parent chains fail loudly (#617).
 */
export function projectGrokRebuildHistory(sessionJsonl: string): readonly GrokRebuildTurn[] {
  const turns: GrokRebuildTurn[] = [];
  for (const entry of selectActiveSessionBranchEntries(sessionJsonl)) {
    if (entry.type !== "message" || typeof entry.message !== "object" || entry.message === null) {
      continue;
    }
    const message = entry.message as {
      role?: unknown;
      content?: unknown;
      toolCallId?: unknown;
      toolName?: unknown;
      details?: unknown;
      isError?: unknown;
    };
    if (message.role === "toolResult") {
      if (typeof message.toolCallId !== "string" || message.toolCallId.trim() === "") continue;
      const toolName =
        typeof message.toolName === "string" && message.toolName.trim() !== ""
          ? message.toolName
          : "unknown";
      turns.push({
        kind: "toolResult",
        toolCallId: message.toolCallId,
        toolName,
        content: message.content ?? null,
        details: message.details ?? null,
        isError: message.isError === true,
      });
      continue;
    }
    if (message.role === "user") {
      const text = extractMessageText(message.content);
      if (text !== undefined) turns.push({ kind: "user", text });
      continue;
    }
    if (message.role !== "assistant") continue;
    const text = extractMessageText(message.content);
    if (text !== undefined) turns.push({ kind: "assistant", text });
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (typeof part !== "object" || part === null) continue;
      const record = part as {
        type?: unknown;
        id?: unknown;
        name?: unknown;
        arguments?: unknown;
      };
      if (record.type !== "toolCall") continue;
      if (typeof record.id !== "string" || record.id.trim() === "") continue;
      if (typeof record.name !== "string" || record.name.trim() === "") continue;
      turns.push({
        kind: "toolCall",
        id: record.id,
        name: record.name,
        arguments: record.arguments ?? {},
      });
    }
  }
  return turns;
}

function extractMessageText(content: unknown): string | undefined {
  if (typeof content === "string") {
    const trimmed = content.trim();
    return trimmed === "" ? undefined : trimmed;
  }
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      parts.push(part);
      continue;
    }
    if (typeof part !== "object" || part === null) continue;
    const record = part as { type?: unknown; text?: unknown };
    if (record.type === "text" && typeof record.text === "string") parts.push(record.text);
  }
  const joined = parts.join("").trim();
  return joined === "" ? undefined : joined;
}

/** Keyed rebuild payload for ACP embeddedContext (no prose labels). */
export type GrokRebuildHistoryResource = {
  readonly version: 1;
  readonly turns: readonly GrokRebuildTurn[];
};

/** Build session/prompt content: continuation text + optional keyed JSONL history resource. */
export function buildGrokResumePromptContent(
  continuationPrompt: string,
  turns: readonly GrokRebuildTurn[],
): readonly Readonly<Record<string, unknown>>[] {
  const content: Array<Record<string, unknown>> = [
    { type: "text", text: continuationPrompt },
  ];
  if (turns.length > 0) {
    const resource: GrokRebuildHistoryResource = { version: 1, turns };
    content.push({
      type: "resource",
      resource: {
        uri: "context://ak-role/session-history",
        mimeType: "application/json",
        text: JSON.stringify(resource),
      },
    });
  }
  return content;
}

/**
 * Append one durable message entry. prepare owns session layout
 * (`session/session.jsonl`); write failures stay loud — never mint directories here.
 */
export function appendGrokSessionJsonlEntry(
  sessionFile: string,
  entry: Readonly<Record<string, unknown>>,
): void {
  appendFileSync(sessionFile, `${JSON.stringify(entry)}\n`, "utf8");
}

/**
 * Last non-session entry id in the JSONL tree — parent for the next Pi-shaped append.
 * Same leaf walk as settlement attempt-history / Pi custom append (#617 cross-host restore).
 * Read/parse failures stay loud — never wash missing or corrupt truth into parentId=null (#617).
 */
export function readLastSessionTreeEntryId(sessionFile: string): string | null {
  let parentId: string | null = null;
  const text = readFileSync(sessionFile, "utf8");
  for (const entry of parseSessionJsonlEntries(text)) {
    if (entry.id !== undefined && entry.raw.type !== "session") parentId = entry.id;
  }
  return parentId;
}

/**
 * One open-scan parent cursor for a turn. Host + envelope share this object so
 * user/assistant/MCP/builtin appends stay one tree without O(n²) full-file rereads (#617).
 */
export type GrokSessionAppendCursor = {
  readonly sessionFile: string;
  parentId: string | null;
  /** toolCallId and `result:${toolCallId}` keys already booked onto JSONL. */
  readonly recordedToolCallIds: Set<string>;
};

/** Scan session JSONL once; subsequent appends advance parentId in memory. */
export function openGrokSessionAppendCursor(sessionFile: string): GrokSessionAppendCursor {
  return {
    sessionFile,
    parentId: readLastSessionTreeEntryId(sessionFile),
    recordedToolCallIds: new Set(),
  };
}

/** Tree-linked envelope shared by every Grok→JSONL message write Pi can restore. */
function appendPiShapedSessionMessage(
  cursor: GrokSessionAppendCursor,
  message: Readonly<Record<string, unknown>>,
): void {
  const id = randomUUID();
  const timestamp = new Date().toISOString();
  appendGrokSessionJsonlEntry(cursor.sessionFile, {
    type: "message",
    id,
    parentId: cursor.parentId,
    timestamp,
    message,
  });
  cursor.parentId = id;
}

/**
 * Append one Pi-shaped user/assistant text entry to the durable session JSONL.
 * prepare owns layout creation (`session/session.jsonl`).
 * Must carry id/parentId so Pi `--session` restore walks the entry into LLM context.
 */
export function appendGrokSessionMessage(
  cursor: GrokSessionAppendCursor,
  role: "user" | "assistant",
  text: string,
): void {
  if (text.trim() === "") return;
  appendPiShapedSessionMessage(cursor, {
    role,
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  });
}

/** Append a Pi-shaped assistant toolCall leaf (tree-linked for Pi restore). */
export function appendGrokSessionToolCall(
  cursor: GrokSessionAppendCursor,
  toolCall: {
    readonly id: string;
    readonly name: string;
    readonly arguments?: unknown;
  },
): void {
  if (cursor.recordedToolCallIds.has(toolCall.id)) return;
  cursor.recordedToolCallIds.add(toolCall.id);
  appendPiShapedSessionMessage(cursor, {
    role: "assistant",
    content: [{
      type: "toolCall",
      id: toolCall.id,
      name: toolCall.name,
      arguments: toolCall.arguments ?? {},
    }],
  });
}

/** Append a Pi-shaped toolResult pair leaf so JSONL rebuild keeps role conclusions. */
export function appendGrokSessionToolResult(
  cursor: GrokSessionAppendCursor,
  toolResult: {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly content: unknown;
    readonly details: unknown;
    readonly isError: boolean;
  },
): void {
  const resultKey = `result:${toolResult.toolCallId}`;
  if (cursor.recordedToolCallIds.has(resultKey)) return;
  cursor.recordedToolCallIds.add(resultKey);
  appendPiShapedSessionMessage(cursor, {
    role: "toolResult",
    toolCallId: toolResult.toolCallId,
    toolName: toolResult.toolName,
    content: toolResult.content,
    details: toolResult.details,
    isError: toolResult.isError,
  });
}

export type GrokCapabilityDeclaration = Readonly<{
  nativeToolNarrowing: false;
  preToolUseDeny: boolean;
}>;

export type GrokSessionIdentityAuthority = Readonly<{
  load(principal: RoleTurnRequest["principal"]): Promise<string | undefined>;
  bind(principal: RoleTurnRequest["principal"], sessionId: string): Promise<void>;
  /** Durable JSONL coordinate from DurablePrincipalAuthority.decode — never runDirectory join (#617). */
  resolveSessionFile(principal: RoleTurnRequest["principal"]): string;
}>;

export type GrokRoleTurnHostConfig = Readonly<{
  sessionIdentity: GrokSessionIdentityAuthority;
  connect(request: RoleTurnRequest): Promise<GrokAcpConnection>;
  inspect(request: RoleTurnRequest): Promise<GrokControlledInspection>;
  prepare(request: RoleTurnRequest): Promise<GrokPreparedTurn>;
  recordCapabilities(request: RoleTurnRequest, declaration: GrokCapabilityDeclaration): void | Promise<void>;
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
        const inspected = await config.inspect(request);
        if (inspected.privateActive.length !== 0) {
          return failure("activation", "UncontrolledGrokSession", "private-config-active", {
            privateActive: [...inspected.privateActive],
          });
        }
        const continuation = request.continuation;
        // #617 DK-1: sole JSONL authority must be proven before prepare. Production
        // prepare owns layout creation and would mint an empty header on absence —
        // loading history first keeps resume from continuing on a blank rebuild.
        // Session path comes only from durable principal decode — never runDirectory join.
        const principalSessionFile = config.sessionIdentity.resolveSessionFile(request.principal);
        let rebuildTurns: readonly GrokRebuildTurn[] = [];
        if (continuation.kind === "resume") {
          let raw: string;
          try {
            raw = await readFile(principalSessionFile, "utf8");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
              return failure("session", "GrokSessionHistoryMissing", "session-history-missing");
            }
            throw error;
          }
          try {
            rebuildTurns = projectGrokRebuildHistory(raw);
          } catch (error) {
            const code =
              typeof error === "object"
              && error !== null
              && (error as { code?: unknown }).code === "session-history-corrupt"
                ? "session-history-corrupt"
                : "session-history-unreadable";
            return failure(
              "session",
              code === "session-history-corrupt"
                ? "GrokSessionHistoryCorrupt"
                : "GrokSessionHistoryUnreadable",
              code,
            );
          }
        }
        const prepared = await config.prepare(request);
        let connection: GrokAcpConnection | undefined;
        let sessionId: string | undefined;
        let accepted = false;
        try {
          // AK injection proof is prepared MCP composition (envelope), not inspect.akActive.
          // Inspect only classifies first-party already-active sources; external packageRoot
          // materials reach session/new via prepare, not via Grok-native inspect paths.
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
          const hookMeta = initialized._meta as { "x.ai/hooks"?: { blockingEvents?: unknown; decisions?: unknown } } | undefined;
          const hookCapability = hookMeta?.["x.ai/hooks"];
          const canDeny = Array.isArray(hookCapability?.blockingEvents)
            && hookCapability.blockingEvents.includes("pre_tool_use")
            && Array.isArray(hookCapability.decisions)
            && hookCapability.decisions.includes("deny");
          // ADR 0008: seatbelt hangs only on the activated Fixer. Capability alone
          // is not an installed belt, and review seats (ADR 0064) must stay unnarrowed.
          let preToolUseDeny = false;
          if (canDeny && request.activation.role === "fixer") {
            await installGrokPreToolUseDeny(request.home);
            preToolUseDeny = true;
          }
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
          // Every Grok resume rebuilds via session/new + JSONL embeddedContext — never
          // session/load from a possibly-stale ACP binding. Binding is rewritten to the
          // new ACP id after open; it is not a second true source.
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
          let prompt = prepared.prompt;
          const abortSignal = prepared.abortSignal;
          const activeConnection = connection;
          // Shared cursor: prepare opens once when it owns the file; otherwise open here.
          const sessionAppend =
            prepared.sessionAppend
            ?? openGrokSessionAppendCursor(principalSessionFile);
          // First resume prompt carries JSONL history; retry prompts stay bare.
          let deliverRebuildHistory = continuation.kind === "resume" && rebuildTurns.length > 0;
          // Accumulate assistant text from ACP session/update so JSONL stays the true source.
          let assistantChunks: string[] = [];
          // Builtin tool names seen on tool_call notifications (paired with tool_call_update).
          const builtinToolNames = new Map<string, string>();
          activeConnection.onNotification?.((method, params) => {
            if (method !== "session/update") return;
            const update = (params as { update?: unknown }).update;
            if (typeof update !== "object" || update === null) return;
            const record = update as {
              sessionUpdate?: unknown;
              content?: unknown;
              toolCallId?: unknown;
              title?: unknown;
              rawInput?: unknown;
              rawOutput?: unknown;
              status?: unknown;
              _meta?: unknown;
            };
            if (record.sessionUpdate === "agent_message_chunk") {
              const content = record.content;
              if (typeof content === "object" && content !== null) {
                const text = (content as { type?: unknown; text?: unknown }).text;
                if (typeof text === "string") assistantChunks.push(text);
              }
              return;
            }
            // Grok builtin tools arrive as ACP tool_call / tool_call_update, not MCP relay.
            // Persist the pair onto the sole JSONL and dedupe by toolCallId (#617).
            if (record.sessionUpdate === "tool_call") {
              if (typeof record.toolCallId !== "string" || record.toolCallId.trim() === "") return;
              const metaTool = (record._meta as { "x.ai/tool"?: { name?: unknown } } | undefined)?.["x.ai/tool"];
              const nameFromMeta =
                typeof metaTool?.name === "string" && metaTool.name.trim() !== ""
                  ? metaTool.name
                  : undefined;
              const nameFromTitle =
                typeof record.title === "string" && record.title.trim() !== ""
                  ? record.title
                  : undefined;
              const name = nameFromMeta ?? nameFromTitle;
              if (name === undefined) return;
              builtinToolNames.set(record.toolCallId, name);
              appendGrokSessionToolCall(sessionAppend, {
                id: record.toolCallId,
                name,
                arguments: record.rawInput ?? {},
              });
              return;
            }
            if (record.sessionUpdate === "tool_call_update") {
              if (typeof record.toolCallId !== "string" || record.toolCallId.trim() === "") return;
              if (record.status !== "completed" && record.status !== "failed") return;
              const toolName =
                builtinToolNames.get(record.toolCallId)
                ?? (typeof record.title === "string" && record.title.trim() !== ""
                  ? record.title
                  : "unknown");
              appendGrokSessionToolResult(sessionAppend, {
                toolCallId: record.toolCallId,
                toolName,
                content: record.content ?? null,
                details: record.rawOutput ?? null,
                isError: record.status === "failed",
              });
            }
          });
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
              const promptContent = deliverRebuildHistory
                ? buildGrokResumePromptContent(prompt, rebuildTurns)
                : [{ type: "text", text: prompt }];
              deliverRebuildHistory = false;
              // Book the user turn onto durable JSONL before ACP sees it.
              appendGrokSessionMessage(sessionAppend, "user", prompt);
              assistantChunks = [];
              result = await promptOrAbort({
                sessionId,
                prompt: promptContent,
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
            appendGrokSessionMessage(sessionAppend, "assistant", assistantChunks.join(""));
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

type InspectItem = {
  readonly name?: unknown;
  readonly path?: unknown;
  readonly disabled?: unknown;
  readonly enabled?: unknown;
  readonly compatibilityStatus?: unknown;
  readonly source?: { readonly type?: unknown; readonly path?: unknown };
};

export type GrokInspectionClassificationOptions = Readonly<{
  /**
   * Calling-repo projectInstructions whose path is carried by HEAD and whose
   * working-tree bytes match that blob (#521 repo-instructions-are-shared-material).
   * These are shared repo material — not privateActive, not AK package injection.
   */
  readonly headMatchedProjectInstructionPaths?: ReadonlySet<string>;
}>;

const execFileAsync = promisify(execFile);

function errnoCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

async function realpathIfPresent(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * Typed worktree readability: ENOENT → absent; permission and other IO stay loud.
 * Does not consult Git diagnostics.
 */
async function worktreeFilePresence(path: string): Promise<"absent" | "present"> {
  try {
    const handle = await open(path, "r");
    await handle.close();
    return "present";
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return "absent";
    throw error;
  }
}

/**
 * Map a worktree-relative path to the unique HEAD tree path it names.
 * Exact match first; otherwise a single case-insensitive hit in the same
 * directory (Grok may report `Claude.md` while HEAD stores `CLAUDE.md`).
 * Path identity keeps the inspect leaf name (final symlink not followed).
 * Git/IO failures propagate; only "not in HEAD" returns undefined.
 */
async function resolveHeadTreePath(topLevel: string, relativePath: string): Promise<string | undefined> {
  const { stdout: exactOut } = await execFileAsync(
    "git",
    ["ls-tree", "--name-only", "HEAD", "--", relativePath],
    { cwd: topLevel, encoding: "utf8" },
  );
  const exactHits = exactOut.split("\n").map((name) => name.trim()).filter((name) => name !== "");
  if (exactHits.includes(relativePath)) return relativePath;

  const parent = dirname(relativePath);
  const leaf = basename(relativePath);
  // Path absence is an empty structured ls-tree result (exit 0), never stderr prose.
  if (parent !== ".") {
    const { stdout: parentOut } = await execFileAsync(
      "git",
      ["ls-tree", "--name-only", "HEAD", "--", parent],
      { cwd: topLevel, encoding: "utf8" },
    );
    const parentHits = parentOut.split("\n").map((name) => name.trim()).filter((name) => name !== "");
    if (!parentHits.includes(parent)) return undefined;
  }

  // Parent confirmed present (or root): list children. Any failure stays loud infrastructure.
  const { stdout: listing } = parent === "."
    ? await execFileAsync("git", ["ls-tree", "--name-only", "HEAD"], {
      cwd: topLevel,
      encoding: "utf8",
    })
    : await execFileAsync("git", ["ls-tree", "--name-only", `HEAD:${parent}`], {
      cwd: topLevel,
      encoding: "utf8",
    });
  const needle = leaf.toLowerCase();
  const hits = listing
    .split("\n")
    .map((name) => name.trim())
    .filter((name) => name !== "" && basename(name).toLowerCase() === needle)
    .map((name) => (parent === "." ? basename(name) : join(parent, basename(name))));
  return hits.length === 1 ? hits[0] : undefined;
}

/**
 * True when inspect-reported path is carried by calling-repo HEAD and the bytes
 * a host reads through that path match the HEAD blob
 * (#521 repo-instructions-are-shared-material).
 *
 * Expected negatives (return false): empty/outside path, HEAD does not carry
 * the path, worktree absent, or worktree bytes ≠ HEAD blob.
 * Infrastructure (throw with cause): git unavailable, unexpected git/repo
 * failure, permission or other IO on realpath/hash.
 */
export async function isHeadMatchedProjectInstruction(
  repositoryCwd: string,
  absolutePath: string,
): Promise<boolean> {
  if (absolutePath === "" || absolutePath.includes("\0")) return false;

  const { stdout: topLevelOut } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
    cwd: repositoryCwd,
    encoding: "utf8",
  });
  // Prove HEAD is readable before path negatives — corrupt/missing HEAD stays loud.
  await execFileAsync("git", ["rev-parse", "--verify", "HEAD"], {
    cwd: repositoryCwd,
    encoding: "utf8",
  });
  const topLevel = await realpath(topLevelOut.trim());

  // Keep final leaf identity (do not realpath through a final-component symlink).
  const parent = await realpathIfPresent(dirname(absolutePath));
  if (parent === undefined) return false;
  const leaf = basename(absolutePath);
  if (leaf === "" || leaf === "." || leaf === "..") return false;
  const candidate = join(parent, leaf);
  const relative = pathRelative(topLevel, candidate);
  if (relative === "" || relative.startsWith("..") || isAbsolute(relative) || relative.includes("\0")) {
    return false;
  }

  const headRel = await resolveHeadTreePath(topLevel, relative);
  if (headRel === undefined) return false;
  const headFile = join(topLevel, headRel);

  const { stdout: headBlobOut } = await execFileAsync(
    "git",
    ["rev-parse", "--verify", `HEAD:${headRel}`],
    { cwd: topLevel, encoding: "utf8" },
  );
  const headBlob = headBlobOut.trim();

  // Prefer inspect-reported path bytes (hash-object follows symlink content).
  // Worktree absence is typed FS ENOENT; permission and other IO stay loud.
  // When exact casing is absent, fall back to the unique HEAD-cased path.
  let hashTarget = candidate;
  const candidatePresence = await worktreeFilePresence(candidate);
  if (candidatePresence === "absent") {
    if (candidate === headFile) return false;
    const headPresence = await worktreeFilePresence(headFile);
    if (headPresence === "absent") return false;
    hashTarget = headFile;
  }
  const { stdout } = await execFileAsync("git", ["hash-object", "--", hashTarget], {
    cwd: topLevel,
    encoding: "utf8",
  });
  return headBlob === stdout.trim();
}

function inspectItemPath(value: InspectItem): string {
  if (typeof value.source?.path === "string") return value.source.path;
  if (typeof value.path === "string") return value.path;
  return "";
}

function isInspectItemActive(value: InspectItem): boolean {
  return value.disabled !== true && value.enabled !== false && value.compatibilityStatus !== "disabled";
}

/** Collect active projectInstruction paths for HEAD-blob provenance resolution. */
export function listActiveProjectInstructionPaths(document: Readonly<Record<string, unknown>>): readonly string[] {
  const items = document.projectInstructions;
  if (!Array.isArray(items)) return [];
  const paths: string[] = [];
  for (const value of items as InspectItem[]) {
    if (!isInspectItemActive(value)) continue;
    const path = inspectItemPath(value);
    if (path !== "") paths.push(path);
  }
  return paths;
}

/** Classify first-party inspect JSON by provenance; wording and item counts are irrelevant. */
export function classifyGrokInspection(
  document: Readonly<Record<string, unknown>>,
  packageRoot: string,
  options: GrokInspectionClassificationOptions = {},
): GrokControlledInspection {
  const privateActive = new Set<string>();
  const akActive = new Set<string>();
  const headMatched = options.headMatchedProjectInstructionPaths ?? new Set<string>();
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
      if (!isInspectItemActive(value)) continue;
      const sourceType = value.source?.type;
      const path = inspectItemPath(value);
      const identity = `${section}:${typeof value.name === "string" ? value.name : path}`;
      if (sourceType === "builtin" || sourceType === "bundled") continue;
      if (path === packageRoot || path.startsWith(`${packageRoot}/`)) akActive.add(identity);
      else if (section === "projectInstructions" && headMatched.has(path)) continue;
      else privateActive.add(identity);
    }
  }
  return { privateActive: [...privateActive].sort(), akActive: [...akActive].sort() };
}

/** AK Fixer PreToolUse seatbelt files written under controlled GROK_HOME/hooks. */
export const AK_BASH_SEATBELT_HOOK_FILES = ["ak-bash-seatbelt.json", "ak-bash-seatbelt.mjs"] as const;

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

/** Refuse symlink roots so copy/rm never follow a redirected controlled home (#594 F4). */
export async function assertControlledGrokHomeIsRealDirectory(controlledHome: string): Promise<void> {
  let st;
  try {
    st = await lstat(controlledHome);
  } catch (error) {
    if (isMissingPathError(error)) return;
    throw error;
  }
  if (st.isSymbolicLink()) {
    throw new Error(`controlled grok home must not be a symlink: ${controlledHome}`);
  }
  if (!st.isDirectory()) {
    throw new Error(`controlled grok home must be a real directory: ${controlledHome}`);
  }
}

/** Refuse a symlink credential destination before copy or scrub (#594 F4). */
export async function assertControlledGrokAuthIsNotSymlink(authPath: string): Promise<void> {
  let st;
  try {
    st = await lstat(authPath);
  } catch (error) {
    if (isMissingPathError(error)) return;
    throw error;
  }
  if (st.isSymbolicLink()) {
    throw new Error(`controlled grok auth must not be a symlink: ${authPath}`);
  }
}

/** Remove AK seatbelt hook residue while leaving sessions/ intact (#594 F1). */
export async function scrubAkBashSeatbeltHooks(controlledHome: string): Promise<void> {
  const hooksDir = join(controlledHome, "hooks");
  for (const name of AK_BASH_SEATBELT_HOOK_FILES) {
    await rm(join(hooksDir, name), { force: true });
  }
}

/**
 * Copy only Grok's authentication authority into an otherwise isolated home.
 * Refuses symlink home/auth destinations (no follow). Scrubs crash-window residual
 * auth.json and AK seatbelt hooks before the copy so the next inspect cannot see
 * either residue (#594 F1/F3/F4).
 */
export async function prepareControlledGrokHome(sourceHome: string, controlledHome: string): Promise<void> {
  await assertControlledGrokHomeIsRealDirectory(controlledHome);
  await mkdir(controlledHome, { recursive: true, mode: 0o700 });
  await assertControlledGrokHomeIsRealDirectory(controlledHome);
  const authPath = join(controlledHome, "auth.json");
  await assertControlledGrokAuthIsNotSymlink(authPath);
  // Crash-window residue: prior auth.json may still sit in the retained ledger.
  await rm(authPath, { force: true });
  await scrubAkBashSeatbeltHooks(controlledHome);
  await copyFile(join(sourceHome, ".grok", "auth.json"), authPath);
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
  const record = document as Readonly<Record<string, unknown>>;
  const headMatchedProjectInstructionPaths = new Set<string>();
  for (const path of listActiveProjectInstructionPaths(record)) {
    if (path === options.packageRoot || path.startsWith(`${options.packageRoot}/`)) continue;
    if (await isHeadMatchedProjectInstruction(options.cwd, path)) {
      headMatchedProjectInstructionPaths.add(path);
    }
  }
  return classifyGrokInspection(record, options.packageRoot, { headMatchedProjectInstructionPaths });
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
