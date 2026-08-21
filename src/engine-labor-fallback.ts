/**
 * #380 — sole shared seat-fallback declaration after engine detour failure.
 * Detour rejoins the main road (ADR 0069); silence is the only crime.
 * Construction of the typed receipt field lives in exactly one site (S1).
 */

export type EngineLaborFallback = Readonly<{
  engine: string;
  failure: string;
  laborBy: "seat";
}>;

/** Activation-scoped latch holder (one parent seat activation at a time). */
let activationLatch: EngineLaborFallbackLatch | undefined;

/** Sole construction site for typed receipt field `engineLaborFallback` (#380 S1). */
export function buildEngineLaborFallbackField(input: {
  readonly engine: string;
  readonly failure: string;
}) {
  return Object.freeze({
    engineLaborFallback: Object.freeze({
      engine: input.engine,
      failure: input.failure,
      laborBy: "seat" as const,
    }),
  });
}

/** Frozen field bag produced by the sole construction site. */
export type EngineLaborFallbackField = ReturnType<
  typeof buildEngineLaborFallbackField
>;

/**
 * Seat-fallback status taint suffix.
 * When engineLaborFallback is declared, typed status discriminators
 * (judgeStatus / status) must not remain clean values like converged/completed.
 * Mechanical form: `${base}-by-fallback` — readable on the status line alone.
 */
export const SEAT_FALLBACK_STATUS_SUFFIX = "-by-fallback" as const;

export function isSeatFallbackTaintedStatus(status: string): boolean {
  return status.endsWith(SEAT_FALLBACK_STATUS_SUFFIX);
}

/** Strip seat-fallback taint for semantic routing / acceptance matching. */
export function seatFallbackBaseStatus(status: string): string {
  return isSeatFallbackTaintedStatus(status)
    ? status.slice(0, -SEAT_FALLBACK_STATUS_SUFFIX.length)
    : status;
}

/** Idempotent taint: clean → `${clean}-by-fallback`; already tainted stays. */
export function taintStatusForSeatFallback(status: string): string {
  if (status.length === 0 || isSeatFallbackTaintedStatus(status)) return status;
  return `${status}${SEAT_FALLBACK_STATUS_SUFFIX}`;
}

const STATUS_DISCRIMINATOR_KEYS = ["judgeStatus", "status"] as const;

/** Rewrite known status discriminators on a receipt when seat fallback is declared. */
function taintReceiptStatusDiscriminators<T extends object>(receipt: T): T {
  let next: Record<string, unknown> | undefined;
  for (const key of STATUS_DISCRIMINATOR_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(receipt, key)) continue;
    let value: unknown;
    try {
      value = (receipt as Record<string, unknown>)[key];
    } catch {
      continue;
    }
    if (typeof value !== "string" || value.length === 0) continue;
    const tainted = taintStatusForSeatFallback(value);
    if (tainted === value) continue;
    if (next === undefined) {
      next = { ...(receipt as object as Record<string, unknown>) };
    }
    next[key] = tainted;
  }
  return next === undefined ? receipt : (next as T);
}

export type EngineLaborFallbackLatch = {
  field: EngineLaborFallbackField | undefined;
};

export function createEngineLaborFallbackLatch(): EngineLaborFallbackLatch {
  return { field: undefined };
}

/**
 * Record first detour failure for this latch (first wins; parallel legs share one field).
 * Always returns the latched first-wins value so tool details and receipt projection match.
 */
export function recordEngineLaborFallback(
  latch: EngineLaborFallbackLatch,
  input: { readonly engine: string; readonly failure: string },
): EngineLaborFallbackField {
  const field = buildEngineLaborFallbackField(input);
  if (latch.field === undefined) latch.field = field;
  return latch.field;
}

export function readEngineLaborFallbackField(
  latch: EngineLaborFallbackLatch | undefined,
): EngineLaborFallbackField | undefined {
  return latch?.field;
}

/**
 * Merge sole-built field into typed receipt details.
 * Spread only — must not construct the field key again (S1).
 * When the field is present, also taint typed status discriminators so a
 * status-line-only reader cannot mistake seat labor for clean engine labor.
 * Without a mechanical latch, strip any model-injected reserved key (no forged declaration).
 */
export function withEngineLaborFallbackField<T extends object>(
  receipt: T,
  field: EngineLaborFallbackField | undefined,
): T {
  if (field !== undefined) {
    const taintedReceipt = taintReceiptStatusDiscriminators(receipt);
    return { ...taintedReceipt, ...field };
  }
  if (
    !Object.prototype.hasOwnProperty.call(receipt, "engineLaborFallback")
  ) {
    return receipt;
  }
  const { engineLaborFallback: _forged, ...rest } = receipt as T & {
    engineLaborFallback?: unknown;
  };
  return rest as T;
}

/** Install the activation-scoped latch (any role session_start with engine). */
export function installActivationEngineLaborFallbackLatch(
  latch: EngineLaborFallbackLatch,
): void {
  activationLatch = latch;
}

/** Clear activation latch (session end / next activation). */
export function clearActivationEngineLaborFallbackLatch(): void {
  activationLatch = undefined;
}

/** Active activation latch, if any (legs inherit parent seat activation). */
export function activationEngineLaborFallbackLatch():
  | EngineLaborFallbackLatch
  | undefined {
  return activationLatch;
}

/** Read fallback field from the active activation latch. */
export function readActivationEngineLaborFallbackField():
  | EngineLaborFallbackField
  | undefined {
  return readEngineLaborFallbackField(activationLatch);
}

/**
 * Read a previously attached declaration from a typed receipt / details object.
 * Rebuilds via the sole construction site — callers must spread, never re-key.
 */
export function readEngineLaborFallbackFieldFrom(
  source: unknown,
): EngineLaborFallbackField | undefined {
  if (typeof source !== "object" || source === null || Array.isArray(source)) {
    return undefined;
  }
  let raw: unknown;
  try {
    raw = (source as Record<string, unknown>).engineLaborFallback;
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const rec = raw as Record<string, unknown>;
  if (
    typeof rec.engine !== "string" ||
    typeof rec.failure !== "string" ||
    rec.laborBy !== "seat"
  ) {
    return undefined;
  }
  return buildEngineLaborFallbackField({
    engine: rec.engine,
    failure: rec.failure,
  });
}

/**
 * Restore activation latch from durable session tool results (#380 resume).
 * Scans existing same-session detour tool results only — no sidecar / new entry type.
 * Replays through recordEngineLaborFallback so first-wins + sole producer stay intact.
 */
export function restoreEngineLaborFallbackFromSessionEntries(
  latch: EngineLaborFallbackLatch,
  entries: readonly unknown[],
  toolName: string,
): void {
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const row = entry as { type?: unknown; message?: unknown };
    if (row.type !== "message") continue;
    const message = row.message;
    if (typeof message !== "object" || message === null) continue;
    const msg = message as {
      role?: unknown;
      toolName?: unknown;
      details?: unknown;
    };
    if (msg.role !== "toolResult") continue;
    if (msg.toolName !== toolName) continue;
    const field = readEngineLaborFallbackFieldFrom(msg.details);
    if (field === undefined) continue;
    recordEngineLaborFallback(latch, {
      engine: field.engineLaborFallback.engine,
      failure: field.engineLaborFallback.failure,
    });
  }
}
