import type { HostContext } from "./host-contracts.ts";
import { mintNavigatorInvocationId, NAVIGATOR_INVOCATION_ENTRY } from "./navigator-invocation-identity.ts";
import {
  NavigatorUnavailableError,
  navigatorUnavailableError,
  type NavigatorLookup,
  type NavigatorUnavailableKey,
} from "./navigator-lookup.ts";
import type { PackagedRole } from "./packaged-role-registry.ts";
import { pickPreparedProse, type PreparedNavigatorAdvice } from "./package-contracts/navigator-output.ts";
import { subjectPath } from "./work-subject-identity.ts";

export const NAVIGATOR_EVENT_TYPE = "ak-navigator-attendance" as const;
export { NAVIGATOR_INVOCATION_ENTRY, NavigatorUnavailableError, navigatorUnavailableError };
export type { NavigatorUnavailableKey };

export type NavigatorTargetRole = PackagedRole;
export type NavigatorPhase = "plan" | "apply" | null;
export type NavigatorSettlement =
  | { kind: "accepted"; role: string; phase: NavigatorPhase; status?: string }
  | { kind: "human_decision"; role: string; phase: NavigatorPhase; status: string }
  | { kind: "role_infrastructure_failure"; role: string; phase: NavigatorPhase }
  | { kind: "arrival"; role: "lander"; phase: null; message?: string };

/**
 * #959 / #1192: the navigator speaks the table's own words. Code does not parse,
 * rank, or judge them — only whether the lookup itself failed.
 */
export type NavigatorReport = {
  /** Affirmative attendance only. Lawful no-advice is typed, never inferred from absence. */
  disposition: "advice" | "no-advice" | "unavailable" | "arrival";
  /** Present when disposition is advice — presented as-is. */
  prose?: string;
  unavailableReason?: string;
  unavailableSource?: NavigatorUnavailableKey;
  arrivalMessage?: string;
};

export type NavigatorEvent = {
  version: 1;
  disposition: NavigatorReport["disposition"];
  invocationId: string;
  role: string;
  phase: NavigatorPhase;
  subjectKey: string;
  prose?: string;
  unavailableReason?: string;
  unavailableSource?: NavigatorUnavailableKey;
  arrivalMessage?: string;
};

export type NavigatorAttendanceOptions = {
  context: HostContext;
  role: string;
  phase: NavigatorPhase;
  subjectKey: string;
  lookup: NavigatorLookup;
  /** Exact principal owned by shared role lifecycle; attendance never overrides it. */
  invocationId?: string;
  onEvent: (event: NavigatorEvent, report: NavigatorReport) => void | Promise<void>;
};

export function formatNavigatorReport(report: NavigatorReport): string {
  if (report.disposition === "no-advice") return "";
  if (report.disposition === "unavailable") return report.unavailableReason ?? "";
  if (report.disposition === "arrival") return report.arrivalMessage ?? "";
  return report.prose ?? "";
}

export function createNavigatorAttendance(options: NavigatorAttendanceOptions) {
  const { subjectKey } = options;
  let preparation: Promise<PreparedNavigatorAdvice | undefined> | undefined;
  let preparationInFlight = false;
  /** Looked-up rows: status-keyed prose picked at settle (#1160). */
  let preparedAdvice: PreparedNavigatorAdvice | undefined;
  let preparationFailure: unknown;
  let settlementTail: Promise<void> = Promise.resolve();
  let disposed = false;
  const invocationId = options.invocationId ?? mintNavigatorInvocationId();
  // Shared attendance seam owns nested summon cancel (ADR 0018 / #959).
  const nestCancel = new AbortController();
  const lookupContext = (): HostContext => {
    const parentSignal = options.context.signal;
    const signal = parentSignal === undefined
      ? nestCancel.signal
      : AbortSignal.any([nestCancel.signal, parentSignal]);
    return { ...options.context, signal };
  };

  const unavailable = (reason: unknown): NavigatorReport => {
    const failure = navigatorUnavailableError("unknown", reason);
    return {
      disposition: "unavailable",
      unavailableReason: failure.message,
      unavailableSource: failure.unavailableSource,
    };
  };

  async function settleOnce(settlement: NavigatorSettlement): Promise<void> {
    // Dispose during post-role grace must ignore late completion entirely (#675).
    if (disposed) return;
    let report: NavigatorReport;
    if (settlement.kind === "arrival") {
      // Arrival is presentation-only: never waits for the lookup.
      report = preparationFailure !== undefined
        ? unavailable(preparationFailure)
        : {
            disposition: "arrival",
            ...(settlement.message === undefined ? {} : { arrivalMessage: settlement.message }),
          };
    } else {
      if (preparation !== undefined) {
        try {
          await preparation;
        } catch (error) {
          preparationFailure ??= error;
        }
        preparation = undefined;
      }
      if (preparationFailure !== undefined) {
        // Contract: README.md#Navigator-attendance — failed attendance is typed
        // unavailable without invalidating the role Receipt; retain the cause.
        report = unavailable(preparationFailure);
      } else {
        const status = "status" in settlement ? settlement.status : undefined;
        const picked = pickPreparedProse(preparedAdvice, status);
        // Missing key / no rows → affirmative no-advice; never an invented line.
        report = typeof picked === "string" && picked.trim() !== ""
          ? { disposition: "advice", prose: picked }
          : { disposition: "no-advice" };
      }
    }
    const event: NavigatorEvent = {
      version: 1,
      disposition: report.disposition,
      invocationId,
      role: options.role,
      phase: options.phase,
      subjectKey,
      ...(report.prose === undefined ? {} : { prose: report.prose }),
      ...(report.unavailableReason === undefined ? {} : { unavailableReason: report.unavailableReason }),
      ...(report.unavailableSource === undefined ? {} : { unavailableSource: report.unavailableSource }),
      ...(report.arrivalMessage === undefined ? {} : { arrivalMessage: report.arrivalMessage }),
    };
    if (disposed) return;
    try {
      await options.onEvent(event, report);
    } catch (error) {
      // Race: dispose landed between the check and onEvent; drop only then.
      if (disposed) return;
      throw error;
    }
    preparation = undefined;
    preparedAdvice = undefined;
    preparationFailure = undefined;
  }

  return {
    prepare(): void {
      if (disposed || preparation !== undefined) return;
      preparationFailure = undefined;
      preparedAdvice = undefined;
      preparationInFlight = true;
      preparation = options.lookup({ context: lookupContext(), role: options.role })
        .then((prepared) => {
          preparedAdvice = prepared;
          return prepared;
        })
        .finally(() => { preparationInFlight = false; });
      // Contract: README.md#Navigator-attendance — background lookup rejection is drained so the later typed settlement can report unavailable; the exact cause is retained until settlement.
      void preparation.catch((error) => { preparationFailure = error; });
    },
    isPreparing(): boolean {
      return preparationInFlight;
    },
    settle(settlement: NavigatorSettlement): Promise<void> {
      const next = settlementTail.then(() => settleOnce(settlement));
      // Contract: README.md#Navigator-attendance — rejected attendance settlements are drained only to serialize later attendance; the rejection still reaches the caller.
      settlementTail = next.catch(() => undefined);
      return next;
    },
    dispose(): void {
      disposed = true;
      // Abort the nested lookup summon via the shared signal (ADR 0018 / #959).
      if (!nestCancel.signal.aborted) {
        nestCancel.abort(navigatorUnavailableError("session", new Error("Navigator attendance was disposed")));
      }
    },
  };
}

export type NavigatorAttendance = ReturnType<typeof createNavigatorAttendance>;

export { subjectPath };
