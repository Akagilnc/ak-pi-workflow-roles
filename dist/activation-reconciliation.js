const DISPATCH_STUB_EVENT = "dispatch-stub";
const DISPATCH_STUB_FACT_KEYS = Object.freeze([
  "event",
  "observedAt",
  "bookKey",
  "dispatch",
  "correlation"
]);
const _dispatchStubFactKeysMatch = true;
void _dispatchStubFactKeysMatch;
function projectDispatchStubFact(input) {
  const closed = {
    event: DISPATCH_STUB_EVENT,
    observedAt: input.observedAt,
    bookKey: input.bookKey,
    dispatch: input.dispatch.kind === "process" ? { kind: "process", pid: input.dispatch.pid } : { kind: "opaque", ref: input.dispatch.ref },
    correlation: { kind: "caller", id: input.correlation.id }
  };
  return Object.fromEntries(
    DISPATCH_STUB_FACT_KEYS.map((key) => [key, closed[key]])
  );
}
function buildDispatchStubFact(input) {
  return projectDispatchStubFact(input);
}
function callerCorrelationId(correlation) {
  return correlation.kind === "caller" ? correlation.id : void 0;
}
function dispatchMatchesActivation(dispatch, activation) {
  const activationId = callerCorrelationId(activation.correlation);
  return activationId !== void 0 && activationId === dispatch.correlation.id && activation.bookKey === dispatch.bookKey;
}
function reconcileInvocation(subject) {
  const { dispatch, activation, process } = subject;
  if (activation !== void 0) {
    if (dispatch !== void 0 && dispatchMatchesActivation(dispatch, activation)) {
      return {
        kind: "matched",
        correlationId: dispatch.correlation.id,
        bookKey: dispatch.bookKey
      };
    }
    return {
      kind: "activation-without-dispatch",
      correlationId: callerCorrelationId(activation.correlation),
      bookKey: activation.bookKey
    };
  }
  if (dispatch !== void 0) {
    if (process === void 0) {
      throw new TypeError(
        "reconcileInvocation requires process liveness when activation is absent"
      );
    }
    if (process.state === "alive") {
      return {
        kind: "pending",
        correlationId: dispatch.correlation.id,
        bookKey: dispatch.bookKey
      };
    }
    return {
      kind: "ghost",
      correlationId: dispatch.correlation.id,
      bookKey: dispatch.bookKey
    };
  }
  throw new TypeError(
    "reconcileInvocation requires a dispatch stub and/or an accepted-activation fact"
  );
}
export {
  DISPATCH_STUB_EVENT,
  DISPATCH_STUB_FACT_KEYS,
  buildDispatchStubFact,
  reconcileInvocation
};
