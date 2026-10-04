/**
 * Headless CLI last hop (#645/#646/#820): spawn/parse/bind. Shared retry/resume
 * loop = external-host-turn-loop. Claude print-mode and codex exec share this
 * lifecycle; argv/parse are protocol-specific.
 */
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import type { RoleTurnHost, RoleTurnRequest, RoleTurnResult } from "../host-contracts.ts";
import { sessionDirectoryOf } from "../role-run-placement.ts";
import {
  createSerializedRoleTurnHost,
  driveExternalRoleTurnRounds,
  disposeExternalRoleTurn,
  externalHostFailure as failure,
  hostAbortedError,
  isHostAbortedError,
  recordTurnDelivery,
} from "../external-host-turn-loop.ts";
import { describeErrorIdentity } from "../public-cli/run-lifecycle.ts";
import { projectThrownFailureLeaf, retainPackageFault } from "../public-cli/settlement.ts";
import {
  renderSystemPromptOverride,
  resolveBoundHostSessionId,
  type PreparedRoleTurn,
  type SessionIdentityAuthority,
} from "../prepared-role-turn.ts";

import {
  copyAndRecordHostDossier,
  recordNativeSessionPointer,
} from "../host-session-record.ts";
import {
  closeJsonSchemaForCodex,
  codexTurnArgs,
  headlessMcpConfigDocument,
  headlessTurnArgs,
  isClaudePrintDescription,
  isCodexExecDescription,
  type HeadlessHostDescription,
} from "./description.ts";
import { NAVIGATOR_OUTPUT_TOOL_NAME } from "../package-contracts/navigator-output.ts";

import { errorText, isRecord } from "../unknown-value.ts";

export type HeadlessRoleTurnHostConfig = Readonly<{
  description: HeadlessHostDescription;
  sessionIdentity: SessionIdentityAuthority;
  /** Seat-table host key (e.g. claude) for sitian host field. */
  hostName: string;
  binary: string;
  prepare(request: RoleTurnRequest): Promise<PreparedRoleTurn>;
  env?: NodeJS.ProcessEnv;
}>;

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
  if (!isRecord(value)) return false;
  const record = value as HeadlessCliResult & { type?: unknown };
  return record.type === undefined
    || record.type === "result"
    || record.structured_output !== undefined;
}

/**
 * Parse the rolling result-candidate line retained by spawnHeadlessTurn.
 * The full stream is delivered live, not passed to this parser.
 */
