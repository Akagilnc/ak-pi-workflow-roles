import { writeSync } from "node:fs";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

import { writeStderrJsonlRecord } from "./stderr-jsonl.ts";

/** Mandatory coalesce window for tool_execution_update heartbeats (stderr is bounded). */
export const TOOL_EXECUTION_UPDATE_THROTTLE_MS = 30_000;

/**
 * Heartbeat basis for downstream silence predicates.
 *
 * Production Pi `bash.js` calls `onUpdate` once with empty content at execute entry,
 * then schedules output-driven updates at ~100 ms. This face skips non-producing
 * (empty-content) updates so the first heartbeat is real child output, then
 * coalesces at {@link TOOL_EXECUTION_UPDATE_THROTTLE_MS}.
 *
 * If a future host path stopped delivering output-driven updates, change this to
 * `"duration-only"` and document that silence predicates degrade to pure duration.
 */
export const TOOL_EXECUTION_UPDATE_HEARTBEAT = "output-driven" as const;

const observationBase = {
  role: Type.String({ minLength: 1 }),
  toolCallId: Type.String({ minLength: 1 }),
  toolName: Type.String({ minLength: 1 }),
  timestamp: Type.String({ format: "date-time" }),
} as const;

export const toolExecutionObservationRecordSchema = Type.Union([
  Type.Object({
    ...observationBase,
    event: Type.Literal("tool_execution_start"),
  }, { additionalProperties: true }),
  Type.Object({
    ...observationBase,
    event: Type.Literal("tool_execution_update"),
  }, { additionalProperties: true }),
  Type.Object({
    ...observationBase,
    event: Type.Literal("tool_execution_end"),
    isError: Type.Boolean(),
  }, { additionalProperties: true }),
]);

export type ToolExecutionObservationRecord = Static<typeof toolExecutionObservationRecordSchema>;
export type ToolExecutionObservationWriter = (record: ToolExecutionObservationRecord) => void | Promise<void>;

export function validateToolExecutionObservationRecord(record: unknown): ToolExecutionObservationRecord {
  if (!Value.Check(toolExecutionObservationRecordSchema, record)) {
    throw new TypeError("Tool execution observation record does not match its contract");
  }
  return record as ToolExecutionObservationRecord;
}

export function writeToolExecutionObservationRecord(
  record: ToolExecutionObservationRecord,
  write: typeof writeSync = writeSync,
): void {
  writeStderrJsonlRecord(validateToolExecutionObservationRecord(record), write);
}

/** True when a tool_execution_update partialResult carries producing content (not bash's empty entry callback). */
export function isProducingToolUpdate(partialResult: unknown): boolean {
  if (partialResult == null) return false;
  if (typeof partialResult !== "object") return true;
  const content = (partialResult as { content?: unknown }).content;
  if (!Array.isArray(content)) return true;
  if (content.length === 0) return false;
  return content.some((part) => {
    if (typeof part !== "object" || part === null) return true;
    const text = (part as { text?: unknown }).text;
    if (typeof text === "string") return text.length > 0;
    return true;
  });
}

type CallObservationState = {
  lastUpdateEmitMonoMs: number | undefined;
};

export type ToolExecutionObservationFace = {
  onStart(event: { toolCallId: string; toolName: string }): void | Promise<void>;
  onUpdate(event: { toolCallId: string; toolName: string; partialResult: unknown }): void | Promise<void>;
  onEnd(event: { toolCallId: string; toolName: string; isError: boolean }): void | Promise<void>;
  reset(): void;
};

/**
 * Production throttle clock: genuinely monotonic milliseconds.
 * Wall-clock Date.now() is not safe — NTP/slew can compress two heartbeats under 30s.
 */
export function systemToolExecutionObservationMonoNow(): number {
  return performance.now();
}

export function createToolExecutionObservationFace(options: {
  role: () => string | undefined;
  admitted: () => boolean;
  clock(): string;
  monoNow(): number;
  write(record: ToolExecutionObservationRecord): void | Promise<void>;
}): ToolExecutionObservationFace {
  const states = new Map<string, CallObservationState>();

  async function emit(record: unknown): Promise<void> {
    await options.write(validateToolExecutionObservationRecord(record));
  }

  function activeRole(): string | undefined {
    if (!options.admitted()) return undefined;
    const role = options.role();
    return role === undefined || role === "" ? undefined : role;
  }

  return {
    reset() {
      states.clear();
    },
    async onStart(event) {
      const role = activeRole();
      if (role === undefined) return;
      states.set(event.toolCallId, { lastUpdateEmitMonoMs: undefined });
      await emit({
        event: "tool_execution_start",
        role,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        timestamp: options.clock(),
      });
    },
    async onUpdate(event) {
      const role = activeRole();
      if (role === undefined) return;
      if (!isProducingToolUpdate(event.partialResult)) return;
      const now = options.monoNow();
      const state = states.get(event.toolCallId) ?? { lastUpdateEmitMonoMs: undefined };
      if (
        state.lastUpdateEmitMonoMs !== undefined
        && now - state.lastUpdateEmitMonoMs < TOOL_EXECUTION_UPDATE_THROTTLE_MS
      ) {
        return;
      }
      state.lastUpdateEmitMonoMs = now;
      states.set(event.toolCallId, state);
      await emit({
        event: "tool_execution_update",
        role,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        timestamp: options.clock(),
      });
    },
    async onEnd(event) {
      const role = activeRole();
      if (role === undefined) return;
      states.delete(event.toolCallId);
      await emit({
        event: "tool_execution_end",
        role,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        timestamp: options.clock(),
        isError: event.isError,
      });
    },
  };
}
