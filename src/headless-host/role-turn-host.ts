/** Headless CLI last hop (#645/#820): spawn/parse/bind. Shared loop = external-host-turn-loop. */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { RoleTurnHost, RoleTurnRequest, RoleTurnResult } from "../host-contracts.ts";
import {
  createSerializedRoleTurnHost,
  driveExternalRoleTurnRounds,
  hostAbortedError,
  isHostAbortedError,
} from "../external-host-turn-loop.ts";
import {
  renderAcpSystemPromptOverride,
  type AcpPreparedTurn,
  type AcpSessionIdentityAuthority,
} from "../acp-host/role-turn-host.ts";
import { retainDiagnosticTail } from "../diagnostic-tail.ts";
import { reportHostSessionEvent } from "../host-session-record.ts";
import {
  headlessMcpConfigDocument,
  headlessTurnArgs,
  type HeadlessHostDescription,
} from "./description.ts";

export type HeadlessRoleTurnHostConfig = Readonly<{
  description: HeadlessHostDescription;
  sessionIdentity: AcpSessionIdentityAuthority;
  /** Seat-table host key (e.g. claude) for sitian host field. */
  hostName: string;
  binary: string;
  prepare(request: RoleTurnRequest): Promise<AcpPreparedTurn>;
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
 * Parse host stdout into the result envelope.
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

function spawnHeadlessTurn(options: {
  readonly binary: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  /** Called for each complete stdout line as it arrives (live stream-json). */
  readonly onStdoutLine?: (line: string) => void;
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
      const candidate = resultCandidateText(line);
      if (candidate !== undefined) resultStdout = candidate;
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
      // Rolling diagnostic tail only — not an unbounded transcript face.
      stderr = retainDiagnosticTail(stderr + chunk);
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

/** Headless last hop (#820): session bind/resume, CLI spawn turn, MCP/json-schema mount. */
export function createHeadlessRoleTurnHost(config: HeadlessRoleTurnHostConfig): RoleTurnHost {
  return createSerializedRoleTurnHost(async (request): Promise<RoleTurnResult> => {
    const prepared = await config.prepare(request);
    const systemPrompt = renderAcpSystemPromptOverride(prepared.systemPrompt);
    let outcome: RoleTurnResult = failure("session", "HeadlessNoOutcome", "no-outcome");
    try {
      let sessionId = await config.sessionIdentity.load(request.principal);
      let sessionKind: "new" | "resume" =
        request.continuation.kind === "resume" && sessionId !== undefined && sessionId !== ""
          ? "resume"
          : "new";
      if (sessionKind === "new") {
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

      const sessionParent = config.sessionIdentity.resolveSessionFile(request.principal);
      outcome = await driveExternalRoleTurnRounds(prepared, request, {
        roundLimitName: "HeadlessRoundLimit",
        currentSessionId: () => sessionId,
        afterRetry() { sessionKind = "resume"; },
        async runRound({ prompt, abortSignal }) {
          const args = headlessTurnArgs({
            description: config.description,
            prompt,
            systemPromptPath,
            jsonSchema: prepared.jsonSchema,
            mcpConfigPath,
            ...(request.model?.model !== undefined ? { model: request.model.model } : {}),
            ...(request.model?.thinking !== undefined ? { effort: request.model.thinking } : {}),
            session: sessionKind === "new"
              ? { kind: "new", id: sessionId! }
              : { kind: "resume", id: sessionId! },
          });

          let spawned: { code: number | null; stdout: string; stderr: string; timedOut: boolean };
          try {
            spawned = await spawnHeadlessTurn({
              binary: config.binary,
              args,
              cwd: request.cwd,
              env,
              ...(abortSignal === undefined ? {} : { signal: abortSignal }),
              ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
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

          const envelope = parseHeadlessCliStdout(spawned.stdout);
          if (envelope === undefined) {
            return terminalFromSpawned(spawned, {
              cause: "output",
              identity: { name: "HeadlessEmptyOutput", code: "empty-stdout" },
              diagnostic: retainDiagnosticTail(spawned.stderr.trim() || "headless CLI produced no parseable result"),
              details: { sessionId, exitCode: spawned.code },
            });
          }

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
                : retainDiagnosticTail(spawned.stderr.trim() || "headless CLI reported is_error");
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
