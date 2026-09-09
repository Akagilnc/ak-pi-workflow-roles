/**
 * Headless CLI last hop (#645/#646/#820): spawn/parse/bind. Shared retry/resume
 * loop = external-host-turn-loop. Claude print-mode and codex exec share this
 * lifecycle; argv/parse are protocol-specific.
 */
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import type { RoleTurnHost, RoleTurnRequest, RoleTurnResult } from "../host-contracts.ts";
import {
  createSerializedRoleTurnHost,
  driveExternalRoleTurnRounds,
  hostAbortedError,
  isHostAbortedError,
} from "../external-host-turn-loop.ts";
import {
  renderSystemPromptOverride,
  type PreparedRoleTurn,
  type SessionIdentityAuthority,
} from "../prepared-role-turn.ts";

import { reportHostSessionEvent } from "../host-session-record.ts";
import {
  closeJsonSchemaForCodex,
  codexTurnArgs,
  headlessMcpConfigDocument,
  headlessTurnArgs,
  isClaudePrintDescription,
  isCodexExecDescription,
  type HeadlessHostDescription,
} from "./description.ts";

export type HeadlessRoleTurnHostConfig = Readonly<{
  description: HeadlessHostDescription;
  sessionIdentity: SessionIdentityAuthority;
  /** Seat-table host key (e.g. claude) for sitian host field. */
  hostName: string;
  binary: string;
  prepare(request: RoleTurnRequest): Promise<PreparedRoleTurn>;
  env?: NodeJS.ProcessEnv;
}>;

function failure(
  cause: "activation" | "session" | "output" | "provider",
  name: string,
  code: string,
  details?: Readonly<Record<string, unknown>>,
  diagnostic?: string,
): RoleTurnResult {
  return {
    code: null,
    stderr: "",
    timedOut: false,
    knownFailure: {
      cause,
      identity: { name, code },
      ...(diagnostic === undefined ? {} : { diagnostic }),
      ...(details === undefined ? {} : { details }),
    },
  };
}

/** One headless CLI result envelope (stream-json last line, or single json doc). */
export type HeadlessCliResult = Readonly<{
  session_id?: string;
  is_error?: boolean;
  subtype?: string;
  result?: unknown;
  structured_output?: unknown;
  errors?: unknown;
  permission_denials?: unknown;
  [key: string]: unknown;
}>;

/**
 * True when a parsed stdout object is the typed result receipt (or a single-doc
 * envelope without stream-json `type`). Intermediate stream-json events are not.
 */
function isHeadlessResultCandidate(value: unknown): value is HeadlessCliResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as HeadlessCliResult & { type?: unknown };
  return record.type === undefined
    || record.type === "result"
    || record.structured_output !== undefined;
}

/**
 * Parse Claude host stdout into the result envelope.
 * Production uses `--output-format stream-json` (#811 live records); last-result
 * line is the typed receipt. A single-document `json` body still parses so a
 * misconfigured description yields a typed miss rather than a silent empty parse.
 * Callers must not retain the full stream — only the rolling result candidate.
 */
export function parseHeadlessCliStdout(stdout: string): HeadlessCliResult | undefined {
  const trimmed = stdout.trim();
  if (trimmed === "") return undefined;
  try {
    const single = JSON.parse(trimmed) as unknown;
    if (isHeadlessResultCandidate(single)) return single;
  } catch {
    // fall through
  }
  // stream-json: keep the last result line (structured_output / is_error live here).
  let last: HeadlessCliResult | undefined;
  for (const line of trimmed.split("\n")) {
    const text = line.trim();
    if (text === "") continue;
    try {
      const value = JSON.parse(text) as unknown;
      if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
      const record = value as HeadlessCliResult & { type?: unknown };
      // Multi-line stream: only explicit result / structured_output lines (not bare objects).
      if (record.type === "result" || record.structured_output !== undefined) {
        last = record;
      }
    } catch {
      // skip non-JSON noise lines
    }
  }
  return last;
}

