import {
  constants,
  closeSync,
  fstatSync,
  openSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

import type { ActivationSessionPointer } from "./activation-ledger-session.ts";
import {
  ActivationLedgerError,
  activationWaitingLedgerPath,
  assertLedgerFileInsideHome,
  ensureRealDirectoryTree,
  errorText,
} from "./activation-ledger-topology.ts";

/** Private open flags: O_NOFOLLOW closes the lstat→open TOCTOU window. */
const ACTIVATION_LEDGER_APPEND_OPEN_FLAGS =
  constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW;

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
 * Package-owned index-only top-level keys for accepted-activation facts (ADR 0049).
 * Sole machine key contract: projection and tests consume this descriptor — not prose markers.
 */
export const ACCEPTED_ACTIVATION_FACT_KEYS = Object.freeze([
  "event",
  "role",
  "observedAt",
  "bookKey",
  "session",
  "correlation",
] as const);

export type AcceptedActivationFactKey = (typeof ACCEPTED_ACTIVATION_FACT_KEYS)[number];

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

// Keys tuple ↔ fact type must stay exact (compile fail on drift; no second field list).
type ExactKeyMatch<T, K extends PropertyKey> =
  Exclude<keyof T, K> | Exclude<K, keyof T> extends never ? true : never;
const _acceptedActivationFactKeysMatch: ExactKeyMatch<
  AcceptedActivationFact,
  AcceptedActivationFactKey
> = true;
void _acceptedActivationFactKeysMatch;

/** Trusted typed inputs for building the closed fact (canonical fact minus event discriminant). */
export type AcceptedActivationFactInput = Omit<AcceptedActivationFact, "event">;

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
 * Descriptor-driven top-level pick: only ACCEPTED_ACTIVATION_FACT_KEYS leave this boundary.
 * Nested session/correlation are rebuilt closed before the pick (ADR 0049 zero-content by construction).
 */
function projectAcceptedActivationFact(
  input: AcceptedActivationFactInput,
): AcceptedActivationFact {
  const closed: AcceptedActivationFact = {
    event: ACCEPTED_ACTIVATION_EVENT,
    role: input.role,
    observedAt: input.observedAt,
    bookKey: input.bookKey,
    session: { kind: "session-file", path: input.session.path },
    correlation: input.correlation.kind === "caller"
      ? { kind: "caller", id: input.correlation.id }
      : { kind: "absent" },
  };
  // Descriptor is the sole top-level emission contract (typed pick; no content keys).
  return Object.fromEntries(
    ACCEPTED_ACTIVATION_FACT_KEYS.map((key) => [key, closed[key]]),
  ) as AcceptedActivationFact;
}

/** Construct the closed fact from trusted typed inputs only (descriptor projection — no content keys). */
export function buildAcceptedActivationFact(input: AcceptedActivationFactInput): AcceptedActivationFact {
  return projectAcceptedActivationFact(input);
}

/** Serialize only the closed index fields (descriptor projection — no content keys). */
export function serializeAcceptedActivationFact(fact: AcceptedActivationFact): string {
  return `${JSON.stringify(projectAcceptedActivationFact(fact))}\n`;
}

/**
 * Bare O_APPEND write of one complete line under an absolute ledger home.
 * Private helper: production-bound to writeSync; owns open/write/close honesty only.
 * Close failure cannot mask open/write; simultaneous close is nested evidence.
 */
function appendActivationLedgerLine(
  ledgerPath: string,
  line: Uint8Array,
  options: { ledgerHome: string },
): void {
  if (!isAbsolute(options.ledgerHome)) {
    throw new ActivationLedgerError(
      `activation ledger home must be absolute: ${options.ledgerHome}`,
    );
  }
  const resolvedLedger = resolve(ledgerPath);
  const resolvedHome = resolve(options.ledgerHome);
  const parent = dirname(resolvedLedger);
  ensureRealDirectoryTree(resolvedHome, parent);
  assertLedgerFileInsideHome(resolvedLedger, resolvedHome);

  // Fail-closed guard (same shape as PR #418's publication seam): on platforms
  // without O_NOFOLLOW (e.g. Windows, nodejs/node#41590) the JS bitwise-or in
  // ACTIVATION_LEDGER_APPEND_OPEN_FLAGS would silently drop the flag and the
  // lstat→open TOCTOU anti-symlink protection would vanish while the comment
  // above still claims it. Refuse loudly via the existing typed ledger failure
  // channel instead of appending unprotected; never silently degrade.
  if (typeof constants.O_NOFOLLOW !== "number") {
    throw new ActivationLedgerError(
      "activation ledger append requires O_NOFOLLOW open-flag support (anti-symlink TOCTOU protection must not be silently dropped); refusing to append",
    );
  }
  const bytes = Buffer.isBuffer(line) ? line : Buffer.from(line);
  let ledgerFd: number | undefined;
  let primaryFailure: unknown;
  try {
    try {
      ledgerFd = openSync(resolvedLedger, ACTIVATION_LEDGER_APPEND_OPEN_FLAGS, 0o644);
    } catch (error) {
      // Native ELOOP/filesystem cause retained; no errno dispatch.
      throw new ActivationLedgerError(
        `activation ledger failed to open ledger file (${resolvedLedger}): ${errorText(error)}`,
        { cause: error },
      );
    }

    let opened: ReturnType<typeof fstatSync>;
    try {
      opened = fstatSync(ledgerFd);
    } catch (error) {
      throw new ActivationLedgerError(
        `activation ledger failed to fstat ledger file (${resolvedLedger}): ${errorText(error)}`,
        { cause: error },
      );
    }
    if (!opened.isFile()) {
      throw new ActivationLedgerError(
        `activation ledger is not a regular file: ${resolvedLedger}`,
      );
    }

    const written = writeSync(ledgerFd, bytes, 0, bytes.length, null);
    if (written !== bytes.length) {
      throw new ActivationLedgerError(
        `activation ledger short write: wrote ${written} of ${bytes.length} bytes to ${resolvedLedger}`,
      );
    }
  } catch (error) {
    primaryFailure = error;
  }

  if (ledgerFd !== undefined) {
    try {
      closeSync(ledgerFd);
    } catch (closeFailure) {
      if (primaryFailure !== undefined) {
        throw new AggregateError(
          [primaryFailure, closeFailure],
          "activation ledger operation and close failed",
          { cause: primaryFailure },
        );
      }
      throw closeFailure;
    }
  }

  if (primaryFailure !== undefined) throw primaryFailure;
}

/**
 * Append one complete JSONL record with one O_APPEND write of the full record.
 * Shared-ledger contract: concurrent successful append-only producers cannot
 * overwrite one another. A short write is an honest infrastructure failure
 * (ADR 0049) — no non-append rollback/truncate. Close failure cannot mask the
 * primary write cause; simultaneous close evidence is retained.
 */
export function appendAcceptedActivationFact(
  ledgerPath: string,
  fact: AcceptedActivationFact,
  options: { ledgerHome: string },
): void {
  appendActivationLedgerLine(
    ledgerPath,
    Buffer.from(serializeAcceptedActivationFact(fact), "utf8"),
    { ledgerHome: options.ledgerHome },
  );
}

export function appendAcceptedActivationToBook(options: {
  ledgerHome: string;
  fact: AcceptedActivationFact;
}): void {
  appendAcceptedActivationFact(
    activationWaitingLedgerPath(options.ledgerHome, options.fact.bookKey),
    options.fact,
    { ledgerHome: options.ledgerHome },
  );
}
