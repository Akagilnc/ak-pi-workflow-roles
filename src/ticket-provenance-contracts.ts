/**
 * 起居录（ticket-provenance）typed contracts — ADR 0075 / #582.
 * JSONL is the sole authority; md is a derived human face.
 */

/** Sitian kind for per-ticket court diary volumes. */
export const TICKET_PROVENANCE_KIND = "ticket-provenance" as const;

/** Human-read view filename co-located with the JSONL volume. */
export const TICKET_PROVENANCE_HUMAN_VIEW = "起居录.md" as const;

/**
 * Incremental watermark: identities already offered to the collector this ticket
 * (selected or not). Process state next to the volume — not a diary dual-source.
 */
export const TICKET_PROVENANCE_OFFERED_WATERMARK = "offered-identities.jsonl" as const;

/** Payload discriminator: diagnostic residue (not a diary body entry). */
export const TICKET_PROVENANCE_RECORD_CLASS_DIAGNOSTIC = "diagnostic" as const;

/** Source families the diarist may enumerate (v1). */
export type TicketProvenanceSourceKind =
  | "cc-session"
  | "issue-body-comment"
  | "adr-decision-key"
  | "ticket-decree-block";

/**
 * How a block entered the volume.
 * - llm-semantic: LLM collector selected the block (after mechanical reverse-verify).
 *   basis.anchors carry ticket # and mechanical/claimed quote notes for audit only.
 */
export type TicketProvenanceBasisMethod = "llm-semantic";

/** Basis for inclusion — LLM judgment plus mechanical anchor notes for audit. */
export type TicketProvenanceBasis = {
  readonly method: TicketProvenanceBasisMethod;
  /** Mechanical anchors (ticket #, quotes, keywords) used for candidate/verify reference only. */
  readonly anchors?: readonly string[];
  /** Free diagnostic note (failure cause, filter reason). Not a machine gate. */
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
  /** Historical rows only — the diarist turn's own failure settles the run (#708). */
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

const SOURCE_KINDS = new Set<string>([
  "cc-session",
  "issue-body-comment",
  "adr-decision-key",
  "ticket-decree-block",
]);

const BASIS_METHODS = new Set<string>(["llm-semantic"]);

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
  // Diagnostics are a separate projection — never body entries.
  if (value.recordClass === TICKET_PROVENANCE_RECORD_CLASS_DIAGNOSTIC) {
    return undefined;
  }
  if (!isRecord(value.basis)) return undefined;
  if (typeof value.basis.method !== "string" || !BASIS_METHODS.has(value.basis.method)) {
    return undefined;
  }
  if (typeof value.sourceKind !== "string" || !SOURCE_KINDS.has(value.sourceKind)) {
    return undefined;
  }
  if (!isRecord(value.sourceRef)) return undefined;
  if (typeof value.transcript !== "string" || value.transcript.length === 0) {
    return undefined;
  }
  if (typeof value.timestamp !== "string" || value.timestamp.length === 0) {
    return undefined;
  }

  const basis: TicketProvenanceBasis = {
    method: value.basis.method as TicketProvenanceBasisMethod,
    ...(Array.isArray(value.basis.anchors)
      ? {
          anchors: value.basis.anchors.filter(
            (item): item is string => typeof item === "string",
          ),
        }
      : {}),
    ...(typeof value.basis.note === "string" ? { note: value.basis.note } : {}),
  };

  const sourceRef: TicketProvenanceSourceRef = {
    ...(typeof value.sourceRef.sessionFile === "string"
      ? { sessionFile: value.sourceRef.sessionFile }
      : {}),
    ...(typeof value.sourceRef.entryId === "string" ||
    typeof value.sourceRef.entryId === "number"
      ? { entryId: value.sourceRef.entryId }
      : {}),
    ...(typeof value.sourceRef.path === "string" ? { path: value.sourceRef.path } : {}),
    ...(typeof value.sourceRef.url === "string" ? { url: value.sourceRef.url } : {}),
  };

  return {
    basis,
    sourceKind: value.sourceKind as TicketProvenanceSourceKind,
    sourceRef,
    transcript: value.transcript,
    timestamp: value.timestamp,
  };
}
