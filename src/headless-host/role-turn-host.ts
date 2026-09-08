/**
 * Generic headless CLI RoleTurnHost (#645 / #752).
 * One process per turn: spawn → read stdout/exit → structured_output / MCP → envelope.
 * No reads of the host's private home; session id is package-owned binding only.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { RoleTurnHost, RoleTurnKnownFailure, RoleTurnRequest, RoleTurnResult } from "../host-contracts.ts";
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
): RoleTurnResult {
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

/** One headless CLI result envelope (claude `--output-format json` / stream-json last line). */
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
 * Parse host stdout into the result envelope.
 * `json`: whole stdout is one object.
 * `stream-json`: NDJSON; last `type:"result"` (or last object with subtype) wins.
 */
export function parseHeadlessCliStdout(stdout: string): HeadlessCliResult | undefined {
  const trimmed = stdout.trim();
  if (trimmed === "") return undefined;
  // Prefer a single JSON document (non-stream json mode).
  try {
    const single = JSON.parse(trimmed) as unknown;
    if (typeof single === "object" && single !== null && !Array.isArray(single)) {
      const record = single as HeadlessCliResult & { type?: unknown };
      // Whole-doc mode is the result envelope; stream-json never arrives as one doc.
      if (record.type === undefined || record.type === "result" || record.structured_output !== undefined) {
        return record;
      }
    }
  } catch {
    // fall through to NDJSON
  }
  // stream-json: only the result message (or any line carrying structured_output).
  // Do not treat system/task_summary or other subtype lines as the envelope.
  let last: HeadlessCliResult | undefined;
  for (const line of trimmed.split("\n")) {
    const text = line.trim();
    if (text === "") continue;
    try {
      const value = JSON.parse(text) as unknown;
      if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
      const record = value as HeadlessCliResult & { type?: unknown };
      if (record.type === "result" || record.structured_output !== undefined) {
        last = record;
      }
    } catch {
      // skip non-JSON noise lines
    }
  }
  return last;
}

/** Extract system/init (or first system) event from stream-json stdout for run evidence. */
export function extractSystemInitEvent(stdout: string): unknown | undefined {
  for (const line of stdout.split("\n")) {
    const text = line.trim();
    if (text === "") continue;
    try {
      const value = JSON.parse(text) as { type?: unknown; subtype?: unknown };
      if (value.type === "system" && (value.subtype === "init" || value.subtype === undefined)) {
        return value;
      }
    } catch {
      // skip
    }
  }
  return undefined;
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
      reject(Object.assign(new Error("headless host aborted"), { code: "host-aborted" }));
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
      reject(Object.assign(new Error("headless host aborted"), { code: "host-aborted" }));
    };
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
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

/**
 * Main-session headless adapter. prepare() is the shared envelope boundary;
 * this module owns only CLI spawn / parse / session-id bind / resume loop.
 */