/**
 * If `line` is a result-candidate JSON object, return its trimmed text; else undefined.
 * Used to roll the sole stdout retained for final parse (no full-stream copy).
 */
function resultCandidateText(line: string): string | undefined {
  const text = line.trim();
  if (text === "") return undefined;
  try {
    const value = JSON.parse(text) as unknown;
    return isHeadlessResultCandidate(value) ? text : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Minimal consumer-driven parse of `codex exec --json` JSONL (ADR 0043).
 * Only takes thread_id, final agent_message text, and turn.failed/error.
 */
export type CodexExecTurnObservation = Readonly<{
  threadId?: string;
  /** Last `item.completed` agent_message text (final message / structured receipt). */
  finalMessage?: string;
  /** Present when the turn failed or emitted a top-level error event. */
  failureDiagnostic?: string;
  turnCompleted: boolean;
}>;

export function parseCodexExecJsonl(stdout: string): CodexExecTurnObservation {
  let threadId: string | undefined;
  let finalMessage: string | undefined;
  let failureDiagnostic: string | undefined;
  let turnCompleted = false;

  for (const line of stdout.split("\n")) {
    const text = line.trim();
    if (text === "") continue;
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      continue;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const event = value as Record<string, unknown>;
    const type = typeof event.type === "string" ? event.type : undefined;
    if (type === "thread.started" && typeof event.thread_id === "string" && event.thread_id !== "") {
      threadId = event.thread_id;
      continue;
    }
    if (type === "item.completed" && isPlainObject(event.item)) {
      const item = event.item;
      if (item.type === "agent_message" && typeof item.text === "string") {
        finalMessage = item.text;
      }
      continue;
    }
    if (type === "turn.completed") {
      turnCompleted = true;
      continue;
    }
    if (type === "turn.failed") {
      turnCompleted = false;
      failureDiagnostic = formatCodexFailurePayload(event.error ?? event);
      continue;
    }
    if (type === "error") {
      failureDiagnostic = formatCodexFailurePayload(event.error ?? event.message ?? event);
    }
  }

  return {
    ...(threadId === undefined ? {} : { threadId }),
    ...(finalMessage === undefined ? {} : { finalMessage }),
    ...(failureDiagnostic === undefined ? {} : { failureDiagnostic }),
    turnCompleted,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatCodexFailurePayload(payload: unknown): string {
  if (typeof payload === "string" && payload.trim() !== "") return payload;
  if (isPlainObject(payload)) {
    if (typeof payload.message === "string" && payload.message.trim() !== "") return payload.message;
    try {
      return JSON.stringify(payload);
    } catch {
      return "codex turn failed";
    }
  }
  return String(payload);
}

/**
 * Parse the final agent_message text as the structured receipt JSON.
 * Does not validate against schema (#750 code-never-judges-role-replies).
 */
export function parseCodexStructuredReceipt(finalMessage: string): unknown | undefined {
  const trimmed = finalMessage.trim();
  if (trimmed === "") return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

/** cwd or an ancestor has a `.git` entry (file or directory). */
export function cwdIsGitWorkTree(cwd: string): boolean {
  let dir = cwd;
  for (;;) {
    if (existsSync(join(dir, ".git"))) return true;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/**
 * Absolute git common dir for workspace-write extra roots (worktree index.lock).
 * Uses `git rev-parse --git-common-dir` once; empty when not a git work tree.
 */
export function resolveGitCommonDir(cwd: string): string | undefined {
  if (!cwdIsGitWorkTree(cwd)) return undefined;
  try {
    const result = spawnSync("git", ["rev-parse", "--git-common-dir"], {
      cwd,
      encoding: "utf8",
      timeout: 5_000,
    });
    if (result.status !== 0) return undefined;
    const raw = (result.stdout ?? "").trim();
    if (raw === "") return undefined;
    const absolute = isAbsolute(raw) ? raw : resolve(cwd, raw);
    return absolute;
  } catch {
    return undefined;
  }
}

function spawnHeadlessTurn(options: {
  readonly binary: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  /** Called for each complete stdout line as it arrives (live stream-json). */
  readonly onStdoutLine?: (line: string) => void;
  /**
   * Retain the full stdout stream instead of the rolling last-result-candidate
   * line. Codex `exec --json` JSONL needs multiple event types (thread_id,
   * item.completed, turn.completed/failed) from across the whole stream; the
   * Claude/ACP live-record path keeps the memory-bounded single-line default.
   */
  readonly retainFullStdout?: boolean;
}): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(hostAbortedError("headless host aborted"));
      return;
    }
    const child = spawn(options.binary, [...options.args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Rolling retention only: last result-candidate line for final parse.
    // Live events go to sitian via onStdoutLine — never accumulate the full stream.
    let resultStdout = "";
    let stderr = "";
    let lineBuffer = "";
    let settled = false;
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    const failLine = (error: unknown): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      try { child.kill("SIGTERM"); } catch { /* already exiting */ }
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const emitStdoutLine = (line: string): void => {
      if (options.retainFullStdout === true) {
        resultStdout += resultStdout === "" ? line : `\n${line}`;
      } else {
        const candidate = resultCandidateText(line);
        if (candidate !== undefined) resultStdout = candidate;
      }
      if (options.onStdoutLine === undefined) return;
      try {
        options.onStdoutLine(line);
      } catch (error) {
        failLine(error);
      }
    };
    const flushStdoutLines = (chunk: string, final: boolean): void => {
      lineBuffer += chunk;
      for (;;) {
        const end = lineBuffer.indexOf("\n");
        if (end < 0) break;
        const line = lineBuffer.slice(0, end);
        lineBuffer = lineBuffer.slice(end + 1);
        emitStdoutLine(line);
        if (settled) return;
      }
      if (final && lineBuffer.length > 0) {
        emitStdoutLine(lineBuffer);
        lineBuffer = "";
      }
    };
    const settle = (code: number | null): void => {
      if (settled) return;
      // Final flush first: onStdoutLine may failLine (reject + settled=true).
      flushStdoutLines("", true);
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve({ code, stdout: resultStdout, stderr, timedOut });
    };
    const onAbort = (): void => {
      child.kill("SIGTERM");
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      reject(hostAbortedError("headless host aborted"));
    };
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { flushStdoutLines(chunk, false); });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.on("close", (code) => settle(code));
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, options.timeoutMs);
    }
  });
}

/** Success→dispose failure; existing failure keeps primary cause + cleanup detail. */
function withCleanupFailure(outcome: RoleTurnResult, cleanupError: unknown): RoleTurnResult {
  const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
  if (outcome.knownFailure === undefined) {
    return failure("session", "HeadlessDisposeFailure", "dispose-failed", { cleanupError: message }, message);
  }
  return {
    ...outcome,
    knownFailure: {
      ...outcome.knownFailure,
      details: { ...(outcome.knownFailure.details ?? {}), cleanupError: message },
    },
  };
}

function terminalFromSpawned(
  spawned: { code: number | null; stderr: string; timedOut: boolean },
  knownFailure: NonNullable<RoleTurnResult["knownFailure"]>,
): { readonly status: "terminal"; readonly result: RoleTurnResult } {
  return {
    status: "terminal",
    result: {
      code: spawned.code,
      stderr: spawned.stderr,
      timedOut: spawned.timedOut,
      knownFailure,
    },
  };
}

type TurnAttemptPlan = Readonly<{
  args: readonly string[];
  /** Whether this attempt already has a package-bound session id to resume. */
  sessionKind: "new" | "resume";
}>;

function buildTurnAttempt(options: {
  readonly description: HeadlessHostDescription;
  readonly prompt: string;
  readonly systemPromptPath: string;
  readonly jsonSchema: Readonly<Record<string, unknown>>;
  readonly mcpServers: readonly Readonly<Record<string, unknown>>[];
  readonly mcpConfigPath: string;
  readonly outputSchemaPath: string;
  readonly model?: string;
  readonly effort?: string;
  readonly sessionId: string | undefined;
  readonly sessionKind: "new" | "resume";
  readonly cwd: string;
  readonly writableRoots?: readonly string[];
}): TurnAttemptPlan {
  if (isCodexExecDescription(options.description)) {
    const writable =
      options.writableRoots === undefined || options.writableRoots.length === 0
        ? {}
        : { writableRoots: options.writableRoots };
    if (options.sessionKind === "resume") {
      if (options.sessionId === undefined || options.sessionId === "") {
        throw new Error("codex resume requires a bound thread_id");
      }
      return {
        sessionKind: "resume",
        args: codexTurnArgs({
          prompt: options.prompt,
          systemPromptPath: options.systemPromptPath,
          outputSchemaPath: options.outputSchemaPath,
          mcpServers: options.mcpServers,
          ...(options.model === undefined ? {} : { model: options.model }),
          ...(options.effort === undefined ? {} : { effort: options.effort }),
          session: { kind: "resume", id: options.sessionId },
          skipGitRepoCheck: !cwdIsGitWorkTree(options.cwd),
          ...writable,
        }),
      };
    }
    return {
      sessionKind: "new",
      args: codexTurnArgs({
        prompt: options.prompt,
        systemPromptPath: options.systemPromptPath,
        outputSchemaPath: options.outputSchemaPath,
        mcpServers: options.mcpServers,
        ...(options.model === undefined ? {} : { model: options.model }),
        ...(options.effort === undefined ? {} : { effort: options.effort }),
        session: { kind: "new" },
        skipGitRepoCheck: !cwdIsGitWorkTree(options.cwd),
        ...writable,
      }),
    };
  }

  if (!isClaudePrintDescription(options.description)) {
    throw new Error(`unsupported headless host protocol`);
  }
  if (options.sessionId === undefined || options.sessionId === "") {
    throw new Error("claude print-mode requires a session id");
  }
  return {
    sessionKind: options.sessionKind,
    args: headlessTurnArgs({
      description: options.description,
      prompt: options.prompt,
      systemPromptPath: options.systemPromptPath,
      jsonSchema: options.jsonSchema,
      mcpConfigPath: options.mcpConfigPath,
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.effort === undefined ? {} : { effort: options.effort }),
      session: options.sessionKind === "new"
        ? { kind: "new", id: options.sessionId }
        : { kind: "resume", id: options.sessionId },
    }),
  };
}

/** Headless last hop (#820): session bind/resume, CLI spawn turn, MCP/json-schema/output-schema mount. */
export function createHeadlessRoleTurnHost(config: HeadlessRoleTurnHostConfig): RoleTurnHost {
  return createSerializedRoleTurnHost(async (request): Promise<RoleTurnResult> => {
    const prepared = await config.prepare(request);
    const systemPrompt = renderSystemPromptOverride(prepared.systemPrompt);
    const codex = isCodexExecDescription(config.description);
    let outcome: RoleTurnResult = failure("session", "HeadlessNoOutcome", "no-outcome");
    try {
      // Claude mints a package UUID for --session-id; codex waits for thread.started.
      let sessionId = await config.sessionIdentity.load(request.principal);
      let sessionKind: "new" | "resume" =
        request.continuation.kind === "resume" && sessionId !== undefined && sessionId !== ""
          ? "resume"
          : "new";
      if (sessionKind === "new" && !codex) {
        sessionId = randomUUID();
        await config.sessionIdentity.bind(request.principal, sessionId);
      }

      // config.env owns package-root/child env; do not re-spread process.env over it.
      const env: NodeJS.ProcessEnv = { ...process.env, ...(config.env ?? {}) };
      const systemPromptPath = join(request.runDirectory, "headless-system-prompt.txt");
      await writeFile(systemPromptPath, systemPrompt, "utf8");
      const mcpConfigPath = join(request.runDirectory, "headless-mcp-config.json");
      await writeFile(
        mcpConfigPath,
        `${JSON.stringify(headlessMcpConfigDocument(prepared.mcpServers), null, 2)}\n`,
        "utf8",
      );
      // Codex --output-schema needs a closed transport projection on disk.
      const outputSchemaPath = join(request.runDirectory, "headless-output-schema.json");
      if (codex) {
        const closed = closeJsonSchemaForCodex(prepared.jsonSchema);
        await writeFile(outputSchemaPath, `${JSON.stringify(closed, null, 2)}\n`, "utf8");
      }

      const sessionParent = config.sessionIdentity.resolveSessionFile(request.principal);
      outcome = await driveExternalRoleTurnRounds(prepared, request, {
        roundLimitName: "HeadlessRoundLimit",
        currentSessionId: () => sessionId,
        afterRetry() { sessionKind = "resume"; },
        async runRound({ prompt, abortSignal }) {
          let plan: TurnAttemptPlan;
          try {
            const gitCommonDir = codex ? resolveGitCommonDir(request.cwd) : undefined;
            plan = buildTurnAttempt({
              description: config.description,
              prompt,
              systemPromptPath,
              jsonSchema: prepared.jsonSchema,
              mcpServers: prepared.mcpServers,
              mcpConfigPath,
              outputSchemaPath,
              ...(request.model?.model !== undefined ? { model: request.model.model } : {}),
              ...(request.model?.thinking !== undefined ? { effort: request.model.thinking } : {}),
              sessionId,
              sessionKind,
              cwd: request.cwd,
              ...(gitCommonDir === undefined ? {} : { writableRoots: [gitCommonDir] }),
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return {
              status: "terminal",
              result: failure("session", "HeadlessArgvFailure", "argv-failed", { diagnostic: message }, message),
            };
          }

          let spawned: { code: number | null; stdout: string; stderr: string; timedOut: boolean };
          try {
            spawned = await spawnHeadlessTurn({
              binary: config.binary,
              args: plan.args,
              cwd: request.cwd,
              env,
              ...(abortSignal === undefined ? {} : { signal: abortSignal }),
              ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
              ...(codex
                ? { retainFullStdout: true }
                : {
                  onStdoutLine(line) {
                    const trimmed = line.trim();
                    if (trimmed === "") return;
                    let event: unknown;
                    try {
                      event = JSON.parse(trimmed) as unknown;
                    } catch {
                      // Non-JSON noise on stdout is not a host structured event.
                      return;
                    }
                    // Sitian write failures propagate → spawn rejects → session failure.
                    reportHostSessionEvent({
                      host: config.hostName,
                      cwd: request.cwd,
                      sessionParent,
                      source: "headless-host",
                      event,
                    });
                  },
                }),
            });
          } catch (error) {
            if (isHostAbortedError(error)) throw error;
            const message = error instanceof Error ? error.message : String(error);
            // SitianInfrastructureError.knownCause is session; spawn errno stays activation.
            const isRecordFailure =
              typeof error === "object"
              && error !== null
              && ((error as { knownCause?: unknown }).knownCause === "session"
                || (error as { name?: unknown }).name === "SitianInfrastructureError");
            if (isRecordFailure) {
              return {
                status: "terminal",
                result: failure(
                  "session",
                  "HostSessionRecordFailure",
                  "host-session-record-failed",
                  { diagnostic: message, sessionId },
                  message,
                ),
              };
            }
            return {
              status: "terminal",
              result: failure("activation", "HeadlessSpawnFailure", "spawn-failed", {
                diagnostic: message,
                binary: config.binary,
              }, message),
            };
          }

          if (spawned.timedOut) {
            return terminalFromSpawned(spawned, {
              cause: "timeout",
              identity: { name: "HeadlessTimeout", code: "timeout" },
              details: { sessionId },
            });
          }

          if (codex) {
            const observation = parseCodexExecJsonl(spawned.stdout);
            if (observation.threadId !== undefined && observation.threadId !== "") {
              sessionId = observation.threadId;
              await config.sessionIdentity.bind(request.principal, sessionId);
            }

            if (observation.failureDiagnostic !== undefined) {
              return terminalFromSpawned(spawned, {
                cause: "output",
                identity: { name: "HeadlessCliError", code: "codex-turn-failed" },
                diagnostic: observation.failureDiagnostic,
                details: { sessionId, exitCode: spawned.code },
              });
            }

            // Non-zero exit without a parseable failure event still fails loud.
            if (spawned.code !== 0 && spawned.code !== null) {
              return terminalFromSpawned(spawned, {
                cause: "output",
                identity: { name: "HeadlessCliError", code: "codex-nonzero-exit" },
                diagnostic: spawned.stderr.trim() || `codex exec exited ${String(spawned.code)}`,
                details: { sessionId, exitCode: spawned.code },
              });
            }

            if (observation.finalMessage === undefined) {
              return terminalFromSpawned(spawned, {
                cause: "output",
                identity: { name: "HeadlessEmptyOutput", code: "empty-stdout" },
                diagnostic: spawned.stderr.trim() || "codex exec produced no agent_message",
                details: { sessionId, exitCode: spawned.code },
              });
            }

            const receipt = parseCodexStructuredReceipt(observation.finalMessage);
            if (receipt === undefined) {
              // Not JSON: typed output miss. Content judgment is not package code's job
              // (#750); unreadable structured receipt is a parse/transport fact.
              return terminalFromSpawned(spawned, {
                cause: "output",
                identity: { name: "HeadlessEmptyOutput", code: "unparseable-final-message" },
                diagnostic: "codex final agent_message was not JSON",
                details: { sessionId, exitCode: spawned.code },
              });
            }
            await prepared.ingestStructuredOutput(receipt);
            return { status: "delivered", stderr: spawned.stderr };
          }

          // Claude print-mode path.
          const envelope = parseHeadlessCliStdout(spawned.stdout);
          if (envelope === undefined) {
            return terminalFromSpawned(spawned, {
              cause: "output",
              identity: { name: "HeadlessEmptyOutput", code: "empty-stdout" },
              diagnostic: spawned.stderr.length > 0 ? spawned.stderr : "headless CLI produced no parseable result",
              details: { sessionId, exitCode: spawned.code },
            });
          }

          // Bind the host-reported session id (authoritative for --resume).
          if (typeof envelope.session_id === "string" && envelope.session_id !== "") {
            sessionId = envelope.session_id;
            await config.sessionIdentity.bind(request.principal, sessionId);
          }

          if (envelope.is_error === true || (typeof envelope.subtype === "string" && envelope.subtype.startsWith("error_"))) {
            const errorCode =
              typeof envelope.subtype === "string" && envelope.subtype.startsWith("error_")
                ? envelope.subtype
                : envelope.is_error === true
                  ? "is_error"
                  : "cli-error";
            const diagnostic = typeof envelope.result === "string"
              ? envelope.result
              : Array.isArray(envelope.errors)
                ? envelope.errors.map(String).join("\n")
                : spawned.stderr.length > 0 ? spawned.stderr : "headless CLI reported is_error";
            return terminalFromSpawned(spawned, {
              cause: "output",
              identity: { name: "HeadlessCliError", code: errorCode },
              diagnostic,
              details: {
                sessionId,
                subtype: envelope.subtype,
                errors: envelope.errors,
                exitCode: spawned.code,
              },
            });
          }

          if (envelope.structured_output !== undefined) {
            await prepared.ingestStructuredOutput(envelope.structured_output);
          }
          return { status: "delivered", stderr: spawned.stderr };
        },
      });
    } finally {
      try {
        await prepared.dispose?.();
      } catch (cleanupError) {
        outcome = withCleanupFailure(outcome, cleanupError);
      }
    }
    return outcome;
  });
}
