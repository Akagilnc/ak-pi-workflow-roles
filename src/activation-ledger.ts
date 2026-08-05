import {
  constants,
  closeSync,
  openSync,
  writeSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

import type { ActivationSessionPointer } from "./activation-ledger-session.ts";
import {
  ActivationLedgerError,
  activationWaitingLedgerPath,
  assertLedgerFileInsideHome,
  ensureRealDirectoryTree,
  errorText,
} from "./activation-ledger-topology.ts";

export {
  ActivationGitRepositoryRequiredError,
  resolveBookKeyFromGit,
} from "./activation-ledger-git.ts";
export {
  ActivationSessionFileMissingError,
  durableSessionPointer,
  type ActivationSessionManager,
  type ActivationSessionPointer,
} from "./activation-ledger-session.ts";
export {
  ActivationLedgerError,
  activationBookDirectory,
  activationWaitingLedgerPath,
  resolveActivationLedgerHome,
} from "./activation-ledger-topology.ts";

/** Caller-preassigned correlation id, or an explicit absent identity (never empty string). */
export type ActivationCorrelationIdentity =
  | { readonly kind: "caller"; readonly id: string }
  | { readonly kind: "absent" };

export const ACCEPTED_ACTIVATION_EVENT = "accepted-activation" as const;

/**
 * Closed activation fact: index fields only (ADR 0049).
 * No prompt, transcript, argv, excerpt, or other content.
 */
export type AcceptedActivationFact = {
  readonly event: typeof ACCEPTED_ACTIVATION_EVENT;
  readonly role: string;
  readonly observedAt: string;
  readonly bookKey: string;
  readonly session: ActivationSessionPointer;
  readonly correlation: ActivationCorrelationIdentity;
};

export type AcceptedActivationFactInput = {
  readonly role: string;
  readonly observedAt: string;
  readonly bookKey: string;
  readonly session: ActivationSessionPointer;
  readonly correlation: ActivationCorrelationIdentity;
};

/**
 * Host correlation channel (not a CLI flag): a non-blank AK_CORRELATION_ID carries
 * the caller id verbatim; missing/blank/whitespace-only yields the typed absent identity.
 */
export function correlationIdentityFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ActivationCorrelationIdentity {
  const raw = env.AK_CORRELATION_ID;
  if (typeof raw === "string" && raw.trim().length > 0) {
    return { kind: "caller", id: raw };
  }
  return { kind: "absent" };
}

/**
 * Sole closed whitelist projection for accepted-activation facts (ADR 0049).
 * Build and serialize both consume this — zero content keys, no dual projection drift.
 */
function projectAcceptedActivationFact(input: {
  readonly role: string;
  readonly observedAt: string;
  readonly bookKey: string;
  readonly session: ActivationSessionPointer;
  readonly correlation: ActivationCorrelationIdentity;
}): AcceptedActivationFact {
  return {
    event: ACCEPTED_ACTIVATION_EVENT,
    role: input.role,
    observedAt: input.observedAt,
    bookKey: input.bookKey,
    session: { kind: "session-file", path: input.session.path },
    correlation: input.correlation.kind === "caller"
      ? { kind: "caller", id: input.correlation.id }
      : { kind: "absent" },
  };
}

/** Construct the closed fact from trusted typed inputs only (whitelist — no content keys). */
export function buildAcceptedActivationFact(input: AcceptedActivationFactInput): AcceptedActivationFact {
  return projectAcceptedActivationFact(input);
}

/** Serialize only the closed index fields (whitelist projection — no content keys). */
export function serializeAcceptedActivationFact(fact: AcceptedActivationFact): string {
  return `${JSON.stringify(projectAcceptedActivationFact(fact))}\n`;
}

/** Write seam matching node:fs writeSync — injectable for controlled short-write tests. */
export type ActivationLedgerWriteSync = (
  fd: number,
  buffer: NodeJS.ArrayBufferView,
  offset: number,
  length: number,
  position: number | null,
) => number;

/**
 * Run body then cleanups without letting cleanup erase the primary failure.
 * Primary remains AggregateError.cause / errors[0]; cleanup is retained as nested evidence.
 */
function settleWithCleanup(body: () => void, cleanups: ReadonlyArray<() => void>): void {
  let primaryFailure: unknown;
  try {
    body();
  } catch (error) {
    primaryFailure = error;
  }

  const failures: unknown[] = [];
  for (const cleanup of cleanups) {
    try {
      cleanup();
    } catch (error) {
      failures.push(error);
    }
  }

  if (failures.length > 0) {
    const cleanupFailure =
      failures.length === 1
        ? failures[0]
        : new AggregateError(failures, "activation ledger cleanup failed", { cause: failures[0] });
    if (primaryFailure !== undefined) {
      throw new AggregateError(
        [primaryFailure, cleanupFailure],
        "activation ledger operation and cleanup failed",
        { cause: primaryFailure },
      );
    }
    throw cleanupFailure;
  }

  if (primaryFailure !== undefined) throw primaryFailure;
}

/**
 * Append one complete JSONL record with one O_APPEND write of the full record.
 * Shared-ledger contract: concurrent successful append-only producers cannot
 * overwrite one another. A short write is an honest infrastructure failure
 * (ADR 0049) — no non-append rollback/truncate. Close failure cannot mask the
 * primary write cause; cleanup evidence is retained.
 */
export function appendAcceptedActivationFact(
  ledgerPath: string,
  fact: AcceptedActivationFact,
  options: {
    ledgerHome: string;
    /** Optional write seam for controlled short-write tests; production uses writeSync. */
    write?: ActivationLedgerWriteSync;
  },
): void {
  const line = Buffer.from(serializeAcceptedActivationFact(fact), "utf8");
  const resolvedLedger = resolve(ledgerPath);
  const resolvedHome = resolve(options.ledgerHome);
  const parent = dirname(resolvedLedger);
  ensureRealDirectoryTree(resolvedHome, parent);
  assertLedgerFileInsideHome(resolvedLedger, resolvedHome);

  const write = options.write ?? writeSync;
  let ledgerFd: number | undefined;

  settleWithCleanup(
    () => {
      try {
        ledgerFd = openSync(
          resolvedLedger,
          constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY,
          0o644,
        );
      } catch (error) {
        throw new ActivationLedgerError(
          `activation ledger failed to open ledger file (${resolvedLedger}): ${errorText(error)}`,
          { cause: error },
        );
      }

      const written = write(ledgerFd, line, 0, line.length, null);
      if (written !== line.length) {
        throw new ActivationLedgerError(
          `activation ledger short write: wrote ${written} of ${line.length} bytes to ${resolvedLedger}`,
        );
      }
    },
    [
      () => {
        if (ledgerFd === undefined) return;
        const fd = ledgerFd;
        ledgerFd = undefined;
        closeSync(fd);
      },
    ],
  );
}

export function appendAcceptedActivationToBook(options: {
  ledgerHome: string;
  fact: AcceptedActivationFact;
  write?: ActivationLedgerWriteSync;
}): void {
  const appendOptions: {
    ledgerHome: string;
    write?: ActivationLedgerWriteSync;
  } = { ledgerHome: options.ledgerHome };
  if (options.write !== undefined) appendOptions.write = options.write;
  appendAcceptedActivationFact(
    activationWaitingLedgerPath(options.ledgerHome, options.fact.bookKey),
    options.fact,
    appendOptions,
  );
}
