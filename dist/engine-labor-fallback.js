/**
 * #380 — sole shared seat-fallback declaration after engine detour failure.
 * Detour rejoins the main road (ADR 0069); silence is the only crime.
 * Construction of the typed receipt field lives in exactly one site (S1).
 */
/** Activation-scoped latch holder (one parent seat activation at a time). */
let activationLatch;
/** Sole construction site for typed receipt field `engineLaborFallback` (#380 S1). */
export function buildEngineLaborFallbackField(input) {
    return Object.freeze({
        engineLaborFallback: Object.freeze({
            engine: input.engine,
            failure: input.failure,
            laborBy: "seat",
        }),
    });
}
/**
 * Seat-fallback status taint suffix.
 * When engineLaborFallback is declared, typed status discriminators
 * (judgeStatus / status) must not remain clean values like converged/completed.
 * Mechanical form: `${base}-by-fallback` — readable on the status line alone.
 */
export const SEAT_FALLBACK_STATUS_SUFFIX = "-by-fallback";
export function isSeatFallbackTaintedStatus(status) {
    return status.endsWith(SEAT_FALLBACK_STATUS_SUFFIX);
}
/** Strip seat-fallback taint for semantic routing / acceptance matching. */
export function seatFallbackBaseStatus(status) {
    return isSeatFallbackTaintedStatus(status)
        ? status.slice(0, -SEAT_FALLBACK_STATUS_SUFFIX.length)
        : status;
}
/** Idempotent taint: clean → `${clean}-by-fallback`; already tainted stays. */
export function taintStatusForSeatFallback(status) {
    if (status.length === 0 || isSeatFallbackTaintedStatus(status))
        return status;
    return `${status}${SEAT_FALLBACK_STATUS_SUFFIX}`;
}
const STATUS_DISCRIMINATOR_KEYS = ["judgeStatus", "status"];
/** Rewrite known status discriminators on a receipt when seat fallback is declared. */
function taintReceiptStatusDiscriminators(receipt) {
    let next;
    for (const key of STATUS_DISCRIMINATOR_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(receipt, key))
            continue;
        let value;
        try {
            value = receipt[key];
        }
        catch {
            continue;
        }
        if (typeof value !== "string" || value.length === 0)
            continue;
        const tainted = taintStatusForSeatFallback(value);
        if (tainted === value)
            continue;
        if (next === undefined) {
            next = { ...receipt };
        }
        next[key] = tainted;
    }
    return next === undefined ? receipt : next;
}
export function createEngineLaborFallbackLatch() {
    return { field: undefined };
}
/**
 * Record first detour failure for this latch (first wins; parallel legs share one field).
 * Always returns the latched first-wins value so tool details and receipt projection match.
 */
export function recordEngineLaborFallback(latch, input) {
    const field = buildEngineLaborFallbackField(input);
    if (latch.field === undefined)
        latch.field = field;
    return latch.field;
}
export function readEngineLaborFallbackField(latch) {
    return latch?.field;
}
/**
 * Merge sole-built field into typed receipt details.
 * Spread only — must not construct the field key again (S1).
 * When the field is present, also taint typed status discriminators so a
 * status-line-only reader cannot mistake seat labor for clean engine labor.
 * Without a mechanical latch, strip any model-injected reserved key (no forged declaration).
 */
export function withEngineLaborFallbackField(receipt, field) {
    if (field !== undefined) {
        const taintedReceipt = taintReceiptStatusDiscriminators(receipt);
        return { ...taintedReceipt, ...field };
    }
    if (!Object.prototype.hasOwnProperty.call(receipt, "engineLaborFallback")) {
        return receipt;
    }
    const { engineLaborFallback: _forged, ...rest } = receipt;
    return rest;
}
/** Install the activation-scoped latch (any role session_start with engine). */
export function installActivationEngineLaborFallbackLatch(latch) {
    activationLatch = latch;
}
/** Clear activation latch (session end / next activation). */
export function clearActivationEngineLaborFallbackLatch() {
    activationLatch = undefined;
}
/** Active activation latch, if any (legs inherit parent seat activation). */
export function activationEngineLaborFallbackLatch() {
    return activationLatch;
}
/** Read fallback field from the active activation latch. */
export function readActivationEngineLaborFallbackField() {
    return readEngineLaborFallbackField(activationLatch);
}
/**
 * Read a previously attached declaration from a typed receipt / details object.
 * Rebuilds via the sole construction site — callers must spread, never re-key.
 */
export function readEngineLaborFallbackFieldFrom(source) {
    if (typeof source !== "object" || source === null || Array.isArray(source)) {
        return undefined;
    }
    let raw;
    try {
        raw = source.engineLaborFallback;
    }
    catch {
        return undefined;
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
        return undefined;
    const rec = raw;
    if (typeof rec.engine !== "string" ||
        typeof rec.failure !== "string" ||
        rec.laborBy !== "seat") {
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
export function restoreEngineLaborFallbackFromSessionEntries(latch, entries, toolName) {
    for (const entry of entries) {
        if (typeof entry !== "object" || entry === null)
            continue;
        const row = entry;
        if (row.type !== "message")
            continue;
        const message = row.message;
        if (typeof message !== "object" || message === null)
            continue;
        const msg = message;
        if (msg.role !== "toolResult")
            continue;
        if (msg.toolName !== toolName)
            continue;
        const field = readEngineLaborFallbackFieldFrom(msg.details);
        if (field === undefined)
            continue;
        recordEngineLaborFallback(latch, {
            engine: field.engineLaborFallback.engine,
            failure: field.engineLaborFallback.failure,
        });
    }
}
