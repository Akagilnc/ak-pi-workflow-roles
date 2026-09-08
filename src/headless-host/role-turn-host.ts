/**
 * Generic headless CLI RoleTurnHost (#645 / #752).
 * One process per turn: spawn → read result envelope/exit → structured_output / MCP → envelope.
 * No reads of the host's private home; session id is package-owned binding only.
 * No permanent stdout/stderr/init probe copies — sitian + binding are the dossier.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

/** One-shot isolation evidence face (ticket #645 须真跑证 ②). Not a permanent probe copy. */
const CAPTURE_INIT_ENV = "AK_ROLE_CAPTURE_INIT";

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

/**
 * Parse host stdout into the result envelope.
 * Production uses `--output-format json` (one document). stream-json last-result
 * parsing remains so a misconfigured description still yields a typed miss rather
 * than a silent empty parse — not a permanent probe path.
 */
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
  } catch {
    // fall through
  }
  // Defensive: if a description still requests stream-json, keep only the result line.
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

/** Bound stderr retained only for failure diagnostics (not a dossier copy). */
const STDERR_DIAGNOSTIC_CAP = 16 * 1024;

function clipDiagnostic(text: string): string {
  if (text.length <= STDERR_DIAGNOSTIC_CAP) return text;
  return `${text.slice(0, STDERR_DIAGNOSTIC_CAP)}\n…[stderr clipped]`;
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

function cleanupErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One-shot: spawn with stream-json+verbose, keep only typed isolation fields from
 * system/init (mcp_servers / plugins / permissionMode). Full stream is discarded.
 */
async function captureHeadlessSystemInitIsolation(options: {
  readonly binary: string;
  readonly description: HeadlessHostDescription;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly systemPromptPath: string;
  readonly mcpConfigPath: string;
  readonly runDirectory: string;
  readonly model?: string;
}): Promise<void> {
  const args = [
    options.description.promptFlag,
    "isolation-init-probe",
    // stream-json requires --verbose; not the production receipt face.
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "bypassPermissions",
    "--setting-sources",
    "",
    "--strict-mcp-config",
    options.description.systemPromptFlag,
    options.systemPromptPath,
    options.description.mcpConfigFlag,
    options.mcpConfigPath,
    options.description.sessionIdFlag,
    randomUUID(),
  ];
  if (options.model !== undefined && options.model !== "") {
    args.push(options.description.modelFlag, options.model);
  }
  let spawned: { code: number | null; stdout: string; stderr: string; timedOut: boolean };
  try {
    spawned = await spawnHeadlessTurn({
      binary: options.binary,
      args,
      cwd: options.cwd,
      env: options.env,
      timeoutMs: 120_000,
    });
  } catch {
    return;
  }
  let init: Record<string, unknown> | undefined;
  for (const line of spawned.stdout.split("\n")) {
    const text = line.trim();
    if (text === "") continue;
    try {
      const value = JSON.parse(text) as unknown;
      if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
      const record = value as Record<string, unknown>;
      if (record.type === "system" && record.subtype === "init") {
        init = record;
        break;
      }
    } catch {
      // skip
    }
  }
  if (init === undefined) return;
  const evidence = Object.freeze({
    mcp_servers: init.mcp_servers ?? null,
    plugins: init.plugins ?? null,
    permissionMode: init.permissionMode ?? null,
    model: init.model ?? null,
  });
  await writeFile(
    join(options.runDirectory, "headless-system-init-isolation.json"),
    `${JSON.stringify(evidence, null, 2)}\n`,
    "utf8",
  );
}

/**
 * If dispose/cleanup failed: success becomes typed failure; existing failure keeps
 * its primary cause and records the cleanup error in details (failure-honesty).
 */
function withCleanupFailure(outcome: RoleTurnResult, cleanupError: unknown): RoleTurnResult {
  const message = cleanupErrorMessage(cleanupError);
  if (outcome.knownFailure === undefined) {
    return failure(
      "session",
      "HeadlessDisposeFailure",
      "dispose-failed",
      { cleanupError: message },
      message,
    );
  }
  return {
    ...outcome,
    knownFailure: {
      ...outcome.knownFailure,
      details: {
        ...(outcome.knownFailure.details ?? {}),
        cleanupError: message,
      },
    },
  };
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
        let outcome: RoleTurnResult = failure("session", "HeadlessNoOutcome", "no-outcome");
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

          // config.env is the production authority for package-root / host child env
          // (see createProductionHeadlessRoleTurnHost). Do not re-override keys from
          // process.env after the spread — that erased AK_PACKAGE_ROOT.
          const env: NodeJS.ProcessEnv = {
            ...process.env,
            ...(config.env ?? {}),
          };

          // Materialize system prompt + MCP config once per prepare (stable across
          // correctable retries). Paths live under the run directory we already own.
          // Envelope always projects the AK MCP relay row; no empty-server branch.
          const systemPromptPath = join(request.runDirectory, "headless-system-prompt.txt");
          await writeFile(systemPromptPath, systemPrompt, "utf8");
          const mcpConfigPath = join(request.runDirectory, "headless-mcp-config.json");
          await writeFile(
            mcpConfigPath,
            `${JSON.stringify(headlessMcpConfigDocument(prepared.mcpServers), null, 2)}\n`,
            "utf8",
          );

          // Optional one-shot system/init isolation evidence (#645 须真跑证 ②).
          // Production default stays --output-format json (no stream copy). When the
          // owner sets AK_ROLE_CAPTURE_INIT=1 once, write typed mcp_servers/plugins only.
          if (process.env[CAPTURE_INIT_ENV] === "1") {
            await captureHeadlessSystemInitIsolation({
              binary: config.binary,
              description: config.description,
              cwd: request.cwd,
              env,
              systemPromptPath,
              mcpConfigPath,
              runDirectory: request.runDirectory,
              model: request.model?.model,
            });
          }

          // No round cap on content review (#750); this bound is only for
          // correctable mechanical resubmit (non-sole etc.), matching ACP's 8.
          for (let attempt = 0; attempt < 8; attempt += 1) {
            if (abortSignal?.aborted) {
              const closure = await prepared.closeRound();
              if ("failure" in closure) {
                outcome = { code: null, stderr: "", timedOut: false, knownFailure: closure.failure };
                break;
              }
              outcome = failure("session", "HostAborted", "host-aborted", { sessionId });
              break;
            }

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
              if (
                typeof error === "object"
                && error !== null
                && (error as { code?: unknown }).code === "host-aborted"
              ) {
                const closure = await prepared.closeRound();
                if ("failure" in closure) {
                  outcome = { code: null, stderr: "", timedOut: false, knownFailure: closure.failure };
                  break;
                }
                outcome = failure("session", "HostAborted", "host-aborted", { sessionId });
                break;
              }
              const message = error instanceof Error ? error.message : String(error);
              outcome = failure("activation", "HeadlessSpawnFailure", "spawn-failed", {
                diagnostic: message,
                binary: config.binary,
              }, message);
              break;
            }

            if (spawned.timedOut) {
              outcome = {
                code: spawned.code,
                stderr: spawned.stderr,
                timedOut: true,
                knownFailure: {
                  cause: "timeout",
                  identity: { name: "HeadlessTimeout", code: "timeout" },
                  details: { sessionId },
                },
              };
              break;
            }

            const envelope = parseHeadlessCliStdout(spawned.stdout);
            if (envelope === undefined) {
              outcome = {
                code: spawned.code,
                stderr: spawned.stderr,
                timedOut: false,
                knownFailure: {
                  cause: "output",
                  identity: { name: "HeadlessEmptyOutput", code: "empty-stdout" },
                  diagnostic: clipDiagnostic(spawned.stderr.trim() || "headless CLI produced no parseable result"),
                  details: { sessionId, exitCode: spawned.code },
                },
              };
              break;
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
                  : clipDiagnostic(spawned.stderr.trim() || "headless CLI reported is_error");
              outcome = {
                code: spawned.code,
                stderr: spawned.stderr,
                timedOut: false,
                knownFailure: {
                  cause: "output",
                  identity: { name: "HeadlessCliError", code: errorCode },
                  diagnostic,
                  details: {
                    sessionId,
                    subtype: envelope.subtype,
                    errors: envelope.errors,
                    exitCode: spawned.code,
                  },
                },
              };
              break;
            }

            // Schema channel: host-native structured_output is the terminating receipt
            // (#750). Intermediate tools may have already run via MCP during the process.
            if (envelope.structured_output !== undefined) {
              await prepared.ingestStructuredOutput(envelope.structured_output);
            }
            const closure = await prepared.closeRound();
            if (closure.accepted) {
              outcome = { code: 0, stderr: "", timedOut: false };
              break;
            }
            if ("failure" in closure) {
              outcome = { code: null, stderr: spawned.stderr, timedOut: false, knownFailure: closure.failure };
              break;
            }
            // Correctable rejection → resume same session with plain resubmit prompt.
            prompt = `The prior terminal submission was rejected (${closure.retry.code}). Resubmit it as the sole terminal structured output (or the sole terminating tool call). Rejected call ids: ${closure.retry.toolCallIds.join(", ") || "none"}.`;
            sessionKind = "resume";
            if (attempt === 7) {
              outcome = failure("output", "HeadlessRoundLimit", "round-retry-limit", { sessionId });
            }
          }
        } finally {
          try {
            await prepared.dispose?.();
          } catch (cleanupError) {
            outcome = withCleanupFailure(outcome, cleanupError);
          }
        }
        return outcome;
      });
      serial = execution.then(() => undefined, () => undefined);
      return execution;
    },
  };
}
