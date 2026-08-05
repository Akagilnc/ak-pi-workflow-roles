import type { AcceptedActivationFact } from "./activation-ledger.ts";

/** Event category for pre-dispatch stub facts (#11 producer contract). */
export const DISPATCH_STUB_EVENT = "dispatch-stub" as const;

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

/** Trusted typed inputs for building the closed dispatch stub (fact minus event discriminant). */
export type DispatchStubFactInput = Omit<DispatchStubFact, "event">;

/**
 * Construct the closed dispatch stub from trusted typed inputs only.
 * Nested dispatch/correlation are rebuilt closed (ADR 0049 zero-content by construction).
 */
export function buildDispatchStubFact(input: DispatchStubFactInput): DispatchStubFact {
  return {
    event: DISPATCH_STUB_EVENT,
    observedAt: input.observedAt,
    bookKey: input.bookKey,
    dispatch: input.dispatch.kind === "process"
      ? { kind: "process", pid: input.dispatch.pid }
      : { kind: "opaque", ref: input.dispatch.ref },
    correlation: { kind: "caller", id: input.correlation.id },
  };
}

/**
 * Truthful process liveness supplied by the consumer.
 * Reconciliation never probes, kills, or retries processes (D1a / #78).
 */
export type ProcessLivenessFact =
  | { readonly state: "alive" }
  | { readonly state: "terminated" };

/**
 * One reconciliation subject as an exclusive complete union (four outcomes only):
 * - activation present → activation required; dispatch/process optional
 * - activation absent → dispatch + truthful process required; activation prohibited
 * No session-file existence oracle (ADR 0047). Untyped JS still hits runtime TypeError.
 */
export type ReconciliationSubject =
  | {
      readonly activation: AcceptedActivationFact;
      readonly dispatch?: DispatchStubFact;
      readonly process?: ProcessLivenessFact;
    }
  | {
      readonly activation?: undefined;
      readonly dispatch: DispatchStubFact;
      readonly process: ProcessLivenessFact;
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
