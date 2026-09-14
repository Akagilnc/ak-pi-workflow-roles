/**
 * #537 typed ak_engine_detour tool usage ledger.
 *
 * Observes only the package detour tool path. Bash/CLI ordinary path
 * (resources/engine-dispatch.md ordinary path) stays outside this ledger — a
 * permanent blind spot that must never be read as "the seat did not use an engine".
 *
 * Runtime owns these facts beside role payloads (ADR 0042); they land in
 * TerminalResult.decisiveFacts and are written live via sitian (ADR 0077).
 * No gate, no required field, no index bytes (ADR 0049 / 0057).
 *
 * Attempt scope is the shared host-neutral courtAttemptId / invocation identity
 * bound at write time — never Pi session.jsonl toolResult join keys.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { ENGINE_DETOUR_TOOL_NAME } from "./engine-detour.ts";
import {
  readSitianRecords,
  resolveSitianRecordPath,
  sitianReport,
  type RecordPointer,
} from "./sitian-facade.ts";

/** Sitian event kind for one detour-tool call (volume under session/). */
export const ENGINE_DETOUR_CALL_KIND = "engine-detour-call" as const;

/** decisiveFacts key — name states detour-tool scope, not full engine usage. */
export const ENGINE_DETOUR_TOOL_USAGE_FACT_KEY = "engineDetourToolUsage" as const;

/** stdout UTF-8 byte length (ticket-frozen metric; empty stdout is real 0). */
export function engineDetourStdoutByteLength(stdout: string): number {
  return Buffer.byteLength(stdout, "utf8");
}

/** One observed ak_engine_detour call. code/stdoutByteLength absent on spawn failure. */
export type EngineDetourCallFact = {
  readonly toolCallId: string;
  readonly durationMs: number;
  readonly code?: number;
  readonly stdoutByteLength?: number;
  readonly recordPointer: Readonly<RecordPointer>;
};

/**
 * Per-invocation aggregate for the detour tool only.
 * callCount 0 is lawful when engine is mounted (ADR 0071 soft rule).
 */
export type EngineDetourToolUsageFact = {
  readonly callCount: number;
  readonly calls: readonly EngineDetourCallFact[];
};

export type ReportEngineDetourCallInput = {
  readonly toolCallId: string;
  readonly durationMs: number;
  /** Present only when the child closed (not spawn failure). */
  readonly code?: number;
  /** Present only when the child closed; empty stdout → 0. */
  readonly stdoutByteLength?: number;
  readonly cwd: string;
  readonly sessionParent: string;
  readonly home?: string;
  /** Real selected host (ADR 0077 / 0082). Never invent "pi". */
  readonly host?: string;
  readonly runId?: string;
  /** Host-neutral attempt identity (courtAttemptId). Binds write + settlement filter. */
  readonly attemptId?: string;
};

/** Deterministic sitian identity: run + attempt + toolCallId (not bare toolCallId). */
export function engineDetourCallIdentity(input: {
  readonly toolCallId: string;
  readonly runId?: string;
  readonly attemptId?: string;
}): string {
  const run = input.runId ?? "";
  const attempt = input.attemptId ?? "";
  return `engine-detour-call:${run}:${attempt}:${input.toolCallId}`;
}

