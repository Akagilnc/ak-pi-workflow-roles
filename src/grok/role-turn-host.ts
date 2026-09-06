import { execFile, spawn } from "node:child_process";
import { copyFile, lstat, mkdir, open, realpath, rm } from "node:fs/promises";
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

export type GrokCapabilityDeclaration = Readonly<{
  nativeToolNarrowing: false;
  preToolUseDeny: boolean;
}>;

export type GrokSessionIdentityAuthority = Readonly<{
  load(principal: RoleTurnRequest["principal"]): Promise<string | undefined>;
  bind(principal: RoleTurnRequest["principal"], sessionId: string): Promise<void>;
  /** Durable principal session path for layout ownership / isAvailable — not a rebuild source (#617 DK-4). */
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

          // #617 DK-7: hand Pi session path once; Grok reads the file itself.
          const priorNativePaths =
            continuation.kind === "resume"
            && request.hostTransition?.previousHost === "pi"
              ? request.hostTransition.priorNativePaths
              : undefined;
          if (continuation.kind === "resume") {
            const boundSessionId = await config.sessionIdentity.load(request.principal);
            if (boundSessionId !== undefined && boundSessionId !== "") {
              // Same-host Grok resume reuses native ACP session via session/load.
              const loaded = await connection.request("session/load", {
                sessionId: boundSessionId,
                cwd: request.cwd,
                mcpServers: prepared.mcpServers,
                _meta: { systemPromptOverride: renderGrokSystemPromptOverride(prepared.systemPrompt), yoloMode: false },
              });
              sessionId = typeof loaded.sessionId === "string" && loaded.sessionId !== ""
                ? loaded.sessionId
                : boundSessionId;
            } else {
              // Unbound resume (cross-host or lost binding): session/new + bind.
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
            }
          } else {
            // Initial run: session/new + bind.
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
          }

          let prompt =
            priorNativePaths !== undefined && priorNativePaths.length > 0
              ? `${prepared.prompt}\n${priorNativePaths.join("\n")}`
              : prepared.prompt;
          const abortSignal = prepared.abortSignal;
          const activeConnection = connection;

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
              const promptParts: Array<Record<string, unknown>> = [
                { type: "text", text: prompt },
              ];
              result = await promptOrAbort({
                sessionId,
                prompt: promptParts,
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
