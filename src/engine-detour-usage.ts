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
 * Invocation scope is one public ak-role call (#537). Auto-resume attempts inside
 * that call share the same scope; only an explicit new public call (including
 * `ak-role resume`) mints a new one. Never courtAttemptId and never Pi session
 * toolResult join keys.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  /** Public-invocation scope id. Binds write + settlement filter. */
  readonly invocationScopeId?: string;
};

/** Deterministic sitian identity: run + invocation scope + toolCallId (not bare toolCallId). */
export function engineDetourCallIdentity(input: {
  readonly toolCallId: string;
  readonly runId?: string;
  readonly invocationScopeId?: string;
}): string {
  const run = input.runId ?? "";
  const scope = input.invocationScopeId ?? "";
  return `engine-detour-call:${run}:${scope}:${input.toolCallId}`;
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
  if (input.invocationScopeId !== undefined) {
    payload.invocationScopeId = input.invocationScopeId;
  }
  if (input.runId !== undefined) payload.runId = input.runId;

  // SitianSubject object form requires runId; invocation scope rides payload always.
  const subject =
    input.runId === undefined
      ? undefined
      : {
          runId: input.runId,
          ...(input.invocationScopeId === undefined
            ? {}
            : { invocationScopeId: input.invocationScopeId }),
        };

  const pointer = sitianReport({
    level: "event",
    kind: ENGINE_DETOUR_CALL_KIND,
    identity: engineDetourCallIdentity({
      toolCallId: input.toolCallId,
      ...(input.runId === undefined ? {} : { runId: input.runId }),
      ...(input.invocationScopeId === undefined
        ? {}
        : { invocationScopeId: input.invocationScopeId }),
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

function invocationScopeIdOfRecord(record: {
  readonly subject?: unknown;
  readonly payload?: unknown;
}): string | undefined {
  if (isRecord(record.subject)) {
    const fromSubject = record.subject.invocationScopeId;
    if (typeof fromSubject === "string" && fromSubject.length > 0) return fromSubject;
  }
  if (isRecord(record.payload)) {
    const fromPayload = record.payload.invocationScopeId;
    if (typeof fromPayload === "string" && fromPayload.length > 0) return fromPayload;
  }
  return undefined;
}

/**
 * Read this-invocation detour-tool usage from sitian volume.
 * When `invocationScopeId` is provided, only records bound to that public call count
 * (host-neutral boundary — not session toolResult join keys, not courtAttemptId).
 * When engineMounted is false, returns undefined (field absent).
 * When engineMounted is true and no calls, returns callCount 0.
 */
export async function readEngineDetourToolUsage(input: {
  readonly sessionParent: string;
  readonly engineMounted: boolean;
  readonly invocationScopeId?: string;
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
    const boundScope = invocationScopeIdOfRecord(record);
    if (input.invocationScopeId !== undefined && input.invocationScopeId.length > 0) {
      if (boundScope !== input.invocationScopeId) continue;
    } else if (boundScope !== undefined) {
      // Unscoped settlement must not pull invocation-bound rows across resume.
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

/** One shared invocation.json reader (ENOENT → undefined; other errors propagate). */
function readInvocationRecord(
  runDirectory: string,
): Record<string, unknown> | undefined {
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
  const raw = readInvocationRecord(runDirectory);
  if (raw === undefined) return false;
  return typeof raw.engine === "string" && raw.engine.trim() !== "";
}

/**
 * Selected host from admission invocation (host axis). Undefined when absent —
 * callers must not invent "pi".
 */
export function readInvocationSelectedHost(runDirectory: string): string | undefined {
  const raw = readInvocationRecord(runDirectory);
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
 * Minted once per ak-role call (including explicit resume); all in-place
 * auto-resume dispatches of that call reuse it. Not courtAttemptId.
 */
const ENGINE_DETOUR_INVOCATION_SCOPE_FILE = "engine-detour-invocation-scope";

function engineDetourInvocationScopePath(runDirectory: string): string {
  return join(runDirectory, "session", ENGINE_DETOUR_INVOCATION_SCOPE_FILE);
}

/** Write the current public-invocation detour scope. */
export function writeEngineDetourInvocationScope(
  runDirectory: string,
  invocationScopeId: string,
): void {
  const path = engineDetourInvocationScopePath(runDirectory);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${invocationScopeId}\n`, "utf8");
}

/** Read the current public-invocation detour scope, if present. */
export function readEngineDetourInvocationScope(
  runDirectory: string,
): string | undefined {
  try {
    const text = readFileSync(engineDetourInvocationScopePath(runDirectory), "utf8").trim();
    return text.length > 0 ? text : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * Bind one invocation-scope id for this public call when an engine is mounted.
 * Call once at the public-entry boundary — never inside the auto-resume loop.
 */
export function bindEngineDetourInvocationScope(input: {
  readonly runDirectory: string;
  readonly effectiveEngine?: string;
}): string | undefined {
  const engine = input.effectiveEngine?.trim();
  if (engine === undefined || engine.length === 0) return undefined;
  const invocationScopeId = randomUUID();
  writeEngineDetourInvocationScope(input.runDirectory, invocationScopeId);
  return invocationScopeId;
}
