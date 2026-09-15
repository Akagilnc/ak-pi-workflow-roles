/**
 * Wire contract for auditor parent-attempt binding / compliance-failure entries.
 * Shared by archivist writer, settlement reader, and compliance/gate projection —
 * single authority for machine-consumed customType strings (#858).
 */

export const AUDITOR_PARENT_ATTEMPT_BINDING_ENTRY_TYPE =
  "ak_auditor_parent_attempt_binding" as const;
export const AUDITOR_COMPLIANCE_FAILURE_ENTRY_TYPE =
  "ak_auditor_compliance_failure" as const;

export type AuditorParentAttemptBinding = {
  readonly version: 1;
  readonly parent: {
    readonly sessionId?: string;
    readonly sessionFile?: string;
    readonly attemptEntryId?: string;
    /** Existing court-turn identity (#637); same rule as SettlementCourtScope.courtAttemptId. */
    readonly courtAttemptId?: string;
  };
  /**
   * Later same-court compliance outcome. `pass` supersedes an earlier retained
   * failure for this court; absent/`failure` keeps failure recoverable when no
   * later result exists (#858).
   */
  readonly outcome?: "pass" | "failure";
};

export type AuditorComplianceFailureRecord = {
  readonly version: 1;
  readonly parent: AuditorParentAttemptBinding["parent"];
  readonly failure: {
    readonly cause?: string;
    readonly diagnostic?: string;
    readonly identity?: { readonly name?: string; readonly code?: string | number };
    readonly details?: Readonly<Record<string, unknown>>;
  };
};
