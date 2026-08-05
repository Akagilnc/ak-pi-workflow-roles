/**
 * Pure typecheck fixture for ReconciliationSubject exclusive complete union.
 * Not registered as a runtime test — tsc include covers it.
 */
import type { AcceptedActivationFact } from "../../src/activation-ledger.ts";
import type {
  DispatchStubFact,
  ProcessLivenessFact,
  ReconciliationSubject,
} from "../../src/activation-reconciliation.ts";

declare const activation: AcceptedActivationFact;
declare const dispatch: DispatchStubFact;
declare const processLiveness: ProcessLivenessFact;

// Legal complete subjects for the closed four-outcome contract.
const activationOnly: ReconciliationSubject = { activation };
const matched: ReconciliationSubject = {
  activation,
  dispatch,
  process: processLiveness,
};
const pending: ReconciliationSubject = {
  dispatch,
  process: processLiveness,
};
const ghost: ReconciliationSubject = {
  dispatch,
  process: { state: "terminated" },
};
// Activation + non-joining dispatch remains a legal typed input (runtime anomaly).
const mismatchAnomaly: ReconciliationSubject = { activation, dispatch };

// @ts-expect-error empty subject is incomplete — neither union branch accepts {}
const emptySubject: ReconciliationSubject = {};
// @ts-expect-error activation-absent branch requires truthful process with dispatch
const dispatchOnly: ReconciliationSubject = { dispatch };

void [
  activationOnly,
  matched,
  pending,
  ghost,
  mismatchAnomaly,
  emptySubject,
  dispatchOnly,
];
