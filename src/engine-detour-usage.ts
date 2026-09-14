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
 */
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
  readonly host?: string;
  readonly runId?: string;
};

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

  const pointer = sitianReport({
    level: "event",
    kind: ENGINE_DETOUR_CALL_KIND,
    identity: `engine-detour-call:${input.toolCallId}`,
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
    ...(input.runId === undefined
      ? {}
      : { subject: { runId: input.runId } }),
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

/** Attempt-start index: latest top-level user message (resume boundary). */
export function attemptStartIndex(
  entries: readonly { readonly type?: string; readonly message?: { readonly role?: string } }[],
): number {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry?.type === "message" && entry.message?.role === "user") return i;
  }
  return 0;
}

/** toolCallIds for ak_engine_detour toolResults in the current attempt window. */
export function currentAttemptEngineDetourToolCallIds(
  entries: readonly {
    readonly type?: string;
    readonly message?: {
      readonly role?: string;
      readonly toolName?: string;
      readonly toolCallId?: string;
    };
  }[],
): ReadonlySet<string> {
  const start = attemptStartIndex(entries);
  const ids = new Set<string>();
  for (let i = start; i < entries.length; i += 1) {
    const message = entries[i]?.message;
    if (message?.role !== "toolResult") continue;
    if (message.toolName !== ENGINE_DETOUR_TOOL_NAME) continue;
    if (typeof message.toolCallId === "string" && message.toolCallId.length > 0) {
      ids.add(message.toolCallId);
    }
  }
  return ids;
}

/**
 * Read this-invocation detour-tool usage from sitian volume.
 * When `attemptToolCallIds` is provided, only those calls count (resume boundary).
 * When engineMounted is false, returns undefined (field absent).
 * When engineMounted is true and no calls, returns callCount 0.
 */
export async function readEngineDetourToolUsage(input: {
  readonly sessionParent: string;
  readonly engineMounted: boolean;
  readonly attemptToolCallIds?: ReadonlySet<string>;
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
    const pointer: RecordPointer = {
      identity: record.identity,
      recordFile,
      kind: record.kind,
      level: record.level,
    };
    const fact = callFactFromSitianPayload(record.payload, pointer);
    if (fact === undefined) continue;
    if (
      input.attemptToolCallIds !== undefined
      && !input.attemptToolCallIds.has(fact.toolCallId)
    ) {
      continue;
    }
    calls.push(fact);
  }

  return { callCount: calls.length, calls };
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
