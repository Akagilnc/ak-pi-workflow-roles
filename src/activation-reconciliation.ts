import type { AcceptedActivationFact } from "./activation-ledger.ts";

/** Event category for pre-dispatch stub facts (#11 producer contract). */
export const DISPATCH_STUB_EVENT = "dispatch-stub" as const;

/**
 * Package-owned index-only top-level keys for dispatch-stub facts (ADR 0049).
 * Sole machine key contract for the #78↔#11 typed producer seam — not a JSONL
 * line schema and not a validator.
 */
export const DISPATCH_STUB_FACT_KEYS = Object.freeze([
  "event",
  "observedAt",
  "bookKey",
  "dispatch",
  "correlation",
] as const);

export type DispatchStubFactKey = (typeof DISPATCH_STUB_FACT_KEYS)[number];

/**
 * Non-content dispatch pointer. Carries process identity or an opaque ref —
 * never prompt/argv/content bytes (ADR 0049).
 */
export type DispatchPointer =
  | { readonly kind: "process"; readonly pid: number }
  | { readonly kind: "opaque"; readonly ref: string };

/**
 * Minimum typed dispatch stub the #11 producer supplies before ignition.
 * Index-only: correlation, book, time, event category, non-content pointer.
 */
export type DispatchStubFact = {
  readonly event: typeof DISPATCH_STUB_EVENT;
  readonly observedAt: string;
  readonly bookKey: string;
  readonly dispatch: DispatchPointer;
  readonly correlation: { readonly kind: "caller"; readonly id: string };
};

// Keys tuple ↔ fact type must stay exact (compile fail on drift).
type ExactKeyMatch<T, K extends PropertyKey> =
  Exclude<keyof T, K> | Exclude<K, keyof T> extends never ? true : never;
const _dispatchStubFactKeysMatch: ExactKeyMatch<DispatchStubFact, DispatchStubFactKey> = true;
void _dispatchStubFactKeysMatch;

/** Trusted typed inputs for building the closed dispatch stub (fact minus event discriminant). */
export type DispatchStubFactInput = Omit<DispatchStubFact, "event">;

/**
 * Descriptor-driven top-level pick: only DISPATCH_STUB_FACT_KEYS leave this boundary.
 * Nested dispatch/correlation are rebuilt closed (ADR 0049 zero-content by construction).
 */
function projectDispatchStubFact(input: DispatchStubFactInput): DispatchStubFact {
  const closed: DispatchStubFact = {
    event: DISPATCH_STUB_EVENT,
    observedAt: input.observedAt,
    bookKey: input.bookKey,
    dispatch: input.dispatch.kind === "process"
      ? { kind: "process", pid: input.dispatch.pid }
      : { kind: "opaque", ref: input.dispatch.ref },
    correlation: { kind: "caller", id: input.correlation.id },
  };
  return Object.fromEntries(
    DISPATCH_STUB_FACT_KEYS.map((key) => [key, closed[key]]),
  ) as DispatchStubFact;
}

/** Construct the closed dispatch stub from trusted typed inputs only. */
export function buildDispatchStubFact(input: DispatchStubFactInput): DispatchStubFact {
  return projectDispatchStubFact(input);
}

/**
 * Truthful process liveness supplied by the consumer.
 * Reconciliation never probes, kills, or retries processes (D1a / #78).
 */
export type ProcessLivenessFact =
  | { readonly state: "alive" }
  | { readonly state: "terminated" };

/**
 * One reconciliation subject: typed dispatch and/or activation facts plus
 * consumer-supplied process liveness. No session-file existence oracle (ADR 0047).
 */
export type ReconciliationSubject = {
  readonly dispatch?: DispatchStubFact;
  readonly activation?: AcceptedActivationFact;
  readonly process?: ProcessLivenessFact;
};

/**
 * Exactly four typed outcomes (D1a):
 * - matched — dispatch stub and matching accepted-activation fact
 * - pending — dispatch present, no activation, process still alive
 * - ghost — dispatch present, no activation, process terminated
 * - activation-without-dispatch — activation fact with no matching stub
 */
export type ReconciliationOutcome =
  | {
      readonly kind: "matched";
      readonly correlationId: string;
      readonly bookKey: string;
    }
  | {
      readonly kind: "pending";
      readonly correlationId: string;
      readonly bookKey: string;
    }
  | {
      readonly kind: "ghost";
      readonly correlationId: string;
      readonly bookKey: string;
    }
  | {
      readonly kind: "activation-without-dispatch";
      readonly correlationId: string | undefined;
      readonly bookKey: string;
    };

function callerCorrelationId(
  correlation: AcceptedActivationFact["correlation"] | DispatchStubFact["correlation"],
): string | undefined {
  return correlation.kind === "caller" ? correlation.id : undefined;
}

function dispatchMatchesActivation(
  dispatch: DispatchStubFact,
  activation: AcceptedActivationFact,
): boolean {
  const activationId = callerCorrelationId(activation.correlation);
  return (
    activationId !== undefined
    && activationId === dispatch.correlation.id
    && activation.bookKey === dispatch.bookKey
  );
}

/**
 * Reconcile one invocation's typed dispatch/activation facts against truthful
 * process liveness. Pure: never kills, never retries, never reads session files.
 */
export function reconcileInvocation(subject: ReconciliationSubject): ReconciliationOutcome {
  const { dispatch, activation, process } = subject;

  if (activation !== undefined) {
    if (dispatch !== undefined && dispatchMatchesActivation(dispatch, activation)) {
      return {
        kind: "matched",
        correlationId: dispatch.correlation.id,
        bookKey: dispatch.bookKey,
      };
    }
    return {
      kind: "activation-without-dispatch",
      correlationId: callerCorrelationId(activation.correlation),
      bookKey: activation.bookKey,
    };
  }

  if (dispatch !== undefined) {
    if (process === undefined) {
      throw new TypeError(
        "reconcileInvocation requires process liveness when activation is absent",
      );
    }
    if (process.state === "alive") {
      return {
        kind: "pending",
        correlationId: dispatch.correlation.id,
        bookKey: dispatch.bookKey,
      };
    }
    return {
      kind: "ghost",
      correlationId: dispatch.correlation.id,
      bookKey: dispatch.bookKey,
    };
  }

  throw new TypeError(
    "reconcileInvocation requires a dispatch stub and/or an accepted-activation fact",
  );
}
