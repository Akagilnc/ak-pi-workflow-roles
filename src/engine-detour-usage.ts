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
 * Invocation scope is one public ak-role call (#537), owned by the shared Host
 * execution envelope (RoleTurnRequest / HostContext). Auto-resume attempts inside
 * that call share the same scope; only an explicit new public call (including
 * `ak-role resume`) mints a new one. Never courtAttemptId, never Pi session
 * toolResult join keys, and never a detour-owned sidecar file.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
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

/**
 * Run-relative sitian volume path for one detour call.
 * Openable once the run directory is known (resume.command / top-level runId);
 * contains no runId bytes itself (#108 + #537 AC8).
 */
export const ENGINE_DETOUR_CALL_RECORD_FILE_RELATIVE =
  `session/${ENGINE_DETOUR_CALL_KIND}/records.jsonl` as const;

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
  /** Public-invocation scope id from the shared Host envelope. */
  readonly invocationScopeId?: string;
};

/**
 * Deterministic sitian identity: invocation scope + toolCallId.
 * Must not embed runId — public Terminal decisiveFacts re-expose identity (#108).
 */
export function engineDetourCallIdentity(input: {
  readonly toolCallId: string;
  readonly invocationScopeId?: string;
}): string {
  const scope = input.invocationScopeId ?? "";
  return `engine-detour-call:${scope}:${input.toolCallId}`;
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
  const callsByToolCallId = new Map<string, EngineDetourCallFact>();
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
    // ADR 0086: Reader deduplicates by toolCallId within the invocation scope
    callsByToolCallId.set(fact.toolCallId, fact);
  }

  const calls = Array.from(callsByToolCallId.values());
  return { callCount: calls.length, calls };
}

/**
 * Project usage onto the public Terminal face.
 * Non-resumable: keep absolute recordFile (runId already public via top-level runId).
 * Resumable: keep an openable run-relative recordFile and identity with no runId
 * bytes (#108 single disclosure + #537 AC8 reopen).
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
        recordFile: ENGINE_DETOUR_CALL_RECORD_FILE_RELATIVE,
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
 * Selected host from the admission invocation page — for post-admission
 * host-transition classification only. In-turn tools take host from the shared
 * Host envelope (RoleTurnRequest / HostContext), never this reader.
 * Undefined when absent — callers must not invent "pi".
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
 * Mint one public-invocation scope id when an engine is mounted.
 * Call once at the public-entry boundary — never inside the auto-resume loop.
 * The id lives on RoleTurnRequest / HostContext only (no detour sidecar file).
 */
export function mintEngineDetourInvocationScope(input: {
  readonly effectiveEngine?: string;
}): string | undefined {
  const engine = input.effectiveEngine?.trim();
  if (engine === undefined || engine.length === 0) return undefined;
  return randomUUID();
}

/** Attach a minted scope onto a turn request (shared Host envelope field). */
export function withEngineDetourInvocationScope<T extends object>(
  request: T & { readonly invocationScopeId?: string },
  invocationScopeId: string | undefined,
): T & { readonly invocationScopeId?: string } {
  if (invocationScopeId === undefined || invocationScopeId.length === 0) {
    return request;
  }
  if (
    typeof request.invocationScopeId === "string" &&
    request.invocationScopeId.length > 0
  ) {
    return request;
  }
  return { ...request, invocationScopeId };
}