export function createHeadlessRoleTurnHost(config: HeadlessRoleTurnHostConfig): RoleTurnHost {
  let serial = Promise.resolve();
  return {
    executeTurn(request) {
      const execution = serial.then(async (): Promise<RoleTurnResult> => {
        const prepared = await config.prepare(request);
        const systemPrompt = renderAcpSystemPromptOverride(prepared.systemPrompt);
        let accepted = false;
        try {
          // Same-host resume reuses the bound native session id via --resume.
          let sessionId = await config.sessionIdentity.load(request.principal);
          let sessionKind: "new" | "resume" =
            request.continuation.kind === "resume" && sessionId !== undefined && sessionId !== ""
              ? "resume"
              : "new";
          if (sessionKind === "new") {
            sessionId = randomUUID();
            await config.sessionIdentity.bind(request.principal, sessionId);
          }

          // Cross-host handoff: prior-native paths ride the user prompt (DK-7).
          const priorNativePaths =
            request.continuation.kind === "resume"
              ? request.hostTransition?.priorNativePaths
              : undefined;
          let prompt =
            priorNativePaths !== undefined && priorNativePaths.length > 0
              ? `${prepared.prompt}\n${priorNativePaths.join("\n")}`
              : prepared.prompt;

          const abortSignal =
            request.signal === undefined
              ? prepared.abortSignal
              : prepared.abortSignal === undefined
                ? request.signal
                : AbortSignal.any([prepared.abortSignal, request.signal]);

          const env: NodeJS.ProcessEnv = {
            ...process.env,
            ...config.env,
            AK_PACKAGE_ROOT: process.env.AK_PACKAGE_ROOT,
          };

          // Materialize system prompt + MCP config once per prepare (stable across
          // correctable retries). Paths live under the run directory we already own.
          const systemPromptPath = join(request.runDirectory, "headless-system-prompt.txt");
          await writeFile(systemPromptPath, systemPrompt, "utf8");
          let mcpConfigPath: string | undefined;
          if (prepared.mcpServers.length > 0) {
            mcpConfigPath = join(request.runDirectory, "headless-mcp-config.json");
            await writeFile(
              mcpConfigPath,
              `${JSON.stringify(headlessMcpConfigDocument(prepared.mcpServers), null, 2)}\n`,
              "utf8",
            );
          }

          // No round cap on content review (#750); this bound is only for
          // correctable mechanical resubmit (non-sole etc.), matching ACP's 8.
          for (let attempt = 0; attempt < 8; attempt += 1) {
            if (abortSignal?.aborted) {
              const closure = await prepared.closeRound();
              if ("failure" in closure) {
                return { code: null, stderr: "", timedOut: false, knownFailure: closure.failure };
              }
              return failure("session", "HostAborted", "host-aborted", { sessionId });
            }

            const args = headlessTurnArgs({
              description: config.description,
              prompt,
              systemPromptPath,
              jsonSchema: prepared.jsonSchema,
              ...(mcpConfigPath === undefined ? {} : { mcpConfigPath }),
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
              // Spawn itself failed (binary missing, etc.) — activation surface.
              const message = error instanceof Error ? error.message : String(error);
              return failure("activation", "HeadlessSpawnFailure", "spawn-failed", {
                diagnostic: message,
                binary: config.binary,
              });
            }

            // Persist raw stdout + system/init into the run directory (sitian home of
            // the leg). Code never reads ~/.claude; this is our own process output.
            try {
              await writeFile(join(request.runDirectory, `headless-stdout-${attempt}.log`), spawned.stdout, "utf8");
              await writeFile(join(request.runDirectory, `headless-stderr-${attempt}.log`), spawned.stderr, "utf8");
              const initEvent = extractSystemInitEvent(spawned.stdout);
              if (initEvent !== undefined) {
                await writeFile(
                  join(request.runDirectory, `headless-system-init-${attempt}.json`),
                  `${JSON.stringify(initEvent)}\n`,
                  "utf8",
                );
              }
            } catch {
              // Evidence write must not override the turn outcome.
            }

            if (spawned.timedOut) {
              return {
                code: spawned.code,
                stderr: spawned.stderr,
                timedOut: true,
                knownFailure: {
                  cause: "timeout",
                  identity: { name: "HeadlessTimeout", code: "timeout" },
                  details: { sessionId },
                },
              };
            }

            const envelope = parseHeadlessCliStdout(spawned.stdout);
            if (envelope === undefined) {
              return {
                code: spawned.code,
                stderr: spawned.stderr,
                timedOut: false,
                knownFailure: {
                  cause: "output",
                  identity: { name: "HeadlessEmptyOutput", code: "empty-stdout" },
                  diagnostic: spawned.stderr.trim() || "headless CLI produced no parseable result",
                  details: { sessionId, exitCode: spawned.code },
                },
              };
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
              const knownFailure: RoleTurnKnownFailure = {
                cause: "output",
                identity: {
                  name: "HeadlessCliError",
                  code: errorCode,
                },
                diagnostic: typeof envelope.result === "string"
                  ? envelope.result
                  : Array.isArray(envelope.errors)
                    ? envelope.errors.map(String).join("\n")
                    : spawned.stderr.trim() || "headless CLI reported is_error",
                details: {
                  sessionId,
                  subtype: envelope.subtype,
                  errors: envelope.errors,
                  exitCode: spawned.code,
                },
              };
              return { code: spawned.code, stderr: spawned.stderr, timedOut: false, knownFailure };
            }

            // Dual receipt: structured_output (schema channel) and/or terminating MCP tool.
            // Missing structured_output is not automatic failure when MCP already submitted.
            if (envelope.structured_output !== undefined) {
              await prepared.ingestStructuredOutput(envelope.structured_output);
            }
            const closure = await prepared.closeRound();
            if (closure.accepted) {
              accepted = true;
              return { code: 0, stderr: spawned.stderr, timedOut: false };
            }
            if ("failure" in closure) {
              return { code: null, stderr: spawned.stderr, timedOut: false, knownFailure: closure.failure };
            }
            // Correctable rejection → resume same session with plain resubmit prompt.
            prompt = `The prior terminal submission was rejected (${closure.retry.code}). Resubmit it as the sole terminal structured output (or the sole terminating tool call). Rejected call ids: ${closure.retry.toolCallIds.join(", ") || "none"}.`;
            sessionKind = "resume";
          }
          return failure("output", "HeadlessRoundLimit", "round-retry-limit", { sessionId });
        } finally {
          try { await prepared.dispose?.(); }
          catch { /* Preserve the original turn result or failure. */ }
          void accepted;
        }
      });
      serial = execution.then(() => undefined, () => undefined);
      return execution;
    },
  };
}