export function parseHeadlessCliStdout(stdout: string): HeadlessCliResult | undefined {
  const trimmed = stdout.trim();
  if (trimmed === "") return undefined;
  try {
    const value = JSON.parse(trimmed) as unknown;
    return isHeadlessResultCandidate(value) ? value : undefined;
  } catch {
    return undefined;
  }
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
 * Only takes thread_id, final agent_message text, and terminal turn.failed.
 * Top-level `error` events are non-terminal (reconnect notices, skill budget
 * warnings); they must not poison a later turn.completed receipt.
 */
export type CodexExecTurnObservation = Readonly<{
  threadId?: string;
  /** Last `item.completed` agent_message text (final message / structured receipt). */
  finalMessage?: string;
  /** Present only for terminal `turn.failed` (not recoverable `error` events). */
  failureDiagnostic?: string;
  failureEvent?: Readonly<Record<string, unknown>>;
  turnCompleted: boolean;
}>;

function createCodexExecTurnObserver(): {
  readonly observe: (event: unknown) => void;
  readonly result: () => CodexExecTurnObservation;
} {
  let threadId: string | undefined;
  let finalMessage: string | undefined;
  let failureDiagnostic: string | undefined;
  let failureEvent: Readonly<Record<string, unknown>> | undefined;
  let turnCompleted = false;

  return {
    observe(value) {
      if (!isRecord(value)) return;
      const type = typeof value.type === "string" ? value.type : undefined;
      if (type === "thread.started" && typeof value.thread_id === "string" && value.thread_id !== "") {
        threadId = value.thread_id;
      } else if (type === "item.completed" && isRecord(value.item)) {
        if (value.item.type === "agent_message" && typeof value.item.text === "string") {
          finalMessage = value.item.text;
        }
      } else if (type === "turn.completed") {
        turnCompleted = true;
        failureDiagnostic = undefined;
        failureEvent = undefined;
      } else if (type === "turn.failed") {
        turnCompleted = false;
        failureEvent = value;
        failureDiagnostic = formatCodexFailurePayload(value.error ?? value);
      }
      // Top-level `error` is non-terminal; exit/receipt handling remains downstream.
    },
    result() {
      return {
        ...(threadId === undefined ? {} : { threadId }),
        ...(finalMessage === undefined ? {} : { finalMessage }),
        ...(failureDiagnostic === undefined ? {} : { failureDiagnostic }),
        ...(failureEvent === undefined ? {} : { failureEvent }),
        turnCompleted,
      };
    },
  };
}

function formatCodexFailurePayload(payload: unknown): string {
  if (typeof payload === "string" && payload.trim() !== "") return payload;
  if (isRecord(payload)) {
    if (typeof payload.message === "string" && payload.message.trim() !== "") return payload.message;
    try {
      return JSON.stringify(payload);
    } catch {
      return "codex turn failed";
    }
  }
  return String(payload);
}

/** cwd or an ancestor has a `.git` entry (file or directory). */
function cwdIsGitWorkTree(cwd: string): boolean {
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
 * When cwd is not a git work tree → undefined (caller skips extra roots).
 * When cwd is a git work tree, git non-zero / empty stdout / spawn failure
 * must fail loud with the real cause — never wash into "no common dir".
 */
function resolveGitCommonDir(cwd: string): string | undefined {
  if (!cwdIsGitWorkTree(cwd)) return undefined;
  let result: { status: number | null; stdout: string; stderr: string; error?: Error };
  try {
    result = spawnSync("git", ["rev-parse", "--git-common-dir"], {
      cwd,
      encoding: "utf8",
    });
  } catch (error) {
    const message = errorText(error);
    throw new Error(`git rev-parse --git-common-dir failed: ${message}`);
  }
  if (result.error !== undefined) {
    throw new Error(`git rev-parse --git-common-dir failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || `exit ${String(result.status)}`;
    throw new Error(`git rev-parse --git-common-dir failed: ${detail}`);
  }
  const raw = result.stdout.trim();
  if (raw === "") {
    throw new Error("git rev-parse --git-common-dir returned empty stdout");
  }
  return isAbsolute(raw) ? raw : resolve(cwd, raw);
}

function spawnHeadlessTurn(options: {
  readonly binary: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  /** User dialogue body; omitted from argv so execve cannot E2BIG (#879). */
  readonly stdin?: string;
  /** Called for each complete stdout line as it arrives (live stream-json). */
  readonly onStdoutLine?: (line: string) => void;
}): Promise<HeadlessSpawnResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(hostAbortedError("headless host aborted"));
      return;
    }
    const child = spawn(options.binary, [...options.args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (child.stdin === null) {
      reject(new Error("headless child stdin pipe was not created"));
      return;
    }
    let stdinDeliveryError: Error | undefined;
    child.stdin.on("error", (error) => {
      stdinDeliveryError ??= error;
    });
    if (options.stdin !== undefined) {
      child.stdin.write(options.stdin);
    }
    child.stdin.end();
    // Rolling retention only: last result-candidate line for final parse.
    // Live events go to sitian via onStdoutLine — never accumulate the full stream.
    let resultStdout = "";
    let stderr = "";
    let lineBuffer = "";
    let settled = false;
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    const packageErrors: unknown[] = [];
    let hasSpawned = false;
    child.once("spawn", () => { hasSpawned = true; });
    const emitStdoutLine = (line: string): void => {
      const candidate = resultCandidateText(line);
      if (candidate !== undefined) resultStdout = candidate;
      if (options.onStdoutLine === undefined) return;
      try {
        options.onStdoutLine(line);
      } catch (error) {
        packageErrors.push(error);
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
    const settle = (code: number | null, closeSignal: NodeJS.Signals | null): void => {
      if (settled) return;
      flushStdoutLines("", true);
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (stdinDeliveryError !== undefined) packageErrors.push(stdinDeliveryError);
      resolve({
        packageErrors,
        code,
        stdout: resultStdout,
        stderr,
        timedOut,
        ...(closeSignal === null ? {} : { signal: closeSignal }),
      });
    };
    const onAbort = (): void => {
      if (settled) return;
      child.kill("SIGTERM");
    };
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { flushStdoutLines(chunk, false); });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) return;
      if (hasSpawned) {
        packageErrors.push(error);
        return;
      }
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.on("close", (code, closeSignal) => {
      settle(code, closeSignal);
    });
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, options.timeoutMs);
    }
  });
}

type HeadlessSpawnResult = {
  code: number | null;
  signal?: string;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  packageErrors: readonly unknown[];
};

function signalField(spawned: { signal?: string }): { signal?: string } {
  return spawned.signal === undefined || spawned.signal.length === 0 ? {} : { signal: spawned.signal };
}

function deliveredFromSpawned(
  spawned: HeadlessSpawnResult,
): { readonly status: "delivered"; readonly stderr: string; readonly code: number | null; readonly timedOut: boolean; readonly signal?: string } {
  return {
    status: "delivered",
    stderr: spawned.stderr,
    code: spawned.code,
    timedOut: spawned.timedOut,
    ...signalField(spawned),
  };
}

function terminalFromSpawned(
  spawned: HeadlessSpawnResult,
  knownFailure?: RoleTurnResult["knownFailure"],
): { readonly status: "terminal"; readonly result: RoleTurnResult } {
  return {
    status: "terminal",
    result: {
      code: spawned.code,
      stderr: spawned.stderr,
      timedOut: spawned.timedOut,
      ...signalField(spawned),
      ...(knownFailure === undefined ? {} : { knownFailure }),
    },
  };
}

function buildTurnArgs(options: {
  readonly description: HeadlessHostDescription;
  readonly systemPromptPath: string;
  /** Open schema; omit for #959 navigator prose-exit seats. Codex does not receive a narrowed copy. */
  readonly jsonSchema?: Readonly<Record<string, unknown>>;
  readonly mcpServers: readonly Readonly<Record<string, unknown>>[];
  readonly mcpConfigPath?: string;
  readonly outputSchemaPath?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly sessionId: string | undefined;
  readonly sessionKind: "new" | "resume";
  readonly cwd: string;
  readonly writableRoots?: readonly string[];
}): readonly string[] {
  if (isCodexExecDescription(options.description)) {
    if (options.sessionKind === "resume" && !options.sessionId) {
      throw new Error("codex resume requires a bound thread_id");
    }
    // #959: prose-exit seats (navigator) omit --output-schema; other seats still require it.
    return codexTurnArgs({
      systemPromptPath: options.systemPromptPath,
      ...(options.outputSchemaPath === undefined ? {} : { outputSchemaPath: options.outputSchemaPath }),
      mcpServers: options.mcpServers,
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.effort === undefined ? {} : { effort: options.effort }),
      session: options.sessionKind === "resume"
        ? { kind: "resume", id: options.sessionId! }
        : { kind: "new" },
      skipGitRepoCheck: !cwdIsGitWorkTree(options.cwd),
      ...(!options.writableRoots?.length ? {} : { writableRoots: options.writableRoots }),
    });
  }

  if (!isClaudePrintDescription(options.description)) throw new Error("unsupported headless host protocol");
  if (!options.sessionId) throw new Error("claude print-mode requires a session id");
  if (options.mcpConfigPath === undefined) throw new Error("claude print-mode requires an MCP config path");
  return headlessTurnArgs({
    description: options.description,
    systemPromptPath: options.systemPromptPath,
    // #959: navigator omits --json-schema so free-form prose is a lawful exit.
    ...(options.jsonSchema === undefined ? {} : { jsonSchema: options.jsonSchema }),
    mcpConfigPath: options.mcpConfigPath,
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.effort === undefined ? {} : { effort: options.effort }),
    session: { kind: options.sessionKind, id: options.sessionId },
  });
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
      // Public explicit resume already read the stored native id. Auto-resume omits it.
      let sessionId = await resolveBoundHostSessionId(request, config.sessionIdentity);
      if (request.continuation.kind === "resume" && (sessionId === undefined || sessionId === "")) {
        outcome = failure(
          "session",
          "HeadlessSessionFailure",
          "session-id-missing",
          undefined,
          "resume requires a bound session id",
        );
      } else {
      let sessionKind: "new" | "resume" =
        request.continuation.kind === "resume" ? "resume" : "new";
      if (sessionKind === "new" && !codex) {
        sessionId = randomUUID();
        await config.sessionIdentity.bind(request.principal, sessionId);
      }

      // config.env owns package-root/child env; do not re-spread process.env over it.
      const env: NodeJS.ProcessEnv = { ...process.env, ...(config.env ?? {}) };
      // CLI start-up inputs (system prompt / schema / MCP config files) are not
      // dossier: they live in a throwaway directory, and what was delivered is
      // recorded once per actual start as a history.jsonl `turn-delivery` row.
      const sessionParent = config.sessionIdentity.resolveSessionFile(request.principal);
      const inputsDirectory = await mkdtemp(join(tmpdir(), "ak-role-headless-"));
      const systemPromptPath = join(inputsDirectory, "system-prompt.txt");
      let mcpConfigPath: string | undefined;
      let outputSchemaPath: string | undefined;
      let startedWithSchema: unknown;
      // A setup failure after mkdtemp must not leave the prompt material behind.
      try {
        await writeFile(systemPromptPath, systemPrompt, "utf8");
        let deliveredSchema: unknown;
        if (codex) {
          // #1148: Codex --output-schema requires a native strict transport schema.
          // Project from the unique open declaration; do not alter package receipt rules.
          if (prepared.terminatingToolName !== NAVIGATOR_OUTPUT_TOOL_NAME) {
            outputSchemaPath = join(inputsDirectory, "output-schema.json");
            deliveredSchema = closeJsonSchemaForCodex(prepared.jsonSchema);
            await writeFile(outputSchemaPath, `${JSON.stringify(deliveredSchema, null, 2)}\n`, "utf8");
          }
        } else {
          mcpConfigPath = join(inputsDirectory, "mcp-config.json");
          await writeFile(
            mcpConfigPath,
            `${JSON.stringify(headlessMcpConfigDocument(prepared.mcpServers), null, 2)}\n`,
            "utf8",
          );
          // #959: navigator prose exit — no closed JSON schema on claude either.
          if (prepared.terminatingToolName !== NAVIGATOR_OUTPUT_TOOL_NAME) deliveredSchema = prepared.jsonSchema;
        }
        startedWithSchema = deliveredSchema;
      } catch (setupError) {
        try {
          await rm(inputsDirectory, { recursive: true, force: true });
        } catch (cleanupError) {
          await retainPackageFault({
            runDirectory: request.runDirectory,
            diagnostic: `headless turn inputs cleanup failed beside setup failure: ${describeErrorIdentity(cleanupError)}`,
            error: cleanupError,
          });
        }
        throw setupError;
      }

      let exitedSessionId: string | undefined;
      try {
      outcome = await driveExternalRoleTurnRounds(prepared, request, {
        roundLimitName: "HeadlessRoundLimit",
        currentSessionId: () => sessionId,
        afterRetry() { sessionKind = "resume"; },
        async runRound({ prompt, abortSignal }) {
          let args: readonly string[];
          try {
            const gitCommonDir = codex ? resolveGitCommonDir(request.cwd) : undefined;
            args = buildTurnArgs({
              description: config.description,
              systemPromptPath,
              // #959: navigator prose exit — no closed JSON schema on claude either.
              ...(prepared.terminatingToolName === NAVIGATOR_OUTPUT_TOOL_NAME
                ? {}
                : { jsonSchema: prepared.jsonSchema }),
              mcpServers: prepared.mcpServers,
              ...(mcpConfigPath === undefined ? {} : { mcpConfigPath }),
              ...(outputSchemaPath === undefined ? {} : { outputSchemaPath }),
              ...(request.model?.model !== undefined ? { model: request.model.model } : {}),
              ...(request.model?.thinking !== undefined ? { effort: request.model.thinking } : {}),
              sessionId,
              sessionKind,
              cwd: request.cwd,
              ...(gitCommonDir === undefined ? {} : { writableRoots: [gitCommonDir] }),
            });
          } catch (error) {
            const message = errorText(error);
            return {
              status: "terminal",
              result: failure("session", "HeadlessArgvFailure", "argv-failed", { diagnostic: message }, message),
            };
          }

          const codexObserver = codex ? createCodexExecTurnObserver() : undefined;
          let pointerRecorded = false;
          let codexIdObserved = false;
          if (sessionId !== undefined && sessionId !== "") {
            pointerRecorded = recordNativeSessionPointer({
              host: config.hostName,
              sessionId,
              cwd: request.cwd,
              sessionParent,
              home: request.home,
            }) !== undefined;
          }

          // What this CLI start was given: one history record per start.
          await recordTurnDelivery(request.runDirectory, {
            systemPrompt,
            ...(startedWithSchema === undefined ? {} : { outputSchema: startedWithSchema }),
          }, "headless-host");
          let spawned: HeadlessSpawnResult;
          try {
            spawned = await spawnHeadlessTurn({
              binary: config.binary,
              args,
              cwd: request.cwd,
              env,
              stdin: prompt,
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
                // One bounded live seam owns both recording and host-specific reduction.
                codexObserver?.observe(event);
                if (!codex && typeof event === "object" && event !== null && "session_id" in event
                  && typeof event.session_id === "string" && event.session_id !== "" && event.session_id !== sessionId) {
                  sessionId = event.session_id;
                  recordNativeSessionPointer({ host: config.hostName, sessionId, cwd: request.cwd, sessionParent, home: request.home });
                }
                if (codex && !codexIdObserved) {
                  const tid = codexObserver?.result().threadId;
                  if (tid !== undefined && tid !== "") {
                    codexIdObserved = true;
                    pointerRecorded = recordNativeSessionPointer({
                      host: config.hostName,
                      sessionId: tid,
                      cwd: request.cwd,
                      sessionParent,
                      home: request.home,
                    }) !== undefined;
                  }
                }
              },
            });
            const roundSessionId = (codex ? codexObserver?.result().threadId : undefined) ?? sessionId;
            exitedSessionId = roundSessionId;
            if (codex && roundSessionId !== undefined && roundSessionId !== "" && !pointerRecorded) {
              try {
                recordNativeSessionPointer({ host: config.hostName, sessionId: roundSessionId, cwd: request.cwd, sessionParent, home: request.home });
              } catch (error) {
                spawned.packageErrors = [...spawned.packageErrors, error];
              }
            }
          } catch (error) {
            if (isHostAbortedError(error)) throw error;
            const message = errorText(error);
            return {
              status: "terminal",
              result: failure("activation", "HeadlessSpawnFailure", "spawn-failed", {
                diagnostic: message,
                binary: config.binary,
              }, message),
            };
          }

          for (const error of spawned.packageErrors) {
            await retainPackageFault({
              runDirectory: request.runDirectory,
              diagnostic: `headless transport handling failed beside host terminal: ${describeErrorIdentity(error)}`,
              error,
            });
          }

          try {
          const noteBeside = async (error: unknown, what: string): Promise<void> => {
            await retainPackageFault({
              runDirectory: request.runDirectory,
              diagnostic: `${what}: ${describeErrorIdentity(error)}`,
              error,
            });
          };

          if (codex) {
            const observation = codexObserver!.result();
            // #987 result 6 / 失败诚实: host-reported failure wins over a package
            // missing-thread-id label. A bind error is a separate package fault.
            if (observation.threadId !== undefined && observation.threadId !== "") {
              sessionId = observation.threadId;
              try {
                await config.sessionIdentity.bind(request.principal, observation.threadId);
              } catch (error) {
                if (observation.failureDiagnostic === undefined) throw error;
                await noteBeside(error, "session bind failed beside host terminal");
              }
            }

            if (observation.failureDiagnostic !== undefined) {
              return terminalFromSpawned(spawned, {
                diagnostic: observation.failureDiagnostic,
                ...(observation.failureEvent === undefined ? {} : { details: observation.failureEvent }),
              });
            }

            const navigator = prepared.terminatingToolName === NAVIGATOR_OUTPUT_TOOL_NAME;
            const deliverReply = async (): Promise<ReturnType<typeof deliveredFromSpawned> | undefined> => {
              if (!observation.turnCompleted || observation.finalMessage === undefined) return undefined;
              if (navigator) {
                if (observation.finalMessage.trim() === "") return undefined;
                await prepared.ingestStructuredOutput({ prose: observation.finalMessage });
                return deliveredFromSpawned(spawned);
              }
              let receipt: unknown;
              try {
                receipt = JSON.parse(observation.finalMessage);
              } catch (error) {
                await noteBeside(error, "native receipt JSON could not be read");
                return undefined;
              }
              await prepared.ingestStructuredOutput(receipt);
              return deliveredFromSpawned(spawned);
            };

            // Absence of a reply is not a host-stated reason for failure.
            // Delivery and exit facts are independent on every exit path.
            return await deliverReply() ?? terminalFromSpawned(spawned);
          }

          // Claude print-mode path.
          const envelope = parseHeadlessCliStdout(spawned.stdout);
          if (envelope === undefined) return terminalFromSpawned(spawned);

          const hostReportedFailure = envelope.is_error === true
            || (typeof envelope.subtype === "string" && envelope.subtype.startsWith("error_"));
          // Required binding fails a clean result; an actual host error stays primary.
          if (typeof envelope.session_id === "string" && envelope.session_id !== "") {
            sessionId = envelope.session_id;
            try {
              await config.sessionIdentity.bind(request.principal, sessionId);
            } catch (error) {
              if (!hostReportedFailure) throw error;
              await noteBeside(error, "session bind failed beside host terminal");
            }
          }

          if (hostReportedFailure) {
            const diagnostic = typeof envelope.result === "string"
              ? envelope.result
              : Array.isArray(envelope.errors)
                ? JSON.stringify(envelope.errors)
                : spawned.stderr.length > 0 ? spawned.stderr : "headless CLI reported is_error";
            return terminalFromSpawned(spawned, {
              diagnostic,
              details: envelope,
            });
          }

          if (envelope.structured_output !== undefined) {
            await prepared.ingestStructuredOutput(envelope.structured_output);
          } else if (
            prepared.terminatingToolName === NAVIGATOR_OUTPUT_TOOL_NAME
            && typeof envelope.result === "string"
            && envelope.result.trim() !== ""
          ) {
            // #959: claude prose exit — free-form result text is the receipt body
            // when structured_output is absent (json-schema omitted for navigator).
            await prepared.ingestStructuredOutput({ prose: envelope.result });
          }
          return deliveredFromSpawned(spawned);
          } catch (error) {
            await retainPackageFault({
              runDirectory: request.runDirectory,
              diagnostic: `required turn handling failed beside host terminal: ${describeErrorIdentity(error)}`,
              error,
            });
            return terminalFromSpawned(spawned,
              spawned.code === 0 && !spawned.timedOut && spawned.signal === undefined
                ? projectThrownFailureLeaf(error)
                : undefined);
          }
        },
      });
      } finally {
        try {
          await rm(inputsDirectory, { recursive: true, force: true });
        } catch (error) {
          await retainPackageFault({
            runDirectory: request.runDirectory,
            diagnostic: `headless turn inputs cleanup failed beside host terminal: ${describeErrorIdentity(error)}`,
            error,
          });
        }
        try {
          if (exitedSessionId !== undefined && exitedSessionId !== "") copyAndRecordHostDossier({
            host: config.hostName, sessionId: exitedSessionId, cwd: request.cwd,
            sessionDirectory: sessionDirectoryOf(request.runDirectory), sessionParent,
            ...(request.home !== undefined ? { home: request.home } : {}),
          });
        } catch (error) {
          await retainPackageFault({
            runDirectory: request.runDirectory,
            diagnostic: `host dossier copy failed beside host terminal: ${describeErrorIdentity(error)}`,
            error,
          });
        }
      }
      }
    } finally {
      outcome = await disposeExternalRoleTurn(prepared, request, outcome);
    }
    return outcome;
  });
}