/** Live sitian write for one detour call. Returns the call fact with pointer. */
export function reportEngineDetourCall(
  input: ReportEngineDetourCallInput,
): EngineDetourCallFact {
  const payload: Record<string, unknown> = {
    tool: ENGINE_DETOUR_TOOL_NAME,
    toolCallId: input.toolCallId,
    durationMs: input.durationMs,
  };
  if (input.code !== undefined) payload.code = input.code;
  if (input.stdoutByteLength !== undefined) {
    payload.stdoutByteLength = input.stdoutByteLength;
  }
  if (input.attemptId !== undefined) payload.attemptId = input.attemptId;
  if (input.runId !== undefined) payload.runId = input.runId;

  // SitianSubject object form requires runId; attemptId rides payload always.
  const subject =
    input.runId === undefined
      ? undefined
      : {
          runId: input.runId,
          ...(input.attemptId === undefined ? {} : { attemptId: input.attemptId }),
        };

  const pointer = sitianReport({
    level: "event",
    kind: ENGINE_DETOUR_CALL_KIND,
    identity: engineDetourCallIdentity({
      toolCallId: input.toolCallId,
      ...(input.runId === undefined ? {} : { runId: input.runId }),
      ...(input.attemptId === undefined ? {} : { attemptId: input.attemptId }),
    }),
    cwd: input.cwd,
    sessionParent: input.sessionParent,
    source: "engine-detour-tool",
    payload,
    raw: {
      sessionFile: input.sessionParent,
      entryId: input.toolCallId,
    },
    ...(input.home === undefined ? {} : { home: input.home }),
    ...(input.host === undefined ? {} : { host: input.host }),
    ...(subject === undefined ? {} : { subject }),
  });

  return {
    toolCallId: input.toolCallId,
    durationMs: input.durationMs,
    ...(input.code === undefined ? {} : { code: input.code }),
    ...(input.stdoutByteLength === undefined
      ? {}
      : { stdoutByteLength: input.stdoutByteLength }),
    recordPointer: pointer,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function callFactFromSitianPayload(
  payload: unknown,
  pointer: RecordPointer,
): EngineDetourCallFact | undefined {
  if (!isRecord(payload)) return undefined;
  if (payload.tool !== ENGINE_DETOUR_TOOL_NAME) return undefined;
  if (typeof payload.toolCallId !== "string" || payload.toolCallId.length === 0) {
    return undefined;
  }
  if (typeof payload.durationMs !== "number" || !Number.isFinite(payload.durationMs)) {
    return undefined;
  }
  return {
    toolCallId: payload.toolCallId,
    durationMs: payload.durationMs,
    ...(typeof payload.code === "number" ? { code: payload.code } : {}),
    ...(typeof payload.stdoutByteLength === "number"
      ? { stdoutByteLength: payload.stdoutByteLength }
      : {}),
    recordPointer: pointer,
  };
}

function attemptIdOfRecord(record: {
  readonly subject?: unknown;
  readonly payload?: unknown;
}): string | undefined {
  if (isRecord(record.subject)) {
    const fromSubject = record.subject.attemptId;
    if (typeof fromSubject === "string" && fromSubject.length > 0) return fromSubject;
  }
  if (isRecord(record.payload)) {
    const fromPayload = record.payload.attemptId;
    if (typeof fromPayload === "string" && fromPayload.length > 0) return fromPayload;
  }
  return undefined;
}

/**
 * Read this-invocation detour-tool usage from sitian volume.
 * When `attemptId` is provided, only records bound to that attempt count
 * (host-neutral resume boundary — not session toolResult join keys).
 * When engineMounted is false, returns undefined (field absent).
 * When engineMounted is true and no calls, returns callCount 0.
 */
export async function readEngineDetourToolUsage(input: {
  readonly sessionParent: string;
  readonly engineMounted: boolean;
  readonly attemptId?: string;
  readonly home?: string;
  readonly cwd?: string;
}): Promise<EngineDetourToolUsageFact | undefined> {
  if (!input.engineMounted) return undefined;

  const { recordFile } = resolveSitianRecordPath({
    level: "event",
    kind: ENGINE_DETOUR_CALL_KIND,
    sessionParent: input.sessionParent,
    ...(input.home === undefined ? {} : { home: input.home }),
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
  });

  const { records } = await readSitianRecords(recordFile);
  const calls: EngineDetourCallFact[] = [];
  for (const record of records) {
    if (record.kind !== ENGINE_DETOUR_CALL_KIND) continue;
    const boundAttempt = attemptIdOfRecord(record);
    if (input.attemptId !== undefined && input.attemptId.length > 0) {
      if (boundAttempt !== input.attemptId) continue;
    } else if (boundAttempt !== undefined) {
      // Unscoped settlement must not pull attempt-bound rows across resume.
      continue;
    }
    const pointer: RecordPointer = {
      identity: record.identity,
      recordFile,
      kind: record.kind,
      level: record.level,
    };
    const fact = callFactFromSitianPayload(record.payload, pointer);
    if (fact === undefined) continue;
    calls.push(fact);
  }

  return { callCount: calls.length, calls };
}

/**
 * Resumable public Terminal must not re-disclose run ID via recordFile paths
 * (settlement #108 / terminal privacy). Identity stays for reconcilability.
 */
export function projectEngineDetourToolUsageForPublicTerminal(
  usage: EngineDetourToolUsageFact,
  options: { readonly discloseRecordFile: boolean },
): EngineDetourToolUsageFact {
  if (options.discloseRecordFile) return usage;
  return {
    callCount: usage.callCount,
    calls: usage.calls.map((call) => ({
      toolCallId: call.toolCallId,
      durationMs: call.durationMs,
      ...(call.code === undefined ? {} : { code: call.code }),
      ...(call.stdoutByteLength === undefined
        ? {}
        : { stdoutByteLength: call.stdoutByteLength }),
      recordPointer: {
        identity: call.recordPointer.identity,
        kind: call.recordPointer.kind,
        level: call.recordPointer.level,
        recordFile: "",
      },
    })),
  };
}

function invocationRecord(runDirectory: string): Record<string, unknown> | undefined {
  try {
    const raw = JSON.parse(
      readFileSync(join(runDirectory, "invocation.json"), "utf8"),
    ) as unknown;
    return isRecord(raw) ? raw : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
    throw error;
  }
}

/** True when invocation.json carries a non-empty engine axis. */
export async function readInvocationEngineMounted(
  runDirectory: string,
): Promise<boolean> {
  try {
    const raw = JSON.parse(
      await readFile(join(runDirectory, "invocation.json"), "utf8"),
    ) as unknown;
    if (!isRecord(raw)) return false;
    return typeof raw.engine === "string" && raw.engine.trim() !== "";
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Selected host from admission invocation (host axis). Undefined when absent —
 * callers must not invent "pi".
 */
export function readInvocationSelectedHost(runDirectory: string): string | undefined {
  const raw = invocationRecord(runDirectory);
  if (raw === undefined) return undefined;
  return typeof raw.host === "string" && raw.host.trim() !== ""
    ? raw.host.trim()
    : undefined;
}

/** Merge usage into decisiveFacts without touching role payloads. */
export function withEngineDetourToolUsageFact<
  T extends { readonly decisiveFacts?: Readonly<Record<string, unknown>> },
>(
  outcome: T,
  usage: EngineDetourToolUsageFact | undefined,
): T {
  if (usage === undefined) return outcome;
  const prior = isRecord(outcome.decisiveFacts) ? outcome.decisiveFacts : {};
  return {
    ...outcome,
    decisiveFacts: {
      ...prior,
      [ENGINE_DETOUR_TOOL_USAGE_FACT_KEY]: usage,
    },
  };
}

/** runDirectory owning a session directory (.../runs/<id>@role/session). */
export function runDirectoryFromSessionDirectory(sessionDirectory: string): string {
  return dirname(sessionDirectory);
}

/** session.jsonl under a session directory. */
export function sessionFileFromSessionDirectory(sessionDirectory: string): string {
  return join(sessionDirectory, "session.jsonl");
}

/**
 * Per public-invocation detour scope (#537).
 * Minted once per ak-role dispatch (resume = new invocation); binds sitian
 * writes and settlement filter. Not courtAttemptId — open-court resume may
 * reuse court id while still being a new counting unit.
 */
const ENGINE_DETOUR_ATTEMPT_SCOPE_FILE = "engine-detour-attempt-id";

function engineDetourAttemptScopePath(runDirectory: string): string {
  return join(runDirectory, "session", ENGINE_DETOUR_ATTEMPT_SCOPE_FILE);
}

/** Write the current public-invocation detour scope (call at dispatch boundary). */
export function writeEngineDetourAttemptScope(
  runDirectory: string,
  attemptId: string,
): void {
  const path = engineDetourAttemptScopePath(runDirectory);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${attemptId}\n`, "utf8");
}

/** Read the current public-invocation detour scope, if present. */
export function readEngineDetourAttemptScope(
  runDirectory: string,
): string | undefined {
  try {
    const text = readFileSync(engineDetourAttemptScopePath(runDirectory), "utf8").trim();
    return text.length > 0 ? text : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
    throw error;
  }
}
