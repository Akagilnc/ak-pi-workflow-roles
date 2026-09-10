/**
 * 起居录（ticket-provenance）typed contracts — ADR 0075 / #582.
 * JSONL is the sole authority; md is a derived human face.
 */

/** Sitian kind for per-ticket court diary volumes. */
export const TICKET_PROVENANCE_KIND = "ticket-provenance" as const;

/** Human-read view filename co-located with the JSONL volume. */
export const TICKET_PROVENANCE_HUMAN_VIEW = "起居录.md" as const;

/** Payload discriminator: diagnostic residue (not a diary body entry). */
export const TICKET_PROVENANCE_RECORD_CLASS_DIAGNOSTIC = "diagnostic" as const;

/** Source family as the diarist wrote it (#836: no allowlist drop). */
export type TicketProvenanceSourceKind = string;

/**
 * How a block entered the volume.
 * - llm-semantic: LLM selected and submitted the whole block (#779: no mechanical reverse-verify).
 *   basis.anchors may carry ticket # / human notes for audit only — not a gate.
 */
export type TicketProvenanceBasisMethod = "llm-semantic";

/** Basis for inclusion — LLM judgment; anchors/notes are audit-only. */
export type TicketProvenanceBasis = {
  readonly method: TicketProvenanceBasisMethod;
  /** Audit notes (ticket #, human labels). Not a machine gate. */
  readonly anchors?: readonly string[];
  /** Free diagnostic note. Not a machine gate. */
  readonly note?: string;
};

/** Stable pointer back to immutable source bytes. */
export type TicketProvenanceSourceRef = {
  readonly sessionFile?: string;
  readonly entryId?: string | number;
  readonly path?: string;
  readonly url?: string;
};

/**
 * One transcribed block entry (payload of a sitian ticket-provenance row).
 * Whole-block transcript — no pointer-only substitution (ADR 0075).
 */
export type TicketProvenanceEntry = {
  readonly basis: TicketProvenanceBasis;
  readonly sourceKind: TicketProvenanceSourceKind;
  readonly sourceRef: TicketProvenanceSourceRef;
  readonly transcript: string;
  readonly timestamp: string;
};

/**
 * Typed diagnostic on the same ticket-provenance partition as diary entries.
 * Separated by recordClass discriminator — never disguised as a source entry.
 */
export type TicketProvenanceDiagnosticKind =
  /** Historical rows only — retained for reading older volumes (#779 deleted writers). */
  | "collector-failed"
  | "issue-source-failed"
  | "quote-verify-failed";

export type TicketProvenanceDiagnostic = {
  readonly recordClass: typeof TICKET_PROVENANCE_RECORD_CLASS_DIAGNOSTIC;
  readonly diagnosticKind: TicketProvenanceDiagnosticKind;
  /** True cause text (engine error, origin miss, tracker/gh failure). */
  readonly cause: string;
  readonly recordedAt: string;
  /** Optional structured reason tag (issue-source family). */
  readonly reason?: string;
};

/** Deterministic identity input — entry-level idempotency key material. */
export type TicketProvenanceIdentityInput = {
  readonly ticketNumber: number;
  readonly sourceKind: TicketProvenanceSourceKind;
  readonly sourceRef: TicketProvenanceSourceRef;
  readonly transcript: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const DIAGNOSTIC_KINDS = new Set<string>([
  "collector-failed",
  "issue-source-failed",
  "quote-verify-failed",
]);

/**
 * Project a typed diagnostic payload (recordClass discriminator only).
 * Disguised diary-entry shapes are not diagnostics — no branch-intermediate compat.
 */
export function projectTicketProvenanceDiagnostic(
  value: unknown,
): TicketProvenanceDiagnostic | undefined {
  if (!isRecord(value)) return undefined;
  if (value.recordClass !== TICKET_PROVENANCE_RECORD_CLASS_DIAGNOSTIC) {
    return undefined;
  }
  if (
    typeof value.diagnosticKind !== "string" ||
    !DIAGNOSTIC_KINDS.has(value.diagnosticKind)
  ) {
    return undefined;
  }
  if (typeof value.cause !== "string" || value.cause.length === 0) {
    return undefined;
  }
  if (typeof value.recordedAt !== "string" || value.recordedAt.length === 0) {
    return undefined;
  }
  return {
    recordClass: TICKET_PROVENANCE_RECORD_CLASS_DIAGNOSTIC,
    diagnosticKind: value.diagnosticKind as TicketProvenanceDiagnosticKind,
    cause: value.cause,
    recordedAt: value.recordedAt,
    ...(typeof value.reason === "string" ? { reason: value.reason } : {}),
  };
}

/**
 * Project a lawful diary entry from unknown payload bytes.
 * Shape is not an admission gate for role output; this is the diarist/write seam
 * self-check so garbage does not enter the volume.
 * Diagnostics (recordClass discriminator) are not entries.
 */
export function projectTicketProvenanceEntry(
  value: unknown,
): TicketProvenanceEntry | undefined {
  if (!isRecord(value)) return undefined;
  if (value.recordClass === TICKET_PROVENANCE_RECORD_CLASS_DIAGNOSTIC) {
    return undefined;
  }
  if (value.unprojected === true) {
    return undefined;
  }
  return value as TicketProvenanceEntry;
}
