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
import {
  headlessMcpConfigDocument,
  headlessTurnArgs,
  type HeadlessHostDescription,
} from "./description.ts";

export type HeadlessRoleTurnHostConfig = Readonly<{
  description: HeadlessHostDescription;
  sessionIdentity: AcpSessionIdentityAuthority;
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

/** One headless CLI result envelope (`--output-format json`). */
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

/** Parse host stdout (`--output-format json`); stream-json last-result is defensive only. */
export function parseHeadlessCliStdout(stdout: string): HeadlessCliResult | undefined {
  const trimmed = stdout.trim();
  if (trimmed === "") return undefined;
  try {
    const single = JSON.parse(trimmed) as unknown;
    if (typeof single === "object" && single !== null && !Array.isArray(single)) {
      const record = single as HeadlessCliResult & { type?: unknown };
      if (record.type === undefined || record.type === "result" || record.structured_output !== undefined) {
        return record;
      }
    }
  } catch { /* fall through */ }
  let last: HeadlessCliResult | undefined;
  for (const line of trimmed.split("\n")) {
    const text = line.trim();
    if (text === "") continue;
    try {
      const value = JSON.parse(text) as unknown;
      if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
      const record = value as HeadlessCliResult & { type?: unknown };
      if (record.type === "result" || record.structured_output !== undefined) last = record;
    } catch { /* skip noise */ }
  }
  return last;
}

const STDERR_DIAGNOSTIC_CAP = 16 * 1024;
function clipDiagnostic(text: string): string {
  return text.length <= STDERR_DIAGNOSTIC_CAP ? text : `${text.slice(0, STDERR_DIAGNOSTIC_CAP)}\n…[stderr clipped]`;
}

function spawnHeadlessTurn(options: {
  readonly binary: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
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
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    const settle = (code: number | null): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve({ code, stdout, stderr, timedOut });
    };
    const onAbort = (): void => {
      child.kill("SIGTERM");
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      reject(hostAbortedError("headless host aborted"));
    };
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      // Cap retained stderr: diagnostics only, not an unbounded transcript face.
      if (stderr.length < STDERR_DIAGNOSTIC_CAP) {
        stderr = clipDiagnostic(stderr + chunk);
      }
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
            });
          } catch (error) {
            if (isHostAbortedError(error)) throw error;
            const message = error instanceof Error ? error.message : String(error);
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
              diagnostic: clipDiagnostic(spawned.stderr.trim() || "headless CLI produced no parseable result"),
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
                : clipDiagnostic(spawned.stderr.trim() || "headless CLI reported is_error");
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
