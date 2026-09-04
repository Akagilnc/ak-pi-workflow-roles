/**
 * Sitian (司天台) canonical contracts, Layout schema, and pointer definitions.
 * ADR 0065 single record entry + ADR 0068 Taishi analysis.
 */

/** Closed set of record levels. */
export type SitianLevel = "run-summary" | "event" | "protocol-snapshot";

/** Subject coordinate identifying the work identity or run attempt. */
export type SitianSubject =
  | string
  | {
      readonly runId: string;
      readonly attemptId?: string | undefined;
      readonly [key: string]: unknown;
    };

/** Raw reference pointing to original retained bytes/frames without duplication (#513). */
export type SitianRawReference = {
  readonly sessionFile: string;
  readonly entryId: string | number;
};

/** Optional usage metrics carried on canonical records. */
export type SitianUsage = {
  readonly promptTokens?: number | undefined;
  readonly completionTokens?: number | undefined;
  readonly totalTokens?: number | undefined;
  readonly [key: string]: unknown;
};

/** Canonical Sitian record layout. */
export type SitianRecord = {
  readonly level: SitianLevel;
  readonly kind: string;
  readonly identity: string;
  readonly subject?: SitianSubject | undefined;
  /** Parent session principal link / nesting origin. */
  readonly sessionParent?: string | undefined;
  /** Prior event identity in a submission ledger chain (S4; distinct from sessionParent). */
  readonly priorEventId?: string | undefined;
  readonly timestamp: string;
  readonly host: string;
  readonly source?: string | undefined;
  readonly payload?: unknown;
  readonly raw?: SitianRawReference | undefined;
  readonly usage?: SitianUsage | undefined;
};

/** Typed pointer returned upon durable acceptance of a record. */
export type RecordPointer = {
  readonly identity: string;
  readonly recordFile: string;
  readonly kind: string;
  readonly level: SitianLevel;
};

/** Input passed to the Sitian facade (sitianReport). */
export type SitianRecordInput = {
  readonly level: SitianLevel;
  readonly kind: string;
  /** Deterministic or explicit record identity. Minted if omitted. */
  readonly identity?: string | undefined;
  readonly subject?: SitianSubject | undefined;
  readonly sessionParent?: string | undefined;
  readonly priorEventId?: string | undefined;
  readonly timestamp?: string | undefined;
  readonly host?: string | undefined;
  readonly source?: string | undefined;
  readonly payload?: unknown;
  readonly raw?: SitianRawReference | undefined;
  readonly usage?: SitianUsage | undefined;
  readonly cwd?: string | undefined;
  readonly home?: string | undefined;
};

/** Typed malformed diagnostic emitted by the canonical Reader upon encountering damaged lines. */
export type SitianMalformedDiagnostic = {
  readonly kind: "malformed";
  readonly line: number;
  readonly raw: string;
  readonly error: string;
};

/** Canonical Reader result surfacing both valid records and non-destructive diagnostics. */
export type SitianReadResult = {
  readonly records: readonly SitianRecord[];
  readonly diagnostics: readonly SitianMalformedDiagnostic[];
};

/** Lift direct-cause fs errno onto a wrap error (no chain walk). */
export function attachDirectErrnoCode(error: Error, cause: unknown): void {
  if (cause === null || typeof cause !== "object" || !("code" in cause)) return;
  const code = (cause as { code?: unknown }).code;
  if (typeof code === "string") (error as NodeJS.ErrnoException).code = code;
}

/** Stable claim/recovery failure dispositions — typed fields, not message classification. */
export type SitianInfrastructureFailureDisposition =
  | "live-contention"
  | "malformed-claim"
  | "malformed-recovery"
  | "post-commit-cleanup"
  | "disappeared"
  | "dead-recovery"
  | "unreadable-claim"
  | "unreadable-recovery"
  | "row-invisible";

/** Options for SitianInfrastructureError; preserves ErrorOptions / knownCause compatibility. */
export type SitianInfrastructureErrorOptions = ErrorOptions & {
  readonly failureDisposition?: SitianInfrastructureFailureDisposition;
};

/** Typed infrastructure error for real ledger persistence / IO failures. */
export class SitianInfrastructureError extends Error {
  readonly knownCause = "session" as const;
  readonly failureDisposition?: SitianInfrastructureFailureDisposition;

  constructor(message: string, options?: SitianInfrastructureErrorOptions) {
    super(message, options);
    this.name = "SitianInfrastructureError";
    if (options?.failureDisposition !== undefined) {
      this.failureDisposition = options.failureDisposition;
    }
    attachDirectErrnoCode(this, options?.cause);
  }
}
